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
import { advanceAudit } from "../src/orchestrator/phases/audit";
import {
  advancePush,
  advanceSignoff,
} from "../src/orchestrator/phases/push-signoff";
import { advanceFinalReview } from "../src/orchestrator/phases/final-review";
import { decidePanel, parseAuditReport } from "../src/orchestrator/audit-parse";

let db: Db;
let tmpRoot: string;
const { privateKey } = crypto.generateKeyPairSync("ed25519");
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

beforeEach(() => {
  _setKeyForTests(crypto.randomBytes(32));
  db = createDb(":memory:");
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "dcm-a-"));
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
    { type: "assistant", message: { content: [{ type: "text", text }] } },
    {
      type: "result",
      subtype: "success",
      total_cost_usd: cost,
      usage: { input_tokens: 5, output_tokens: 5 },
      num_turns: 1,
      session_id: "s-" + Math.random().toString(36).slice(2, 6),
    },
  ];
}

function seed(state: WorkflowRecord["state"]): WorkflowRecord {
  const host = createHost(
    { name: "h", address: "a", ssh_user: "u", auth_method: "privkey", privkey: PEM },
    db
  );
  const proj = createProject(
    { name: "p", source_type: "local", host_id: host.id, path_on_host: "/home/u/p" },
    db
  );
  const wf = createWorkflow(
    { project_id: proj.id, name: "w", idea: "build something good" },
    db
  );
  insertAspects(
    wf.id,
    [
      { ord: 1, title: "Alpha", description: "a", depends_on: [] },
      { ord: 2, title: "Beta", description: "b", depends_on: [1] },
    ],
    db
  );
  db.prepare(
    "UPDATE workflows SET state = ?, current_aspect_ord = 1 WHERE id = ?"
  ).run(state, wf.id);
  return getWorkflow(wf.id, db)!;
}

describe("parseAuditReport", () => {
  it("parses fenced json block", () => {
    const text = '```json\n{"verdict":"pass","issues":[]}\n```';
    expect(parseAuditReport(text).report?.verdict).toBe("pass");
  });
  it("falls back to loose object", () => {
    const text = 'here is the report {"verdict":"fail_implementation","issues":[]}';
    expect(parseAuditReport(text).report?.verdict).toBe("fail_implementation");
  });
  it("rejects invalid verdict", () => {
    expect(parseAuditReport('```json\n{"verdict":"maybe"}\n```').report).toBeNull();
  });
  it("treats pass-with-issues as fail_implementation (self-contradiction)", () => {
    const text = '```json\n{"verdict":"pass","issues":[{"domain":"logic","location":"x","description":"d"}]}\n```';
    expect(parseAuditReport(text).report?.verdict).toBe("fail_implementation");
  });
});

describe("decidePanel (any-fail rule)", () => {
  it("all pass → pass", () => {
    const p = decidePanel({
      a1: { verdict: "pass", issues: [] },
      a2: { verdict: "pass", issues: [] },
      a3: { verdict: "pass", issues: [] },
    });
    expect(p.kind).toBe("pass");
  });
  it("any fail_implementation → fail", () => {
    const p = decidePanel({
      a1: { verdict: "pass", issues: [] },
      a2: { verdict: "pass", issues: [] },
      a3: { verdict: "fail_implementation", issues: [] },
    });
    expect(p.kind).toBe("fail_implementation");
  });
  it("fail_research takes precedence over fail_implementation", () => {
    const p = decidePanel({
      a1: { verdict: "fail_implementation", issues: [] },
      a2: { verdict: "fail_research", issues: [] },
      a3: { verdict: "pass", issues: [] },
    });
    expect(p.kind).toBe("fail_research");
  });
});

