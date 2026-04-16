import type { Db } from "@/lib/db";
import { getDb } from "@/lib/db";
import {
  getWorkflow,
  recordWorkflowEvent,
  transitionWorkflow,
  type WorkflowRecord,
  type WorkflowState,
} from "@/lib/workflows";
import { advanceDecomposition } from "./phases/decomposition";
import { advanceResearch } from "./phases/research";
import { advanceResearchReview } from "./phases/research-review";
import { advanceImpl } from "./phases/impl";
import { overBudget } from "./budget";

// Which states should the watcher attempt to advance on a tick? Terminal +
// paused + waiting states are skipped.
const ADVANCEABLE: WorkflowState[] = [
  "idea_intake",
  "decomposition",
  "aspect_research",
  "aspect_research_review",
  "aspect_impl",
  "aspect_audit",
  "aspect_push",
  "aspect_signoff",
  "final_review",
];

export function canAdvance(wf: WorkflowRecord): boolean {
  return ADVANCEABLE.includes(wf.state);
}

export interface AdvanceResult {
  workflow_id: number;
  from: WorkflowState;
  to: WorkflowState;
  reason: string;
}

// Advances a single workflow by one atomic unit of work. Callers are expected
// to hold the per-workflow lock (see workflow-lock.ts).
export async function advanceWorkflow(
  workflow_id: number,
  d?: Db
): Promise<AdvanceResult | null> {
  const db = d ?? getDb();
  const wf = getWorkflow(workflow_id, db);
  if (!wf) return null;
  if (!canAdvance(wf)) return null;

  // Hard stop if budget is exhausted.
  if (overBudget(wf)) {
    transitionWorkflow({
      id: wf.id,
      from: wf.state,
      to: "error",
      last_error: `budget exhausted ($${wf.spent_usd.toFixed(4)} / $${wf.budget_usd.toFixed(2)})`,
      db,
    });
    return { workflow_id, from: wf.state, to: "error", reason: "budget exhausted" };
  }

  const fromState = wf.state;

  // The idea_intake state is trivial: whenever the operator starts the
  // workflow, we move into decomposition. (The /start route does this too;
  // this handler covers restart/recovery paths.)
  if (wf.state === "idea_intake") {
    transitionWorkflow({
      id: wf.id,
      from: "idea_intake",
      to: "decomposition",
      consensus_round: 0,
      db,
    });
    recordWorkflowEvent({
      workflow_id: wf.id,
      phase: "decomposition",
      kind: "phase_entered",
      db,
    });
    return { workflow_id, from: fromState, to: "decomposition", reason: "started" };
  }

  if (wf.state === "decomposition") {
    const res = await advanceDecomposition(wf, db);
    return { workflow_id, from: fromState, to: (res.newState ?? wf.state) as WorkflowState, reason: res.reason };
  }
  if (wf.state === "aspect_research") {
    const res = await advanceResearch(wf, db);
    return { workflow_id, from: fromState, to: (res.newState ?? wf.state) as WorkflowState, reason: res.reason };
  }
  if (wf.state === "aspect_research_review") {
    const res = await advanceResearchReview(wf, db);
    return { workflow_id, from: fromState, to: (res.newState ?? wf.state) as WorkflowState, reason: res.reason };
  }
  if (wf.state === "aspect_impl") {
    const res = await advanceImpl(wf, db);
    return { workflow_id, from: fromState, to: (res.newState ?? wf.state) as WorkflowState, reason: res.reason };
  }

  // Phases 5-6 (audit/push/signoff/final) land in later slices. For states
  // not yet wired up, we park the workflow rather than erroring out.
  return {
    workflow_id,
    from: fromState,
    to: fromState,
    reason: `no driver for state '${fromState}' yet (future phase)`,
  };
}
