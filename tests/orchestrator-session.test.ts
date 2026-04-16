import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb, type Db } from "../src/lib/db";
import { _setKeyForTests } from "../src/lib/crypto";
import { createHost } from "../src/lib/hosts";
import { createProject } from "../src/lib/projects";
import { createWorkflow, type WorkflowRecord } from "../src/lib/workflows";
import { buildSdkOptions, evaluateWorkspaceGuard, runAgent } from "../src/orchestrator/session";
import { roleConfig } from "../src/orchestrator/role-config";
import { setSdkQueryForTesting } from "../src/orchestrator/sdk-adapter";

let db: Db;
let tmpRoot: string;
const { privateKey } = crypto.generateKeyPairSync("ed25519");
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

beforeEach(() => {
  _setKeyForTests(crypto.randomBytes(32));
  db = createDb(":memory:");
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "dcm-sess-test-"));
  process.env.DCM_WORKFLOWS_DIR = tmpRoot;
});
afterEach(() => {
  _setKeyForTests(null);
  db.close();
  delete process.env.DCM_WORKFLOWS_DIR;
  rmSync(tmpRoot, { recursive: true, force: true });
  setSdkQueryForTesting(null);
  vi.restoreAllMocks();
});

function mkWorkflow(): WorkflowRecord {
  const host = createHost(
    { name: "h", address: "a", ssh_user: "u", auth_method: "privkey", privkey: PEM },
    db
  );
  const proj = createProject(
    { name: "p", source_type: "local", host_id: host.id, path_on_host: "/home/u/p" },
    db
  );
  return createWorkflow(
    { project_id: proj.id, name: "w", idea: "build a thing please" },
    db
  );
}

describe("roleConfig", () => {
  it("sys-design is text-only, plan mode", () => {
    const c = roleConfig("sd1");
    expect(c.allowedTools).toEqual([]);
    expect(c.textOnly).toBe(true);
    expect(c.permissionMode).toBe("plan");
  });
  it("research gets read + web tools", () => {
    const c = roleConfig("r1");
    expect(c.allowedTools).toContain("WebSearch");
    expect(c.allowedTools).toContain("Read");
    expect(c.textOnly).toBe(false);
  });
  it("auditor is read-only", () => {
    const c = roleConfig("a1");
    expect(c.allowedTools).not.toContain("Write");
    expect(c.allowedTools).not.toContain("Edit");
    expect(c.allowedTools).not.toContain("Bash");
  });
  it("dev has write but no Bash (security cut)", () => {
    const c = roleConfig("d1");
    expect(c.allowedTools).toContain("Write");
    expect(c.allowedTools).toContain("Edit");
    expect(c.allowedTools).not.toContain("Bash");
  });
});

describe("evaluateWorkspaceGuard", () => {
  it("allows writes inside a real workspace dir", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "dcm-guard-"));
    try {
      expect(
        evaluateWorkspaceGuard(
          "Write",
          { file_path: path.join(root, "x.md") },
          { workspaceRoot: root }
        )
      ).toBeNull();
      expect(
        evaluateWorkspaceGuard(
          "Write",
          { file_path: path.join(root, "sub/y.md") },
          { workspaceRoot: root }
        )
      ).toBeNull();
    } finally {
      rmSync(root, { recursive: true });
    }
  });
  it("denies writes outside the workspace", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "dcm-guard-"));
    try {
      expect(
        evaluateWorkspaceGuard(
          "Write",
          { file_path: "/tmp/other/x.md" },
          { workspaceRoot: root }
        )
      ).toMatch(/outside/);
      expect(
        evaluateWorkspaceGuard(
          "Write",
          { file_path: path.join(root, "../other/x.md") },
          { workspaceRoot: root }
        )
      ).toMatch(/outside/);
    } finally {
      rmSync(root, { recursive: true });
    }
  });
  it("denies symlink-escape when a symlink in the workspace points outside", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "dcm-sym-"));
    const outside = mkdtempSync(path.join(os.tmpdir(), "dcm-outside-"));
    try {
      symlinkSync(outside, path.join(root, "escape"));
      const res = evaluateWorkspaceGuard(
        "Write",
        { file_path: path.join(root, "escape", "evil.md") },
        { workspaceRoot: root }
      );
      expect(res).toMatch(/outside/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
  it("denies null byte in file_path", () => {
    expect(
      evaluateWorkspaceGuard(
        "Write",
        { file_path: "/tmp/wf/x\0.md" },
        { workspaceRoot: "/tmp/wf" }
      )
    ).toMatch(/null byte/);
  });
  it("ignores tools we don't guard", () => {
    expect(
      evaluateWorkspaceGuard(
        "Read",
        { file_path: "/etc/passwd" },
        { workspaceRoot: "/tmp/wf" }
      )
    ).toBeNull();
  });
  it("skips when file_path is absent", () => {
    expect(evaluateWorkspaceGuard("Write", {}, { workspaceRoot: "/tmp/wf" })).toBeNull();
  });
});

