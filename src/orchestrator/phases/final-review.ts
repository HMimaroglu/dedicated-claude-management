import type { Db } from "@/lib/db";
import { getDb } from "@/lib/db";
import {
  listAspects,
  recordWorkflowEvent,
  transitionWorkflow,
  type WorkflowRecord,
} from "@/lib/workflows";
import { parseStatusLine } from "../plan-parser";
import { ensureBudget, runTurn } from "../phase-helpers";

export interface PhaseStepResult {
  transitioned: boolean;
  newState: WorkflowRecord["state"] | null;
  reason: string;
}

function finalReviewTask(wf: WorkflowRecord, summary: string): string {
  return `## Task
Conduct a final full-system review of the completed project. This is not a rubber stamp — evaluate integration between aspects, architectural coherence, completeness against the original idea, edge cases across aspects, and overall quality.

## Original idea
${wf.idea}

## Aspect summary
${summary}

## Workspace
Files under: ${wf.workspace_path}/aspects/*/src/ (use Read/Glob/Grep — no writes)

## Deliverable
A structured report ending with a status line. CONSENSUS_REACHED if you approve the project as complete; DISAGREE if integration issues or gaps remain.`;
}

export async function advanceFinalReview(
  wf: WorkflowRecord,
  d?: Db
): Promise<PhaseStepResult> {
  const db = d ?? getDb();
  if (wf.state !== "final_review") {
    return { transitioned: false, newState: null, reason: `wrong state: ${wf.state}` };
  }
  try {
    ensureBudget(wf);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    transitionWorkflow({ id: wf.id, from: "final_review", to: "error", last_error: msg, db });
    return { transitioned: true, newState: "error", reason: msg };
  }

  const aspects = listAspects(wf.id, db);
  const summary = aspects
    .map(
      (a) =>
        `- Aspect ${a.ord}: ${a.title} — ${a.state === "complete" ? "complete" : a.state}`
    )
    .join("\n");

  const task = finalReviewTask(wf, summary);
  const [a, b] = await Promise.all([
    runTurn({ role: "sd1", workflow: wf, task, db, phase: "final_review" }),
    runTurn({ role: "sd2", workflow: wf, task, db, phase: "final_review" }),
  ]);
  if (a.error || b.error) {
    transitionWorkflow({
      id: wf.id,
      from: "final_review",
      to: "error",
      last_error: `final review turn error: sd1=${a.error ?? "ok"} sd2=${b.error ?? "ok"}`,
      db,
    });
    return { transitioned: true, newState: "error", reason: "final review error" };
  }
  const sA = parseStatusLine(a.text);
  const sB = parseStatusLine(b.text);
  if (sA.kind === "consensus" && sB.kind === "consensus") {
    transitionWorkflow({
      id: wf.id,
      from: "final_review",
      to: "complete",
      completed_at: Date.now(),
      db,
    });
    recordWorkflowEvent({
      workflow_id: wf.id,
      phase: "final_review",
      kind: "workflow_completed",
      db,
    });
    return { transitioned: true, newState: "complete", reason: "final review approved" };
  }
  // Disagreement at final: return the workflow to aspect_signoff of the last
  // completed aspect so operator can manually inspect. For MVP we mark as
  // error with a note — a richer orchestrator would pick the flagged aspect.
  transitionWorkflow({
    id: wf.id,
    from: "final_review",
    to: "error",
    last_error: "final review rejected; manual intervention required",
    db,
  });
  return {
    transitioned: true,
    newState: "error",
    reason: "final review rejected",
  };
}