describe("advanceAudit", () => {
  it("dispatches 3 auditors when none have output yet", async () => {
    let calls = 0;
    setSdkQueryForTesting(() => {
      calls += 1;
      return streamOf(...(sdkOk('```json\n{"verdict":"pass","issues":[]}\n```') as unknown[])) as never;
    });
    let wf = seed("aspect_audit");
    await advanceAudit(wf, db);
    expect(calls).toBe(3);
  });

  it("all auditors pass → transitions to aspect_push", async () => {
    setSdkQueryForTesting(() =>
      streamOf(...(sdkOk('```json\n{"verdict":"pass","issues":[]}\n```') as unknown[])) as never
    );
    let wf = seed("aspect_audit");
    await advanceAudit(wf, db);
    wf = getWorkflow(wf.id, db)!;
    const res = await advanceAudit(wf, db);
    expect(res.transitioned).toBe(true);
    expect(res.newState).toBe("aspect_push");
  });

  it("any auditor fail_implementation → back to aspect_impl", async () => {
    let call = 0;
    setSdkQueryForTesting(() => {
      call += 1;
      const verdict = call === 2 ? "fail_implementation" : "pass";
      return streamOf(
        ...(sdkOk(`\`\`\`json\n{"verdict":"${verdict}","issues":[]}\n\`\`\``) as unknown[])
      ) as never;
    });
    let wf = seed("aspect_audit");
    await advanceAudit(wf, db);
    wf = getWorkflow(wf.id, db)!;
    const res = await advanceAudit(wf, db);
    expect(res.newState).toBe("aspect_impl");
  });

  it("fail_research rewinds research state and clears research_md", async () => {
    let call = 0;
    setSdkQueryForTesting(() => {
      call += 1;
      const verdict = call === 1 ? "fail_research" : "pass";
      return streamOf(
        ...(sdkOk(`\`\`\`json\n{"verdict":"${verdict}","issues":[]}\n\`\`\``) as unknown[])
      ) as never;
    });
    let wf = seed("aspect_audit");
    db.prepare("UPDATE aspects SET research_md = 'old research' WHERE workflow_id = ? AND ord = 1").run(
      wf.id
    );
    await advanceAudit(wf, db);
    wf = getWorkflow(wf.id, db)!;
    const res = await advanceAudit(wf, db);
    expect(res.newState).toBe("aspect_research");
    const aspects = listAspects(wf.id, db);
    expect(aspects[0]!.research_md).toBeNull();
  });

  it("malformed auditor JSON → re-loops impl (defensive)", async () => {
    setSdkQueryForTesting(() =>
      streamOf(...(sdkOk("not json at all") as unknown[])) as never
    );
    let wf = seed("aspect_audit");
    await advanceAudit(wf, db);
    wf = getWorkflow(wf.id, db)!;
    const res = await advanceAudit(wf, db);
    expect(res.newState).toBe("aspect_impl");
  });
});

describe("advancePush", () => {
  it("advances aspect_push → aspect_signoff", () => {
    const wf = seed("aspect_push");
    db.prepare("UPDATE aspects SET state = 'push' WHERE workflow_id = ? AND ord = 1").run(wf.id);
    const res = advancePush(wf, db);
    expect(res.newState).toBe("aspect_signoff");
  });
});

describe("advanceSignoff", () => {
  it("both sd approve + more aspects → next aspect in aspect_research", async () => {
    setSdkQueryForTesting(() =>
      streamOf(...(sdkOk("ok\nSTATUS: CONSENSUS_REACHED") as unknown[])) as never
    );
    let wf = seed("aspect_signoff");
    db.prepare("UPDATE aspects SET state = 'signoff' WHERE workflow_id = ? AND ord = 1").run(wf.id);
    const res = await advanceSignoff(wf, db);
    expect(res.newState).toBe("aspect_research");
    wf = getWorkflow(wf.id, db)!;
    expect(wf.current_aspect_ord).toBe(2);
  });

  it("last aspect approved → final_review", async () => {
    setSdkQueryForTesting(() =>
      streamOf(...(sdkOk("ok\nSTATUS: CONSENSUS_REACHED") as unknown[])) as never
    );
    let wf = seed("aspect_signoff");
    // mark 1 complete, 2 as signoff, and current = 2
    db.prepare("UPDATE aspects SET state = 'complete' WHERE workflow_id = ? AND ord = 1").run(wf.id);
    db.prepare("UPDATE aspects SET state = 'signoff' WHERE workflow_id = ? AND ord = 2").run(wf.id);
    db.prepare("UPDATE workflows SET current_aspect_ord = 2 WHERE id = ?").run(wf.id);
    wf = getWorkflow(wf.id, db)!;
    const res = await advanceSignoff(wf, db);
    expect(res.newState).toBe("final_review");
  });

  it("disagreement → back to aspect_impl", async () => {
    setSdkQueryForTesting(() =>
      streamOf(...(sdkOk("issues\nSTATUS: DISAGREE") as unknown[])) as never
    );
    let wf = seed("aspect_signoff");
    db.prepare("UPDATE aspects SET state = 'signoff' WHERE workflow_id = ? AND ord = 1").run(wf.id);
    const res = await advanceSignoff(wf, db);
    expect(res.newState).toBe("aspect_impl");
  });
});

describe("advanceFinalReview", () => {
  it("both sd approve → complete", async () => {
    setSdkQueryForTesting(() =>
      streamOf(...(sdkOk("all good\nSTATUS: CONSENSUS_REACHED") as unknown[])) as never
    );
    let wf = seed("final_review");
    const res = await advanceFinalReview(wf, db);
    expect(res.newState).toBe("complete");
    wf = getWorkflow(wf.id, db)!;
    expect(wf.completed_at).toBeGreaterThan(0);
  });

  it("disagreement → error", async () => {
    setSdkQueryForTesting(() =>
      streamOf(...(sdkOk("issues\nSTATUS: DISAGREE") as unknown[])) as never
    );
    const wf = seed("final_review");
    const res = await advanceFinalReview(wf, db);
    expect(res.newState).toBe("error");
  });
});
