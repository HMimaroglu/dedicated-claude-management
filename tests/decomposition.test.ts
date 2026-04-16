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
  createWorkflow,
  getWorkflow,
  listAspects,
  transitionWorkflow,
  type WorkflowRecord,
} from "../src/lib/workflows";
import { setSdkQueryForTesting } from "../src/orchestrator/sdk-adapter";
import { advanceDecomposition } from "../src/orchestrator/phases/decomposition";

let db: Db;
let tmpRoot: string;
const { privateKey } = crypto.generateKeyPairSync("ed25519");
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

beforeEach(() => {
  _setKeyForTests(crypto.randomBytes(32));
  db = createDb(":memory:");
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "dcm-dec-"));
  process.env.DCM_WORKFLOWS_DIR = tmpRoot;
});
afterEach(() => {
  _setKeyForTests(null);
  db.close();
  delete process.env.DCM_WORKFLOWS_DIR;
  rmSync(tmpRoot, { recursive: true, force: true });
  setSdkQueryForTesting(null);
});

const PLAN_A = `## Plan

### Aspect 1: Data model
- Description: tables
- Depends on: none
- Acceptance criteria: migrations run

### Aspect 2: API
- Description: routes
- Depends on: [1]
- Acceptance criteria: tests pass

STATUS: CONSENSUS_REACHED`;

const PLAN_A_ROUND0 = PLAN_A.replace("STATUS: CONSENSUS_REACHED", "STATUS: NEED_ROUND");

async function* streamOf(...msgs: unknown[]): AsyncIterable<unknown> {
  for (const m of msgs) yield m;
}

function sdkOk(text: string, cost = 0.01): unknown {
  return [
    {
      type: "assistant",
      message: { content: [{ type: "text", text }] },
    },
    {
      type: "result",
      subtype: "success",
      total_cost_usd: cost,
      usage: { input_tokens: 10, output_tokens: 10 },
      num_turns: 1,
      session_id: "sess-" + Math.random().toString(36).slice(2, 7),
    },
  ];
}

function mkWorkflow(overrides?: Partial<WorkflowRecord>): WorkflowRecord {
  const host = createHost(
    { name: "h", address: "a", ssh_user: "u", auth_method: "privkey", privkey: PEM },
    db
  );
  const proj = createProject(
    { name: "p", source_type: "local", host_id: host.id, path_on_host: "/home/u/p" },
    db
  );
  const wf = createWorkflow(
    { project_id: proj.id, name: "w", idea: "build a small tool please" },
    db
  );
  // Move to decomposition so the driver accepts it.
  transitionWorkflow({ id: wf.id, from: "idea_intake", to: "decomposition", db });
  const reloaded = getWorkflow(wf.id, db)!;
  return { ...reloaded, ...overrides };
}

