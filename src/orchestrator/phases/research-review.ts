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

export interface ReviewStepResult {
  transitioned: boolean;
  newState: WorkflowRecord["state"] | null;
  reason: string;
}

function reviewTask(wf: WorkflowRecord, aspect: AspectRecord): string {
  return `## Task
Review the merged research document for aspect ${aspect.ord}. You are the gatekeeper before dev agents begin implementation.

## Project idea
${wf.idea}

## Aspect ${aspect.ord}: ${aspect.title}
${aspect.description}

Acceptance criteria: ${aspect.acceptance_criteria ?? "(none specified)"}

## Merged research
${aspect.research_md ?? "(empty)"}

## Deliverable
State whether the research is sufficient for implementation. If issues exist, enumerate them (specific, actionable).

End with status line:
- CONSENSUS_REACHED if you approve.
- DISAGREE if significant issues remain (list them above the status line).`;
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

// One-shot review: both sys-design agents look at the merged research. If
// both approve (CONSENSUS_REACHED), advance to impl. If either disagrees, the
// aspect goes back to aspect_research for another round (loop_count
// preserved; research.ts will run cross-exam again).
export async function advanceResearchReview(
  wf: WorkflowRecord,
  d?: Db
): Promise<ReviewStepResult> {
  const db = d ?? getDb();
  if (wf.state !== "aspect_research_review") {
    return { transitioned: false, newState: null, reason: `wrong state: ${wf.state}` };
  }

  try {
    ensureBudget(wf);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    transitionWorkflow({
      id: wf.id,
      from: "aspect_research_review",
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
      from: "aspect_research_review",
      to: "error",
      last_error: "current aspect not found during research review",
      db,
    });
    return { transitioned: true, newState: "error", reason: "aspect missing" };
  }

  const task = reviewTask(wf, aspect);
  const [a, b] = await Promise.all([
    runTurn({ role: "sd1", workflow: wf, task, db, phase: "aspect_research_review", aspect_ord: aspect.ord }),
    runTurn({ role: "sd2", workflow: wf, task, db, phase: "aspect_research_review", aspect_ord: aspect.ord }),
  ]);

  if (a.error || b.error) {
    const msg = `research review turn error: sd1=${a.error ?? "ok"} sd2=${b.error ?? "ok"}`;
    transitionWorkflow({
      id: wf.id,
      from: "aspect_research_review",
      to: "error",
      last_error: msg,
      db,
    });
    return { transitioned: true, newState: "error", reason: msg };
  }

  const sA = parseStatusLine(a.text);
  const sB = parseStatusLine(b.text);
  const bothApprove = sA.kind === "consensus" && sB.kind === "consensus";

  if (bothApprove) {
    db.prepare("UPDATE aspects SET state = 'impl', updated_at = ? WHERE id = ?").run(
      Date.now(),
      aspect.id
    );
    transitionWorkflow({
      id: wf.id,
      from: "aspect_research_review",
      to: "aspect_impl",
      db,
    });
    recordWorkflowEvent({
      workflow_id: wf.id,
      aspect_ord: aspect.ord,
      phase: "aspect_research_review",
      kind: "review_approved",
      db,
    });
    return { transitioned: true, newState: "aspect_impl", reason: "sys-design approved research" };
  }

  // Disagreement: send back to research with a fresh round.
  db.prepare("UPDATE aspects SET state = 'research', updated_at = ? WHERE id = ?").run(
    Date.now(),
    aspect.id
  );
  transitionWorkflow({
    id: wf.id,
    from: "aspect_research_review",
    to: "aspect_research",
    db,
  });
  recordWorkflowEvent({
    workflow_id: wf.id,
    aspect_ord: aspect.ord,
    phase: "aspect_research_review",
    kind: "review_rejected",
    payload: { sd1: sA.kind, sd2: sB.kind },
    db,
  });
  return {
    transitioned: true,
    newState: "aspect_research",
    reason: "sys-design rejected research; back to research round",
  };
}
