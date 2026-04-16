// Detects whether the `claude` CLI is installed + reachable so workflow
// agents can use the operator's normal Claude Code sign-in. No
// ANTHROPIC_API_KEY is involved — DCM drives the CLI directly.
//
// Result is cached briefly so repeated UI polls don't spawn `claude
// --version` on every page render.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";

// Overridable runner so tests can inject canned outcomes (vitest can't spy
// ESM namespace exports directly; vi.mock("node:child_process") also breaks
// other tests that touch it). Returns the same shape spawnSync does.
export type VersionProbe = () => SpawnSyncReturns<string> | { error: NodeJS.ErrnoException };
let _probe: VersionProbe = () =>
  spawnSync("claude", ["--version"], {
    encoding: "utf8",
    timeout: 3_000,
    stdio: ["ignore", "pipe", "pipe"],
  });

export function _setVersionProbeForTests(p: VersionProbe | null): void {
  _probe = p ?? (() =>
    spawnSync("claude", ["--version"], {
      encoding: "utf8",
      timeout: 3_000,
      stdio: ["ignore", "pipe", "pipe"],
    }));
}

export type AuthProvider = "claude-cli" | "none";

export interface AnthropicAuthStatus {
  configured: boolean;
  provider: AuthProvider;
  cli_version: string | null;
  error: string | null;
}

const CACHE_TTL_MS = 5_000;
let cache: { at: number; status: AnthropicAuthStatus } | null = null;

function resolveClaudeCliStatus(): AnthropicAuthStatus {
  try {
    const res = _probe() as SpawnSyncReturns<string>;
    if (res.error) {
      const err = res.error as NodeJS.ErrnoException;
      return {
        configured: false,
        provider: "none",
        cli_version: null,
        error:
          err.code === "ENOENT"
            ? "`claude` CLI not found on PATH. Install Claude Code and run `claude login`."
            : err.message,
      };
    }
    if (res.status !== 0) {
      return {
        configured: false,
        provider: "none",
        cli_version: null,
        error: ((res.stderr as string) || `claude exited ${res.status}`).trim().slice(0, 200),
      };
    }
    return {
      configured: true,
      provider: "claude-cli",
      cli_version: (res.stdout as string).trim().slice(0, 200),
      error: null,
    };
  } catch (e) {
    return {
      configured: false,
      provider: "none",
      cli_version: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export function anthropicAuthStatus(): AnthropicAuthStatus {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.status;
  const status = resolveClaudeCliStatus();
  cache = { at: now, status };
  return status;
}

export function _clearAuthCacheForTests(): void {
  cache = null;
}