describe("advanceDecomposition", () => {
  it("round 0 dispatches both agents and advances to round 1", async () => {
    const calls: string[] = [];
    setSdkQueryForTesting(() => {
      calls.push("call");
      return streamOf(...(sdkOk(PLAN_A_ROUND0) as unknown[])) as never;
    });
    const wf = mkWorkflow();
    const res = await advanceDecomposition(wf, db);
    expect(calls).toHaveLength(2); // sd1 + sd2
    expect(res.transitioned).toBe(false);
    const updated = getWorkflow(wf.id, db)!;
    expect(updated.consensus_round).toBe(1);
  });

  it("consensus on round 2+ creates aspects + gates to awaiting_human_gate", async () => {
    // Round 0: both produce a NEED_ROUND plan
    setSdkQueryForTesting(() => streamOf(...(sdkOk(PLAN_A_ROUND0) as unknown[])) as never);
    let wf = mkWorkflow();
    await advanceDecomposition(wf, db);
    wf = getWorkflow(wf.id, db)!;
    expect(wf.consensus_round).toBe(1);

    // Round 1+: both agree
    setSdkQueryForTesting(() => streamOf(...(sdkOk(PLAN_A) as unknown[])) as never);
    const res = await advanceDecomposition(wf, db);
    wf = getWorkflow(wf.id, db)!;
    // Second round dispatched, consensus_round advanced to 2 but not yet consensus
    expect(wf.consensus_round).toBe(2);
    expect(res.transitioned).toBe(false);

    // Third call: now both agents' last_text has CONSENSUS — should transition
    const res2 = await advanceDecomposition(wf, db);
    expect(res2.transitioned).toBe(true);
    expect(res2.newState).toBe("awaiting_human_gate");
    const aspects = listAspects(wf.id, db);
    expect(aspects).toHaveLength(2);
    expect(aspects[0]!.title).toBe("Data model");
  });

  it("skips human gate when require_human_gate=false", async () => {
    setSdkQueryForTesting(() => streamOf(...(sdkOk(PLAN_A) as unknown[])) as never);
    let wf = mkWorkflow();
    db.prepare("UPDATE workflows SET require_human_gate = 0 WHERE id = ?").run(wf.id);
    wf = getWorkflow(wf.id, db)!;

    await advanceDecomposition(wf, db); // round 0 dispatch
    wf = getWorkflow(wf.id, db)!;
    const res = await advanceDecomposition(wf, db); // consensus check transitions
    expect(res.transitioned).toBe(true);
    expect(res.newState).toBe("aspect_research");
    wf = getWorkflow(wf.id, db)!;
    expect(wf.current_aspect_ord).toBe(1);
    expect(wf.state).toBe("aspect_research");

    // Extra tick is a no-op after transition.
    const noop = await advanceDecomposition(wf, db);
    expect(noop.transitioned).toBe(false);
  });

  it("transitions to error after max rounds without consensus", async () => {
    setSdkQueryForTesting(() => streamOf(...(sdkOk(PLAN_A_ROUND0) as unknown[])) as never);
    let wf = mkWorkflow();
    // Cycle until round exceeds max
    for (let i = 0; i < 6; i++) {
      await advanceDecomposition(wf, db);
      wf = getWorkflow(wf.id, db)!;
      if (wf.state !== "decomposition") break;
    }
    expect(wf.state).toBe("error");
    expect(wf.last_error).toMatch(/converge/);
  });

  it("transitions to error when any agent reports deadlock", async () => {
    const deadlockPlan = PLAN_A.replace("STATUS: CONSENSUS_REACHED", "STATUS: DEADLOCK");
    // Round 0: both NEED_ROUND (so we can proceed to round 1 check)
    setSdkQueryForTesting(() => streamOf(...(sdkOk(PLAN_A_ROUND0) as unknown[])) as never);
    let wf = mkWorkflow();
    await advanceDecomposition(wf, db);
    wf = getWorkflow(wf.id, db)!;
    // Now sd1 will deadlock on round 1
    let call = 0;
    setSdkQueryForTesting(() => {
      call += 1;
      return streamOf(
        ...(sdkOk(call === 1 ? deadlockPlan : PLAN_A_ROUND0) as unknown[])
      ) as never;
    });
    await advanceDecomposition(wf, db);
    wf = getWorkflow(wf.id, db)!;
    // Next tick checks statuses and sees deadlock
    const res = await advanceDecomposition(wf, db);
    expect(res.newState).toBe("error");
    expect(res.reason).toMatch(/deadlock/);
  });

  it("captures budget exhaustion before sending the turn", async () => {
    const wf = mkWorkflow();
    db.prepare("UPDATE workflows SET spent_usd = ? WHERE id = ?").run(wf.budget_usd + 1, wf.id);
    const reloaded = getWorkflow(wf.id, db)!;
    const res = await advanceDecomposition(reloaded, db);
    expect(res.newState).toBe("error");
    expect(res.reason).toMatch(/budget/i);
  });
});
