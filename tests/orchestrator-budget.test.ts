import { afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb, type Db } from "../src/lib/db";
import { _setKeyForTests } from "../src/lib/crypto";
import { createHost } from "../src/lib/hosts";
import { createProject } from "../src/lib/projects";
import { createWorkflow, getWorkflow, recentWorkflowEvents } from "../src/lib/workflows";
import {
  accumulateSessionCost,
  assertBudgetHeadroom,
  BudgetExceededError,
  overBudget,
} from "../src/orchestrator/budget";

let db: Db;
let tmpRoot: string;
const { privateKey } = crypto.generateKeyPairSync("ed25519");
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

beforeEach(() => {
  _setKeyForTests(crypto.randomBytes(32));
  db = createDb(":memory:");
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "dcm-budget-test-"));
  process.env.DCM_WORKFLOWS_DIR = tmpRoot;
});
afterEach(() => {
  _setKeyForTests(null);
  db.close();
  delete process.env.DCM_WORKFLOWS_DIR;
  rmSync(tmpRoot, { recursive: true, force: true });
});

function mkWorkflow(budget_usd = 10) {
  const host = createHost(
    { name: "h", address: "a", ssh_user: "u", auth_method: "privkey", privkey: PEM },
    db
  );
  const proj = createProject(
    { name: "p", source_type: "local", host_id: host.id, path_on_host: "/home/u/p" },
    db
  );
  return createWorkflow(
    { project_id: proj.id, name: "w", idea: "build a thing please", budget_usd },
    db
  );
}

describe("assertBudgetHeadroom", () => {
  it("passes below budget", () => {
    const wf = mkWorkflow(10);
    expect(() => assertBudgetHeadroom(wf)).not.toThrow();
  });
  it("throws at/over budget", () => {
    const wf = { ...mkWorkflow(10), spent_usd: 10 };
    expect(() => assertBudgetHeadroom(wf)).toThrow(BudgetExceededError);
  });
});

describe("accumulateSessionCost", () => {
  it("increments per-agent + per-workflow totals", () => {
    const wf = mkWorkflow();
    const u = accumulateSessionCost({
      workflow_id: wf.id,
      role: "sd1",
      total_cost_usd: 0.5,
      input_tokens: 100,
      output_tokens: 200,
      sdk_session_id: "sess-1",
      db,
    });
    expect(u.spent_usd).toBeCloseTo(0.5, 6);
    const agent = db
      .prepare("SELECT * FROM workflow_agents WHERE workflow_id = ? AND role = ?")
      .get(wf.id, "sd1") as Record<string, unknown>;
    expect(agent.total_cost_usd).toBeCloseTo(0.5, 6);
    expect(agent.total_input_tokens).toBe(100);
    expect(agent.total_output_tokens).toBe(200);
    expect(agent.sdk_session_id).toBe("sess-1");
  });

  it("upserts on repeat calls for the same role", () => {
    const wf = mkWorkflow();
    accumulateSessionCost({
      workflow_id: wf.id,
      role: "sd1",
      total_cost_usd: 0.5,
      input_tokens: 100,
      output_tokens: 200,
      db,
    });
    accumulateSessionCost({
      workflow_id: wf.id,
      role: "sd1",
      total_cost_usd: 0.3,
      input_tokens: 50,
      output_tokens: 50,
      db,
    });
    const agent = db
      .prepare("SELECT * FROM workflow_agents WHERE workflow_id = ? AND role = ?")
      .get(wf.id, "sd1") as Record<string, unknown>;
    expect(agent.total_cost_usd).toBeCloseTo(0.8, 6);
    expect(agent.total_input_tokens).toBe(150);
    const updated = getWorkflow(wf.id, db)!;
    expect(updated.spent_usd).toBeCloseTo(0.8, 6);
  });

  it("clamps negative cost to 0 (defensive against SDK bugs)", () => {
    const wf = mkWorkflow();
    const u = accumulateSessionCost({
      workflow_id: wf.id,
      role: "sd1",
      total_cost_usd: -1,
      input_tokens: -5,
      output_tokens: -5,
      db,
    });
    expect(u.spent_usd).toBe(0);
  });

  it("clamps Infinity/NaN to 0", () => {
    const wf = mkWorkflow();
    accumulateSessionCost({
      workflow_id: wf.id,
      role: "sd1",
      total_cost_usd: Number.POSITIVE_INFINITY,
      input_tokens: NaN,
      output_tokens: 10,
      db,
    });
    const updated = getWorkflow(wf.id, db)!;
    expect(updated.spent_usd).toBe(0);
  });

  it("emits a budget_exceeded event exactly once on the under→over transition", () => {
    const wf = mkWorkflow(1);
    accumulateSessionCost({
      workflow_id: wf.id,
      role: "sd1",
      total_cost_usd: 2,
      input_tokens: 0,
      output_tokens: 0,
      db,
    });
    const updated = getWorkflow(wf.id, db)!;
    expect(overBudget(updated)).toBe(true);
    // call a second time while already over — MUST NOT emit a second event
    accumulateSessionCost({
      workflow_id: wf.id,
      role: "sd1",
      total_cost_usd: 0.5,
      input_tokens: 0,
      output_tokens: 0,
      db,
    });
    const events = recentWorkflowEvents(wf.id, 10, db);
    const exceeded = events.filter((e) => e.kind === "budget_exceeded");
    expect(exceeded).toHaveLength(1);
  });
});
