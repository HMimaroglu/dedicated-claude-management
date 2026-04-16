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
  insertAspects,
  listAspects,
  type WorkflowRecord,
} from "../src/lib/workflows";
import { setSdkQueryForTesting } from "../src/orchestrator/sdk-adapter";
import { advanceResearch } from "../src/orchestrator/phases/research";
import { advanceResearchReview } from "../src/orchestrator/phases/research-review";
import { advanceImpl } from "../src/orchestrator/phases/impl";

let db: Db;
let tmpRoot: string;
const { privateKey } = crypto.generateKeyPairSync("ed25519");
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

beforeEach(() => {
  _setKeyForTests(crypto.randomBytes(32));
  db = createDb(":memory:");
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "dcm-r-"));
  process.env.DCM_WORKFLOWS_DIR = tmpRoot;
});
afterEach(() => {
  _setKeyForTests(null);
  db.close();
  delete process.env.DCM_WORKFLOWS_DIR;
  rmSync(tmpRoot, { recursive: true, force: true });
  setSdkQueryForTesting(null);
});

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
      usage: { input_tokens: 5, output_tokens: 5 },
      num_turns: 1,
      session_id: "sess-" + Math.random().toString(36).slice(2, 7),
    },
  ];
}

function setupWorkflow(state: WorkflowRecord["state"] = "aspect_research"): WorkflowRecord {
  const host = createHost(
    { name: "h", address: "a", ssh_user: "u", auth_method: "privkey", privkey: PEM },
    db
  );
  const proj = createProject(
    { name: "p", source_type: "local", host_id: host.id, path_on_host: "/home/u/p" },
    db
  );
  const wf = createWorkflow(
    { project_id: proj.id, name: "w", idea: "build a thing please" },
    db
  );
  insertAspects(
    wf.id,
    [
      {
        ord: 1,
        title: "Alpha",
        description: "first piece",
        depends_on: [],
        acceptance_criteria: "works",
      },
      {
        ord: 2,
        title: "Beta",
        description: "second piece",
        depends_on: [1],
        acceptance_criteria: "works",
      },
    ],
    db
  );
  db.prepare("UPDATE workflows SET state = ?, current_aspect_ord = 1 WHERE id = ?").run(
    state,
    wf.id
  );
  return getWorkflow(wf.id, db)!;
}

describe("advanceResearch", () => {
  it("round 0 dispatches independent research for both r1 + r2", async () => {
    let calls = 0;
    setSdkQueryForTesting(() => {
      calls += 1;
      return streamOf(...(sdkOk("research body\nSTATUS: NEED_ROUND") as unknown[])) as never;
    });
    let wf = setupWorkflow();
    await advanceResearch(wf, db);
    expect(calls).toBe(2);
    wf = getWorkflow(wf.id, db)!;
    expect(wf.state).toBe("aspect_research");
    expect(listAspects(wf.id, db)[0]!.loop_count).toBe(1);
  });

  it("converges to aspect_research_review when both r1 + r2 say RESEARCH_READY", async () => {
    // Round 0: NEED_ROUND
    setSdkQueryForTesting(() =>
      streamOf(...(sdkOk("body\nSTATUS: NEED_ROUND") as unknown[])) as never
    );
    let wf = setupWorkflow();
    await advanceResearch(wf, db);
    wf = getWorkflow(wf.id, db)!;
    // Round 1 (cross-exam): both RESEARCH_READY
    setSdkQueryForTesting(() =>
      streamOf(...(sdkOk("critique\nSTATUS: RESEARCH_READY") as unknown[])) as never
    );
    // Cross-exam dispatched
    await advanceResearch(wf, db);
    wf = getWorkflow(wf.id, db)!;
    // Next tick sees both READY → transitions
    const res = await advanceResearch(wf, db);
    expect(res.transitioned).toBe(true);
    expect(res.newState).toBe("aspect_research_review");
    const aspects = listAspects(wf.id, db);
    expect(aspects[0]!.research_md).toBeTruthy();
    expect(aspects[0]!.state).toBe("review");
  });

  it("errors after max research rounds without convergence", async () => {
    setSdkQueryForTesting(() =>
      streamOf(...(sdkOk("body\nSTATUS: NEED_ROUND") as unknown[])) as never
    );
    let wf = setupWorkflow();
    for (let i = 0; i < 5; i++) {
      await advanceResearch(wf, db);
      wf = getWorkflow(wf.id, db)!;
      if (wf.state !== "aspect_research") break;
    }
    expect(wf.state).toBe("error");
  });
});

