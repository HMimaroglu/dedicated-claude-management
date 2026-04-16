import type { Db } from "@/lib/db";
import { getDb } from "@/lib/db";
import {
  recordWorkflowEvent,
  transitionWorkflow,
  type AspectRecord,
  type WorkflowRecord,
} from "@/lib/workflows";
import { parseStatusLine } from "../plan-parser";
import { ensureBudget, runTurn } from "../phase-helpers";

export interface PhaseStepResult {
  transitioned: boolean;
  newState: WorkflowRecord["state"] | null;
  reason: string;
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

// Push is an auto-transition for MVP: we don't git-push anywhere, we just
// record that the aspect's implementation has cleared audit and move to
// sign-off. Future: let dev agents choose a strategy and emit a commit.
export function advancePush(wf: WorkflowRecord, d?: Db): PhaseStepResult {
  const db = d ?? getDb();
  if (wf.state !== "aspect_push") {
    return { transitioned: false, newState: null, reason: `wrong state: ${wf.state}` };
  }
  const aspect = loadAspect(wf, db);
  if (!aspect) {
    transitionWorkflow({
      id: wf.id,
      from: "aspect_push",
      to: "error",
      last_error: "current aspect not found during push",
      db,
    });
    return { transitioned: true, newState: "error", reason: "aspect missing" };
  }
  db.prepare("UPDATE aspects SET state = 'signoff', updated_at = ? WHERE id = ?").run(
    Date.now(),
    aspect.id
  );
  transitionWorkflow({ id: wf.id, from: "aspect_push", to: "aspect_signoff", db });
  recordWorkflowEvent({
    workflow_id: wf.id,
    aspect_ord: aspect.ord,
    phase: "aspect_push",
    kind: "push_recorded",
    payload: { note: "MVP: push is a local checkpoint" },
    db,
  });
  return { transitioned: true, newState: "aspect_signoff", reason: "push recorded" };
}

function signoffTask(wf: WorkflowRecord, aspect: AspectRecord): string {
  return `## Task
Sign off on completed aspect ${aspect.ord}. Verify it meets its acceptance criteria and integrates with previously completed aspects.

## Aspect ${aspect.ord}: ${aspect.title}
${aspect.description}

Acceptance criteria: ${aspect.acceptance_criteria ?? "(none specified)"}

## Implementation location
${wf.workspace_path}/aspects/${aspect.ord}/src/

## Deliverable
Evaluate the finished work against the spec and the merged research. If you approve, emit CONSENSUS_REACHED. If you believe the aspect is incomplete or integration issues exist, emit DISAGREE and list the issues above the status line.`;
}

async function advanceSignoff(wf: WorkflowRecord, d?: Db): Promise<PhaseStepResult> {
  const db = d ?? getDb();
  if (wf.state !== "aspect_signoff") {
    return { transitioned: false, newState: null, reason: `wrong state: ${wf.state}` };
  }
  try {
    ensureBudget(wf);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    transitionWorkflow({
      id: wf.id,
      from: "aspect_signoff",
      to: "error",
      last_error: msg,
      db,
    });
    return { transitioned: true, newState: "error", reason: msg };
  }
  const aspect = loadAspect(wf, db);
  if (!aspect) {
    transitionWorkflow({
      id: wf.id,
      from: "aspect_signoff",
      to: "error",
      last_error: "current aspect not found during signoff",
      db,
    });
    return { transitioned: true, newState: "error", reason: "aspect missing" };
  }

  const task = signoffTask(wf, aspect);
  const [a, b] = await Promise.all([
    runTurn({ role: "sd1", workflow: wf, task, db, phase: "aspect_signoff", aspect_ord: aspect.ord }),
    runTurn({ role: "sd2", workflow: wf, task, db, phase: "aspect_signoff", aspect_ord: aspect.ord }),
  ]);
  if (a.error || b.error) {
    transitionWorkflow({
      id: wf.id,
      from: "aspect_signoff",
      to: "error",
      last_error: `signoff turn error: sd1=${a.error ?? "ok"} sd2=${b.error ?? "ok"}`,
      db,
    });
    return { transitioned: true, newState: "error", reason: "signoff error" };
  }

  const sA = parseStatusLine(a.text);
  const sB = parseStatusLine(b.text);
  if (sA.kind === "consensus" && sB.kind === "consensus") {
    // Aspect complete — advance to next aspect or to final review.
    db.prepare("UPDATE aspects SET state = 'complete', updated_at = ? WHERE id = ?").run(
      Date.now(),
      aspect.id
    );
    // Any remaining pending aspect?
    const next = db
      .prepare(
        "SELECT ord FROM aspects WHERE workflow_id = ? AND state = 'pending' ORDER BY ord LIMIT 1"
      )
      .get(wf.id) as { ord: number } | undefined;
    if (next) {
      transitionWorkflow({
        id: wf.id,
        from: "aspect_signoff",
        to: "aspect_research",
        current_aspect_ord: next.ord,
        db,
      });
      recordWorkflowEvent({
        workflow_id: wf.id,
        aspect_ord: aspect.ord,
        phase: "aspect_signoff",
        kind: "aspect_completed",
        payload: { next_aspect_ord: next.ord },
        db,
      });
      return {
        transitioned: true,
        newState: "aspect_research",
        reason: `signed off; proceeding to aspect ${next.ord}`,
      };
    }
    transitionWorkflow({
      id: wf.id,
      from: "aspect_signoff",
      to: "final_review",
      current_aspect_ord: null,
      db,
    });
    recordWorkflowEvent({
      workflow_id: wf.id,
      aspect_ord: aspect.ord,
      phase: "aspect_signoff",
      kind: "final_aspect_completed",
      db,
    });
    return { transitioned: true, newState: "final_review", reason: "all aspects signed off" };
  }

  // Disagreement: send back to impl to address the review comments.
  db.prepare(
    "UPDATE aspects SET state = 'impl', loop_count = loop_count + 1, updated_at = ? WHERE id = ?"
  ).run(Date.now(), aspect.id);
  transitionWorkflow({ id: wf.id, from: "aspect_signoff", to: "aspect_impl", db });
  recordWorkflowEvent({
    workflow_id: wf.id,
    aspect_ord: aspect.ord,
    phase: "aspect_signoff",
    kind: "signoff_rejected",
    db,
  });
  return {
    transitioned: true,
    newState: "aspect_impl",
    reason: "sys-design rejected signoff; back to impl",
  };
}

export { advanceSignoff };
