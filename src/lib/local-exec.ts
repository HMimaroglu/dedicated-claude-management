import { spawn } from "node:child_process";
import os from "node:os";
import { promises as fs } from "node:fs";
import type { ProbeResult } from "./hosts";
import { shQuote } from "./projects";

// Runs a shell command on the controller's local machine. Used for the
// "controller" host — projects with host_id=null. All arguments are passed as
// a single /bin/sh string, so callers MUST shQuote anything user-supplied.
// Returns exit code + stdout + stderr (no streaming; we wait for completion).

export interface LocalExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface LocalExecOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export async function execLocal(
  command: string,
  opts: LocalExecOptions = {}
): Promise<LocalExecResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  return new Promise<LocalExecResult>((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve({ stdout, stderr: stderr + `\n[local exec timeout ${timeoutMs}ms]`, code: null });
    }, timeoutMs);
    child.stdout?.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + String(err), code: null });
    });
  });
}

// --- Local probe for the controller host. Returns the same shape as
// ssh.ts's probeHost so the caller can store it uniformly. ---

export async function probeLocal(): Promise<ProbeResult> {
  const start = Date.now();
  try {
    const totalMb = Math.round(os.totalmem() / (1024 * 1024));
    const freeMb = Math.round(os.freemem() / (1024 * 1024));
    const usedMb = Math.max(0, totalMb - freeMb);
    const load = os.loadavg()[0] ?? 0;

    // df -P on the workspace root; fall back to / if that fails.
    let diskPct: number | null = null;
    try {
      const df = await execLocal(`df -P ${shQuote(process.cwd())}`, { timeoutMs: 3_000 });
      const row = df.stdout.split(/\r?\n/).find((l) => /\s\d{1,3}%\s/.test(l));
      if (row) {
        const m = row.match(/\s(\d{1,3})%\s/);
        if (m && m[1]) diskPct = parseInt(m[1], 10);
      }
    } catch {
      // ignore
    }

    return {
      success: true,
      latency_ms: Date.now() - start,
      error: null,
      cpu_load_1m: load,
      mem_total_mb: totalMb,
      mem_used_mb: usedMb,
      disk_used_pct: diskPct,
      gpu_info: null,
    };
  } catch (e) {
    return {
      success: false,
      latency_ms: Date.now() - start,
      error: e instanceof Error ? e.message : String(e),
      cpu_load_1m: null,
      mem_total_mb: null,
      mem_used_mb: null,
      disk_used_pct: null,
      gpu_info: null,
    };
  }
}

// --- Local tmux control for instances on the controller. ---

export async function tmuxHasSessionLocal(session: string): Promise<boolean> {
  const r = await execLocal(`tmux has-session -t ${shQuote(session)} 2>/dev/null`, {
    timeoutMs: 3_000,
  });
  return r.code === 0;
}

export interface LocalSpawnOpts {
  session: string;
  projectPath: string;
  instanceName: string;
  extraClaudeArgs?: string[];
}

export interface LocalSpawnResult {
  success: boolean;
  stderr: string;
  error: string | null;
  pid: number | null;
}

export async function spawnLocalTmux(opts: LocalSpawnOpts): Promise<LocalSpawnResult> {
  // Ensure the project path exists; else tmux will error with a useless msg.
  try {
    await fs.stat(opts.projectPath);
  } catch {
    return {
      success: false,
      stderr: "",
      error: `project path ${opts.projectPath} does not exist on controller`,
      pid: null,
    };
  }

  const extra = (opts.extraClaudeArgs ?? []).map(shQuote).join(" ");
  // `claude remote-control` uses --permission-mode bypassPermissions, not
  // the --dangerously-skip-permissions flag which is for plain `claude`.
  // --spawn same-dir skips the interactive first-run prompt that would
  // otherwise block the session on stdin.
  const inner = `exec claude remote-control --permission-mode bypassPermissions --spawn same-dir --name ${shQuote(opts.instanceName)} ${extra}`.trim();
  // Kill any pre-existing session with the same name (belt-and-braces).
  const cmd =
    `tmux kill-session -t ${shQuote(opts.session)} 2>/dev/null; ` +
    `cd ${shQuote(opts.projectPath)} && tmux new-session -d -s ${shQuote(opts.session)} ${shQuote(inner)}`;
  const r = await execLocal(cmd, { timeoutMs: 15_000 });
  if (r.code !== 0) {
    const err = (r.stderr || r.stdout || `tmux new-session exited ${r.code}`).slice(0, 512);
    return { success: false, stderr: r.stderr, error: err, pid: null };
  }

  // Verify + capture pid.
  const check = await execLocal(`tmux has-session -t ${shQuote(opts.session)}`);
  if (check.code !== 0) {
    return {
      success: false,
      stderr: check.stderr,
      error: "tmux session not found after spawn (claude may have exited immediately)",
      pid: null,
    };
  }
  const pidRes = await execLocal(
    `tmux list-panes -t ${shQuote(opts.session)} -F '#{pane_pid}' | head -n1`
  );
  const parsed = parseInt(pidRes.stdout.trim(), 10);
  const pid = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  return { success: true, stderr: r.stderr, error: null, pid };
}

export async function killLocalTmux(session: string): Promise<{ ok: boolean; error: string | null }> {
  const res = await execLocal(`tmux kill-session -t ${shQuote(session)}`);
  const check = await execLocal(
    `tmux has-session -t ${shQuote(session)} 2>/dev/null && echo ALIVE || echo GONE`
  );
  if (/GONE/.test(check.stdout)) {
    return { ok: true, error: null };
  }
  const err = `kill reported code=${res.code}; tmux session still present`;
  return { ok: false, error: err };
}

export async function signalLocal(
  session: string,
  signal: "STOP" | "CONT"
): Promise<{ ok: boolean; error: string | null }> {
  const cmd =
    `PID=$(tmux list-panes -t ${shQuote(session)} -F '#{pane_pid}' 2>/dev/null | head -n1); ` +
    `if [ -z "$PID" ]; then echo NOSESSION >&2; exit 2; fi; kill -${signal} "$PID"`;
  const r = await execLocal(cmd, { timeoutMs: 5_000 });
  if (r.code !== 0) {
    return { ok: false, error: (r.stderr || `signal exited ${r.code}`).slice(0, 200) };
  }
  return { ok: true, error: null };
}

export async function isTmuxAvailable(): Promise<boolean> {
  const r = await execLocal("command -v tmux", { timeoutMs: 2_000 });
  return r.code === 0 && r.stdout.trim().length > 0;
}

// For display.
export const LOCAL_HOST_LABEL = "Local (controller)";

export function localHostAddress(): string {
  return `localhost:${os.hostname()}`;
}
