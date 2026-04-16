import { afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb, type Db } from "../src/lib/db";
import { _setKeyForTests } from "../src/lib/crypto";
import { createHost } from "../src/lib/hosts";
import { createProject } from "../src/lib/projects";
import {
  DEFAULT_BUDGET_USD,
  DEFAULT_MAX_ITERATIONS_PER_ASPECT,
  MAX_BUDGET_USD,
  createWorkflow,
  deleteWorkflow,
  isProjectMultiAgentEnabled,
  listWorkflows,
  recentWorkflowEvents,
  recordWorkflowEvent,
  removeWorkflowWorkspace,
  setProjectMultiAgent,
  validateBudget,
  validateIdea,
  validateWorkflowName,
} from "../src/lib/workflows";
import { existsSync, writeFileSync } from "node:fs";

let db: Db;
let tmpRoot: string;
const { privateKey } = crypto.generateKeyPairSync("ed25519");
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

beforeEach(() => {
  _setKeyForTests(crypto.randomBytes(32));
  db = createDb(":memory:");
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "dcm-wf-test-"));
  process.env.DCM_WORKFLOWS_DIR = tmpRoot;
});
afterEach(() => {
  _setKeyForTests(null);
  db.close();
  delete process.env.DCM_WORKFLOWS_DIR;
  rmSync(tmpRoot, { recursive: true, force: true });
});

function mkProject() {
  const host = createHost(
    { name: "h1", address: "10.0.0.1", ssh_user: "u", auth_method: "privkey", privkey: PEM },
    db
  );
  return createProject(
    { name: "proj", source_type: "local", host_id: host.id, path_on_host: "/home/u/p" },
    db
  );
}

describe("workflow validators", () => {
  it("name", () => {
    expect(validateWorkflowName("ok")).toBeNull();
    expect(validateWorkflowName("my workflow")).toBeNull();
    expect(validateWorkflowName("-bad")).not.toBeNull();
    expect(validateWorkflowName("a".repeat(65))).not.toBeNull();
  });
  it("idea length", () => {
    expect(validateIdea("short")).not.toBeNull();
    expect(validateIdea("a".repeat(10))).toBeNull();
    expect(validateIdea("a".repeat(10_001))).not.toBeNull();
  });
  it("budget", () => {
    expect(validateBudget(0.1)).toBeNull();
    expect(validateBudget(0)).not.toBeNull();
    expect(validateBudget(MAX_BUDGET_USD)).toBeNull();
    expect(validateBudget(MAX_BUDGET_USD + 1)).not.toBeNull();
    expect(validateBudget(NaN)).not.toBeNull();
  });
});

describe("project multi-agent toggle", () => {
  it("starts disabled", () => {
    const p = mkProject();
    expect(isProjectMultiAgentEnabled(p.id, db)).toBe(false);
  });
  it("toggles on/off", () => {
    const p = mkProject();
    expect(setProjectMultiAgent(p.id, true, db)).toBe(true);
    expect(isProjectMultiAgentEnabled(p.id, db)).toBe(true);
    setProjectMultiAgent(p.id, false, db);
    expect(isProjectMultiAgentEnabled(p.id, db)).toBe(false);
  });
});

describe("workflow CRUD", () => {
  it("creates with defaults + workspace dir", () => {
    const p = mkProject();
    const wf = createWorkflow(
      { project_id: p.id, name: "w1", idea: "build a small tool." },
      db
    );
    expect(wf.state).toBe("idea_intake");
    expect(wf.budget_usd).toBe(DEFAULT_BUDGET_USD);
    expect(wf.max_iterations_per_aspect).toBe(DEFAULT_MAX_ITERATIONS_PER_ASPECT);
    expect(wf.require_human_gate).toBe(true);
    expect(wf.workspace_path.endsWith(`/wf-${wf.id}`)).toBe(true);
  });

  it("rejects unknown project", () => {
    expect(() =>
      createWorkflow({ project_id: 999, name: "x", idea: "build a thing please" }, db)
    ).toThrow(/project/);
  });

  it("rejects invalid model", () => {
    const p = mkProject();
    expect(() =>
      createWorkflow(
        { project_id: p.id, name: "x", idea: "build a thing", model: "fake-model" },
        db
      )
    ).toThrow(/model/);
  });

  it("rejects over-budget", () => {
    const p = mkProject();
    expect(() =>
      createWorkflow(
        { project_id: p.id, name: "x", idea: "build a thing", budget_usd: 999_999 },
        db
      )
    ).toThrow(/Budget/);
  });

  it("delete removes workflow + cascades aspects/events", () => {
    const p = mkProject();
    const wf = createWorkflow({ project_id: p.id, name: "w", idea: "build a thing" }, db);
    recordWorkflowEvent({
      workflow_id: wf.id,
      phase: "idea_intake",
      kind: "workflow_created",
      db,
    });
    db.prepare(
      `INSERT INTO aspects (workflow_id, ord, title, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(wf.id, 1, "A", "d", Date.now(), Date.now());
    expect(listWorkflows(db)).toHaveLength(1);
    expect(deleteWorkflow(wf.id, db)).toBe(true);
    expect(listWorkflows(db)).toHaveLength(0);
    const aspects = db.prepare("SELECT COUNT(*) as c FROM aspects").get() as { c: number };
    const events = db.prepare("SELECT COUNT(*) as c FROM workflow_events").get() as { c: number };
    expect(aspects.c).toBe(0);
    expect(events.c).toBe(0);
  });

  it("cascades when project is deleted", () => {
    const p = mkProject();
    createWorkflow({ project_id: p.id, name: "w", idea: "build a thing" }, db);
    db.prepare("DELETE FROM projects WHERE id = ?").run(p.id);
    expect(listWorkflows(db)).toHaveLength(0);
  });
});

describe("workspace cleanup", () => {
  it("removeWorkflowWorkspace removes only when path is inside configured root", () => {
    const p = mkProject();
    const wf = createWorkflow({ project_id: p.id, name: "w", idea: "build a thing" }, db);
    writeFileSync(path.join(wf.workspace_path, "artifact.md"), "x");
    expect(existsSync(wf.workspace_path)).toBe(true);
    removeWorkflowWorkspace(wf);
    expect(existsSync(wf.workspace_path)).toBe(false);
  });

  it("removeWorkflowWorkspace refuses if workspace_path escapes configured root", () => {
    const p = mkProject();
    const wf = createWorkflow({ project_id: p.id, name: "w", idea: "build a thing" }, db);
    // Tamper with the record (shouldn't happen in practice, but defense-in-depth)
    const evil = { ...wf, workspace_path: "/tmp/escaped-not-in-dcm-root" };
    writeFileSync(path.join(wf.workspace_path, "marker.md"), "x");
    removeWorkflowWorkspace(evil);
    // Original workspace untouched, escaped path untouched (didn't exist)
    expect(existsSync(wf.workspace_path)).toBe(true);
  });
});

describe("workflow events", () => {
  it("records + retrieves", () => {
    const p = mkProject();
    const wf = createWorkflow({ project_id: p.id, name: "w", idea: "build a thing" }, db);
    recordWorkflowEvent({
      workflow_id: wf.id,
      phase: "idea_intake",
      kind: "workflow_created",
      payload: { budget_usd: 10 },
      db,
    });
    const events = recentWorkflowEvents(wf.id, 10, db);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("workflow_created");
    expect(events[0]!.payload).toEqual({ budget_usd: 10 });
  });
});
