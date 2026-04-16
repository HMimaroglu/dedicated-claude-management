import { afterEach, describe, expect, it } from "vitest";
import type { SpawnSyncReturns } from "node:child_process";
import {
  _clearAuthCacheForTests,
  _setVersionProbeForTests,
  anthropicAuthStatus,
} from "../src/lib/anthropic-auth";

afterEach(() => {
  _setVersionProbeForTests(null);
  _clearAuthCacheForTests();
});

function probeResult(value: Partial<SpawnSyncReturns<string>>): SpawnSyncReturns<string> {
  return {
    pid: 1,
    output: [],
    signal: null,
    stderr: "",
    stdout: "",
    status: null,
    ...value,
  } as SpawnSyncReturns<string>;
}

describe("anthropicAuthStatus (Claude CLI detection)", () => {
  it("reports configured=true with version when `claude --version` succeeds", () => {
    _setVersionProbeForTests(() =>
      probeResult({ status: 0, stdout: "1.2.3 (claude-code)\n" })
    );
    const s = anthropicAuthStatus();
    expect(s.configured).toBe(true);
    expect(s.provider).toBe("claude-cli");
    expect(s.cli_version).toContain("1.2.3");
    expect(s.error).toBeNull();
  });

  it("reports configured=false with helpful error when CLI is missing (ENOENT)", () => {
    const err: NodeJS.ErrnoException = new Error("spawn claude ENOENT");
    err.code = "ENOENT";
    _setVersionProbeForTests(() => probeResult({ error: err }));
    const s = anthropicAuthStatus();
    expect(s.configured).toBe(false);
    expect(s.provider).toBe("none");
    expect(s.error).toMatch(/not found on PATH/);
  });

  it("reports configured=false when CLI exits non-zero", () => {
    _setVersionProbeForTests(() => probeResult({ status: 1, stderr: "not logged in\n" }));
    const s = anthropicAuthStatus();
    expect(s.configured).toBe(false);
    expect(s.error).toContain("not logged in");
  });

  it("caches the result for subsequent calls within the TTL", () => {
    let calls = 0;
    _setVersionProbeForTests(() => {
      calls += 1;
      return probeResult({ status: 0, stdout: "2.0.0\n" });
    });
    anthropicAuthStatus();
    anthropicAuthStatus();
    anthropicAuthStatus();
    expect(calls).toBe(1);
  });
});