describe("buildSdkOptions", () => {
  it("wires role config + system prompt + workspace cwd", () => {
    const wf = mkWorkflow();
    const o = buildSdkOptions({ role: "sd1", workflow: wf, task: "propose plan" });
    expect(o.allowedTools).toEqual([]);
    expect(o.permissionMode).toBe("plan");
    expect(o.cwd).toBe(wf.workspace_path);
    expect(typeof o.systemPrompt).toBe("string");
    expect((o.systemPrompt as string).length).toBeGreaterThan(100);
    expect(o.hooks).toBeDefined();
  });
  it("passes resume when supplied", () => {
    const wf = mkWorkflow();
    const o = buildSdkOptions({ role: "sd1", workflow: wf, task: "t", resume: "sess-42" });
    expect(o.resume).toBe("sess-42");
  });
  it("falls back to DEFAULT_MODEL when workflow.model is not in allowlist", () => {
    const wf = { ...mkWorkflow(), model: "totally-fake-model" };
    const o = buildSdkOptions({ role: "sd1", workflow: wf, task: "t" });
    expect(o.model).toBe("claude-sonnet-4-6");
  });

  it("PreToolUse hook denies any tool for text-only role (belt-and-braces)", async () => {
    const wf = mkWorkflow();
    const o = buildSdkOptions({ role: "sd1", workflow: wf, task: "t" });
    const hooks = o.hooks as {
      PreToolUse: Array<{
        hooks: Array<(input: unknown) => Promise<unknown>>;
      }>;
    };
    const hookFn = hooks.PreToolUse[0]!.hooks[0]!;
    const res = (await hookFn({ tool_name: "Read", tool_input: { file_path: "/tmp/x" } })) as {
      hookSpecificOutput?: { permissionDecision?: string };
    };
    expect(res.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("PreToolUse hook denies Write outside workspace for non-text-only role", async () => {
    const wf = mkWorkflow();
    const o = buildSdkOptions({ role: "d1", workflow: wf, task: "t" });
    const hooks = o.hooks as {
      PreToolUse: Array<{
        hooks: Array<(input: unknown) => Promise<unknown>>;
      }>;
    };
    const hookFn = hooks.PreToolUse[0]!.hooks[0]!;
    const res = (await hookFn({
      tool_name: "Write",
      tool_input: { file_path: "/etc/passwd", content: "x" },
    })) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(res.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});

// Minimal fake SDK stream helper.
async function* streamOf(...messages: unknown[]): AsyncIterable<unknown> {
  for (const m of messages) yield m;
}

describe("runAgent", () => {
  it("collects text + tool_use + result", async () => {
    setSdkQueryForTesting(
      () =>
        streamOf(
          {
            type: "assistant",
            message: {
              content: [
                { type: "text", text: "here is a plan" },
                { type: "tool_use", name: "Read", input: { file_path: "x" } },
                { type: "text", text: "STATUS: CONSENSUS_REACHED" },
              ],
            },
          },
          {
            type: "result",
            subtype: "success",
            total_cost_usd: 0.12,
            usage: { input_tokens: 100, output_tokens: 200 },
            num_turns: 3,
            session_id: "sess-xyz",
          }
        ) as never
    );
    const wf = mkWorkflow();
    const out = await runAgent({ role: "r1", workflow: wf, task: "research" });
    expect(out.error).toBeNull();
    expect(out.text).toContain("here is a plan");
    expect(out.text).toContain("STATUS: CONSENSUS_REACHED");
    expect(out.tool_uses).toHaveLength(1);
    expect(out.tool_uses[0]!.name).toBe("Read");
    expect(out.total_cost_usd).toBe(0.12);
    expect(out.input_tokens).toBe(100);
    expect(out.output_tokens).toBe(200);
    expect(out.session_id).toBe("sess-xyz");
    expect(out.num_turns).toBe(3);
  });

  it("flags textOnlyViolated when sys-design uses a tool", async () => {
    setSdkQueryForTesting(
      () =>
        streamOf(
          {
            type: "assistant",
            message: {
              content: [
                { type: "text", text: "plan..." },
                { type: "tool_use", name: "Read", input: { file_path: "/etc/passwd" } },
              ],
            },
          },
          {
            type: "result",
            subtype: "success",
            total_cost_usd: 0.01,
            usage: { input_tokens: 1, output_tokens: 1 },
            num_turns: 1,
            session_id: "s",
          }
        ) as never
    );
    const wf = mkWorkflow();
    const out = await runAgent({ role: "sd1", workflow: wf, task: "do a thing" });
    expect(out.textOnlyViolated).toBe(true);
  });

  it("captures SDK thrown errors into out.error", async () => {
    setSdkQueryForTesting(() => {
      throw new Error("api key invalid");
    });
    const wf = mkWorkflow();
    const out = await runAgent({ role: "r1", workflow: wf, task: "research" });
    expect(out.error).toContain("api key invalid");
  });

  it("propagates result subtype error even when stream didn't throw", async () => {
    setSdkQueryForTesting(
      () =>
        streamOf({
          type: "result",
          subtype: "error_max_turns",
          total_cost_usd: 0.5,
          usage: { input_tokens: 10, output_tokens: 10 },
          num_turns: 50,
          session_id: "s2",
        }) as never
    );
    const wf = mkWorkflow();
    const out = await runAgent({ role: "r1", workflow: wf, task: "t" });
    expect(out.error).toContain("error_max_turns");
    expect(out.total_cost_usd).toBe(0.5);
  });
});
