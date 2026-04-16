import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Db } from "@/lib/db";
import { getDb } from "@/lib/db";
import {
  getAgent,
  recordWorkflowEvent,
  transitionWorkflow,
  type AspectRecord,
  type WorkflowRecord,
} from "@/lib/workflows";
import { decidePanel, parseAuditReport, type AuditReport } from "../audit-parse";
import { ensureBudget, runTurnsParallel } from "../phase-helpers";

export interface AuditStepResult {
  transitioned: boolean;
  newState: WorkflowRecord["state"] | null;
  reason: string;
}

function auditTask(wf: WorkflowRecord, aspect: AspectRecord): string {
  return `## Task
Audit the implementation of aspect ${aspect.ord}. You are one of three independent auditors. Your verdict matters — the any-fail rule applies.

## Project idea
${wf.idea}

## Aspect ${aspect.ord}: ${aspect.title}
${aspect.description}

Acceptance criteria: ${aspect.acceptance_criteria ?? "(none specified)"}

## Merged research (basis for accuracy domain)
${aspect.research_md ?? "(empty)"}

## Implementation location
Files under: ${wf.workspace_path}/aspects/${aspect.ord}/src/
You have Read, Glob, Grep available.

## Deliverable
Produce exactly one fenced \`json\` block as specified in your role description. Do not include prose before or after the block.`;
}

function loadAspect(wf: WorkflowRecord, db: Db): AspectRecord | null {
  if (wf.current_aspect_ord === null) return null;
  const row = db
    .prepare("SELECT * FROM aspects WHERE workflow_id = ? AND ord = ?")
    .get(wf.id, wf.current_aspect_ord) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: row.id as number,
    workflow_id: row.workflow_id as number,
    ord: row.ord as number,
    title: row.title as string,
    description: row.description as string,
    depends_on: JSON.parse((row.depends_on as string) || "[]"),
    acceptance_criteria: (row.acceptance_criteria as string | null) ?? null,
    state: row.state as AspectRecord["state"],
    research_md: (row.research_md as string | null) ?? null,
    loop_count: row.loop_count as number,
    created_at: row.created_at as number,
    updated_at: row.updated_at as number,
  };
}

export async function advanceAudit(wf: WorkflowRecord, d?: Db): Promise<AuditStepResult> {
  const db = d ?? getDb();
  if (wf.state !== "aspect_audit") {
    return { transitioned: false, newState: null, reason: `wrong state: ${wf.state}` };
  }

  try {
    ensureBudget(wf);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    transitionWorkflow({ id: wf.id, from: "aspect_audit", to: "error", last_error: msg, db });
    return { transitioned: true, newState: "error", reason: msg };
  }

  const aspect = loadAspect(wf, db);
  if (!aspect) {
    transitionWorkflow({
      id: wf.id,
      from: "aspect_audit",
      to: "error",
      last_error: "current aspect not found during audit",
      db,
    });
    return { transitioned: true, newState: "error", reason: "aspect missing" };
  }

  if (aspect.loop_count >= wf.max_iterations_per_aspect) {
    transitionWorkflow({
      id: wf.id,
      from: "aspect_audit",
      to: "error",
      last_error: `audit-loop exceeded max iterations (${wf.max_iterations_per_aspect})`,
      db,
    });
    return { transitioned: true, newState: "error", reason: "audit iterations exhausted" };
  }

  // Check whether all three auditors have already produced output this round.
  const a1 = getAgent(wf.id, "a1", db);
  const a2 = getAgent(wf.id, "a2", db);
  const a3 = getAgent(wf.id, "a3", db);
  const haveAll =
    a1?.last_text &&
    a2?.last_text &&
    a3?.last_text &&
    a1.updated_at >= aspect.updated_at &&
    a2.updated_at >= aspect.updated_at &&
    a3.updated_at >= aspect.updated_at;

  if (!haveAll) {
    const task = auditTask(wf, aspect);
    await runTurnsParallel({
      roles: ["a1", "a2", "a3"],
      workflow: wf,
      taskFor: () => task,
      db,
      phase: "aspect_audit",
      aspect_ord: aspect.ord,
    });
    db.prepare("UPDATE aspects SET updated_at = ? WHERE id = ?").run(Date.now(), aspect.id);
    return { transitioned: false, newState: null, reason: "audit dispatched" };
  }

  // Parse each auditor's JSON report.
  const parse = (text: string | null): AuditReport | null => {
    if (!text) return null;
    return parseAuditReport(text).report;
  };
  const r1 = parse(a1?.last_text ?? null);
  const r2 = parse(a2?.last_text ?? null);
  const r3 = parse(a3?.last_text ?? null);

  if (!r1 || !r2 || !r3) {
    // A malformed auditor response is treated as fail_implementation so the
    // dev agents get another turn and the auditors re-run. We don't error out
    // outright because a parse miss is a transient issue.
    recordWorkflowEvent({
      workflow_id: wf.id,
      aspect_ord: aspect.ord,
      phase: "aspect_audit",
      kind: "audit_parse_miss",
      payload: { a1: r1 !== null, a2: r2 !== null, a3: r3 !== null },
      db,
    });
    db.prepare(
      "UPDATE aspects SET state = 'impl', loop_count = loop_count + 1, updated_at = ? WHERE id = ?"
    ).run(Date.now(), aspect.id);
    transitionWorkflow({ id: wf.id, from: "aspect_audit", to: "aspect_impl", db });
    return {
      transitioned: true,
      newState: "aspect_impl",
      reason: "auditor(s) produced malformed report; re-looping impl",
    };
  }

  const decision = decidePanel({ a1: r1, a2: r2, a3: r3 });

  // Persist the combined report to workspace + DB event for audit trail.
  try {
    const dir = path.join(wf.workspace_path, "aspects", String(aspect.ord));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(dir, `audit-round-${aspect.loop_count}.json`),
      JSON.stringify({ round: aspect.loop_count, decision, reports: { r1, r2, r3 } }, null, 2),
      { mode: 0o600 }
    );
  } catch {
    // best-effort
  }
  recordWorkflowEvent({
    workflow_id: wf.id,
    aspect_ord: aspect.ord,
    phase: "aspect_audit",
    kind: "audit_decided",
    payload: { decision: decision.kind, issue_count: decision.all_issues.length },
    db,
  });

  if (decision.kind === "pass") {
    db.prepare("UPDATE aspects SET state = 'push', updated_at = ? WHERE id = ?").run(
      Date.now(),
      aspect.id
    );
    transitionWorkflow({ id: wf.id, from: "aspect_audit", to: "aspect_push", db });
    return { transitioned: true, newState: "aspect_push", reason: "all auditors passed" };
  }

  if (decision.kind === "fail_research") {
    db.prepare(
      "UPDATE aspects SET state = 'research', loop_count = 0, research_md = NULL, updated_at = ? WHERE id = ?"
    ).run(Date.now(), aspect.id);
    transitionWorkflow({ id: wf.id, from: "aspect_audit", to: "aspect_research", db });
    return {
      transitioned: true,
      newState: "aspect_research",
      reason: "audit flagged flawed research — restarting research",
    };
  }

  // fail_implementation
  db.prepare(
    "UPDATE aspects SET state = 'impl', loop_count = loop_count + 1, updated_at = ? WHERE id = ?"
  ).run(Date.now(), aspect.id);
  transitionWorkflow({ id: wf.id, from: "aspect_audit", to: "aspect_impl", db });
  return {
    transitioned: true,
    newState: "aspect_impl",
    reason: `audit flagged ${decision.all_issues.length} implementation issue(s) — re-looping impl`,
  };
}