describe("advanceResearchReview", () => {
  it("both sd approve → transitions to aspect_impl", async () => {
    setSdkQueryForTesting(() =>
      streamOf(...(sdkOk("looks great\nSTATUS: CONSENSUS_REACHED") as unknown[])) as never
    );
    let wf = setupWorkflow("aspect_research_review");
    db.prepare("UPDATE aspects SET state = 'review', research_md = ? WHERE workflow_id = ? AND ord = 1").run(
      "merged research content",
      wf.id
    );
    const res = await advanceResearchReview(wf, db);
    expect(res.transitioned).toBe(true);
    expect(res.newState).toBe("aspect_impl");
    wf = getWorkflow(wf.id, db)!;
    expect(wf.state).toBe("aspect_impl");
  });

  it("sd disagreement sends back to aspect_research", async () => {
    setSdkQueryForTesting(() =>
      streamOf(...(sdkOk("issues exist\nSTATUS: DISAGREE") as unknown[])) as never
    );
    let wf = setupWorkflow("aspect_research_review");
    db.prepare("UPDATE aspects SET state = 'review' WHERE workflow_id = ? AND ord = 1").run(wf.id);
    const res = await advanceResearchReview(wf, db);
    expect(res.transitioned).toBe(true);
    expect(res.newState).toBe("aspect_research");
  });
});

describe("advanceImpl", () => {
  it("round dispatches both dev agents", async () => {
    let calls = 0;
    setSdkQueryForTesting(() => {
      calls += 1;
      return streamOf(
        ...(sdkOk("made some progress\n## Changes\n- added foo.ts\n\nSTATUS: NEED_MORE_TURNS") as unknown[])
      ) as never;
    });
    let wf = setupWorkflow("aspect_impl");
    db.prepare("UPDATE aspects SET state = 'impl' WHERE workflow_id = ? AND ord = 1").run(wf.id);
    await advanceImpl(wf, db);
    expect(calls).toBe(2);
    wf = getWorkflow(wf.id, db)!;
    expect(wf.state).toBe("aspect_impl");
    expect(listAspects(wf.id, db)[0]!.loop_count).toBe(1);
  });

  it("transitions to aspect_audit when both devs emit IMPL_READY_FOR_AUDIT", async () => {
    // Round 1
    setSdkQueryForTesting(() =>
      streamOf(...(sdkOk("body\nSTATUS: NEED_MORE_TURNS") as unknown[])) as never
    );
    let wf = setupWorkflow("aspect_impl");
    db.prepare("UPDATE aspects SET state = 'impl' WHERE workflow_id = ? AND ord = 1").run(wf.id);
    await advanceImpl(wf, db);
    wf = getWorkflow(wf.id, db)!;
    // Round 2: both ready
    setSdkQueryForTesting(() =>
      streamOf(
        ...(sdkOk("done\n## Changes\n- stuff\nSTATUS: IMPL_READY_FOR_AUDIT") as unknown[])
      ) as never
    );
    await advanceImpl(wf, db);
    wf = getWorkflow(wf.id, db)!;
    // Next tick sees both ready → transitions
    const res = await advanceImpl(wf, db);
    expect(res.transitioned).toBe(true);
    expect(res.newState).toBe("aspect_audit");
  });

  it("errors when loop_count exceeds max_iterations_per_aspect", async () => {
    setSdkQueryForTesting(() =>
      streamOf(...(sdkOk("body\nSTATUS: NEED_MORE_TURNS") as unknown[])) as never
    );
    let wf = setupWorkflow("aspect_impl");
    db.prepare("UPDATE workflows SET max_iterations_per_aspect = 1 WHERE id = ?").run(wf.id);
    db.prepare("UPDATE aspects SET state = 'impl', loop_count = 1 WHERE workflow_id = ? AND ord = 1").run(
      wf.id
    );
    wf = getWorkflow(wf.id, db)!;
    const res = await advanceImpl(wf, db);
    expect(res.newState).toBe("error");
  });
});
