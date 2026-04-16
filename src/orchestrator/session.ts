import path from "node:path";
import { realpathSync } from "node:fs";
import type { Role } from "./roles";
import { buildSystemPrompt } from "./roles";
import { roleConfig } from "./role-config";
import { getSdkQuery } from "./sdk-adapter";
import { ALLOWED_MODELS, DEFAULT_MODEL } from "@/lib/workflows";
import type { WorkflowRecord } from "@/lib/workflows";

export interface SessionInput {
  role: Role;
  workflow: WorkflowRecord;
  task: string;
  // If set, resumes the SDK session with this id instead of starting fresh.
  resume?: string;
  // Override working directory. Defaults to workflow.workspace_path.
  cwdOverride?: string;
}

export interface ToolUseRecord {
  name: string;
  input: unknown;
}

export interface SessionOutput {
  // Session id assigned by the SDK, or "" on hard failure.
  session_id: string;
  // Concatenated assistant text across all turns, with empty text blocks
  // dropped. Used by the orchestrator for status-line parsing.
  text: string;
  tool_uses: ToolUseRecord[];
  // From the final `result` message; 0 when the session never produced one.
  total_cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  num_turns: number;
  // Non-null on failure: SDK error, hook deny, or our post-check violation.
  error: string | null;
  // If role is text-only and the SDK returned a tool_use anyway (the hook
  // should prevent this, but we post-check as a belt-and-braces defense).
  textOnlyViolated: boolean;
}

// Shape we expect from the SDK stream. Expressed loosely to avoid coupling to
// a specific SDK minor version.
interface SdkMessageLike {
  type: string;
  message?: { content?: unknown };
  subtype?: string;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  num_turns?: number;
  session_id?: string;
  result?: string;
}

function isTextBlock(block: unknown): block is { type: "text"; text: string } {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
  );
}

function isToolUseBlock(block: unknown): block is { type: "tool_use"; name: string; input: unknown } {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "tool_use" &&
    typeof (block as { name?: unknown }).name === "string"
  );
}

// Resolves a tool-input file path against the workspace root. Returns null if
// the path either isn't present or doesn't look like a string.
function extractFilePath(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const fp = (input as { file_path?: unknown }).file_path;
  return typeof fp === "string" ? fp : null;
}

export interface WorkspaceGuardOptions {
  workspaceRoot: string;
}

// Resolves any symlinks present in the path's parent chain so the caller can
// test the real destination against the workspace root. Written-but-not-yet-
// created leaf paths are handled by walking up until a real directory exists.
function realResolvedAncestor(p: string): string {
  let current = p;
  // Walk up until we find an existing node we can realpath-resolve. Missing
  // leaves/intermediate dirs fall back to path.resolve of the highest-known
  // ancestor joined with the remaining components.
  while (current.length > 1) {
    try {
      const resolved = realpathSync.native(current);
      // Rejoin any suffix we peeled off.
      const suffix = path.relative(current, p);
      return path.resolve(resolved, suffix);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return path.resolve(p);
}

// Hook body shared between the SDK hook registration and the textOnly
// post-check. Takes a tool name + input and returns either null (allow) or a
// string (deny reason). Uses realpath on the parent chain to defeat symlink
// traversal inside the workspace.
export function evaluateWorkspaceGuard(
  toolName: string,
  toolInput: unknown,
  opts: WorkspaceGuardOptions
): string | null {
  if (toolName !== "Write" && toolName !== "Edit") return null;
  const fp = extractFilePath(toolInput);
  if (fp === null) return null;
  if (fp.indexOf("\0") !== -1) return `${toolName} path contains null byte`;

  const root = realResolvedAncestor(path.resolve(opts.workspaceRoot));
  const candidate = path.resolve(root, fp);
  const resolved = realResolvedAncestor(candidate);

  if (resolved === root) return null;
  if (resolved.startsWith(root + path.sep)) return null;
  return `${toolName} ${fp} is outside workflow workspace ${opts.workspaceRoot}`;
}

// Validates the model name read from the DB against ALLOWED_MODELS. Prevents a
// tampered/drifted row from pushing a bogus model name to the SDK.
function safeModel(name: string): string {
  return (ALLOWED_MODELS as readonly string[]).includes(name) ? name : DEFAULT_MODEL;
}

// Builds the options blob we pass to the SDK's `query()`. We keep this typed
// as unknown externally so tests don't need to import SDK types.
export function buildSdkOptions(input: SessionInput): Record<string, unknown> {
  const cfg = roleConfig(input.role);
  const systemPrompt = buildSystemPrompt({ role: input.role });
  const cwd = input.cwdOverride ?? input.workflow.workspace_path;

  const workspaceRoot = input.workflow.workspace_path;

  const options: Record<string, unknown> = {
    systemPrompt,
    allowedTools: cfg.allowedTools,
    permissionMode: cfg.permissionMode,
    cwd,
    model: safeModel(input.workflow.model),
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (hookInput: unknown) => {
              const pre = hookInput as {
                tool_name?: string;
                tool_input?: unknown;
              };
              if (!pre.tool_name) return {};
              // Text-only roles (sys-design) must never call tools. We use
              // allowedTools: [] as the primary defense and this hook as
              // belt-and-braces against SDK drift.
              if (cfg.textOnly) {
                return {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "deny",
                    permissionDecisionReason: `role ${input.role} is text-only; tool '${pre.tool_name}' blocked`,
                  },
                };
              }
              const reason = evaluateWorkspaceGuard(pre.tool_name, pre.tool_input, {
                workspaceRoot,
              });
              if (reason) {
                return {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "deny",
                    permissionDecisionReason: reason,
                  },
                };
              }
              return {};
            },
          ],
        },
      ],
    },
  };
  if (input.resume) options.resume = input.resume;
  return options;
}

// Runs one agent turn — a single query() invocation that may span multiple
// assistant messages and tool uses but ends when the SDK emits `result`.
export async function runAgent(input: SessionInput): Promise<SessionOutput> {
  const cfg = roleConfig(input.role);
  const out: SessionOutput = {
    session_id: "",
    text: "",
    tool_uses: [],
    total_cost_usd: 0,
    input_tokens: 0,
    output_tokens: 0,
    num_turns: 0,
    error: null,
    textOnlyViolated: false,
  };

  const queryFn = getSdkQuery();
  const options = buildSdkOptions(input);

  try {
    const stream = queryFn({ prompt: input.task, options: options as never });
    for await (const msg of stream as AsyncIterable<SdkMessageLike>) {
      if (msg.type === "assistant") {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (isTextBlock(block)) {
              out.text += (out.text.length > 0 ? "\n" : "") + block.text;
            } else if (isToolUseBlock(block)) {
              out.tool_uses.push({ name: block.name, input: block.input });
              if (cfg.textOnly) {
                out.textOnlyViolated = true;
              }
            }
          }
        }
      } else if (msg.type === "result") {
        out.total_cost_usd = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : 0;
        out.input_tokens = msg.usage?.input_tokens ?? 0;
        out.output_tokens = msg.usage?.output_tokens ?? 0;
        out.num_turns = msg.num_turns ?? 0;
        out.session_id = msg.session_id ?? "";
        if (msg.subtype && msg.subtype !== "success") {
          out.error = `SDK result subtype: ${msg.subtype}`;
        }
      } else if (msg.type === "error") {
        const errResult = (msg as unknown as { result?: string }).result;
        out.error = `SDK error: ${errResult ?? "unknown"}`;
      }
    }
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
  }

  return out;
}
