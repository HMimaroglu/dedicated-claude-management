import { spawn } from "node:child_process";

// Drives agent turns via the local `claude` CLI (`claude --print
// --output-format stream-json`) so authentication uses the operator's
// existing Claude Code sign-in — no ANTHROPIC_API_KEY required. The NDJSON
// stream matches the shape session.ts expects (assistant messages with a
// content array, plus a final `result` with total_cost_usd + usage).

export interface CliQueryOptions {
  prompt: string;
  options: {
    systemPrompt?: string;
    allowedTools?: string[];
    disallowedTools?: string[];
    permissionMode?: string;
    cwd?: string;
    model?: string;
    resume?: string;
    // hooks from the SDK path are ignored here — CLI doesn't accept them at
    // the flag layer. Workspace write scoping is enforced via the
    // allowedTools list (sys-design: [], auditor: Read/Glob/Grep only).
    hooks?: unknown;
  };
}

export interface StreamMessage {
  type: string;
  [key: string]: unknown;
}

// Strip common ANSI sequences that the CLI sometimes includes in stderr.
function sanitizeErr(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").slice(0, 1000);
}

function buildClaudeArgs(input: CliQueryOptions): string[] {
  const args: string[] = ["--print", "--output-format", "stream-json", "--verbose"];
  const o = input.options;
  if (o.model) args.push("--model", o.model);
  if (o.systemPrompt) args.push("--append-system-prompt", o.systemPrompt);
  if (o.permissionMode && o.permissionMode !== "default") {
    args.push("--permission-mode", o.permissionMode);
  }
  if (o.allowedTools) {
    // Empty list means "no tools" — we still pass the flag so the CLI
    // doesn't fall back to defaults.
    args.push("--allowed-tools", o.allowedTools.join(","));
  }
  if (o.disallowedTools && o.disallowedTools.length > 0) {
    args.push("--disallowed-tools", o.disallowedTools.join(","));
  }
  if (o.resume) args.push("--resume", o.resume);
  // Prompt last so everything above is a flag.
  args.push(input.prompt);
  return args;
}

export async function* claudeCliQuery(
  input: CliQueryOptions
): AsyncIterable<StreamMessage> {
  const args = buildClaudeArgs(input);
  const cwd = input.options.cwd ?? process.cwd();

  const child = spawn("claude", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  let stderr = "";
  child.stderr.on("data", (d: Buffer) => {
    stderr += d.toString("utf8");
  });

  const queue: StreamMessage[] = [];
  let notify: (() => void) | null = null;
  const waitForMore = () =>
    new Promise<void>((resolve) => {
      notify = () => {
        notify = null;
        resolve();
      };
    });

  let buf = "";
  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as StreamMessage;
        queue.push(parsed);
        if (notify) notify();
      } catch {
        // non-JSON banner lines are ignored
      }
    }
  });

  let closed = false;
  let spawnError: Error | null = null;
  let exitCode: number | null = null;

  child.on("close", (code) => {
    exitCode = code;
    closed = true;
    if (notify) notify();
  });
  child.on("error", (err) => {
    spawnError = err;
    closed = true;
    if (notify) notify();
  });

  while (true) {
    while (queue.length > 0) {
      yield queue.shift()!;
    }
    if (closed) break;
    await waitForMore();
  }

  const err = spawnError as Error | null;
  if (err) {
    yield {
      type: "result",
      subtype: "error_spawn",
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      num_turns: 0,
      session_id: "",
      result: `claude CLI spawn failed: ${err.message}. Is the 'claude' CLI installed and on PATH?`,
    };
    return;
  }
  if (exitCode !== null && exitCode !== 0) {
    // If the CLI already emitted a `result` message we stayed silent here,
    // but most nonzero exits without a result are auth/runtime errors.
    yield {
      type: "result",
      subtype: "error_exit",
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      num_turns: 0,
      session_id: "",
      result: `claude CLI exited ${exitCode}: ${sanitizeErr(stderr) || "(no stderr)"}`,
    };
  }
}

// Expose for unit tests that want to assert the constructed argv.
export const _buildClaudeArgsForTesting = buildClaudeArgs;
