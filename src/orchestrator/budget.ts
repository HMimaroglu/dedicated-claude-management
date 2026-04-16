import type { Db } from "@/lib/db";
import { getDb } from "@/lib/db";
import type { WorkflowRecord } from "@/lib/workflows";
import { getWorkflow, recordWorkflowEvent } from "@/lib/workflows";
import type { Role } from "./roles";

export class BudgetExceededError extends Error {
  constructor(
    public readonly workflow_id: number,
    public readonly spent: number,
    public readonly budget: number
  ) {
    super(`workflow ${workflow_id} budget exceeded: $${spent.toFixed(4)} / $${budget.toFixed(2)}`);
    this.name = "BudgetExceededError";
  }
}

// Checks whether a workflow still has budget headroom. Throws
// BudgetExceededError if spent >= budget. Call this BEFORE dispatching any new
// SDK session.
//
// Known behavior: a single advance may fan out to 2-3 parallel SDK calls
// (pairs of sys-design/research/dev or the 3-auditor panel). The pre-check
// sees stale `spent_usd` until the batch completes, so actual cost can
// overshoot the cap by up to one batch's worth before the *next* tick
// transitions the workflow to 'error'. Budgets should be set with that
// overshoot margin in mind.
export function assertBudgetHeadroom(wf: WorkflowRecord): void {
  if (wf.spent_usd >= wf.budget_usd) {
    throw new BudgetExceededError(wf.id, wf.spent_usd, wf.budget_usd);
  }
}

// Atomically adds `amount` USD to both the per-agent and per-workflow running
// totals. Returns the updated WorkflowRecord. Recording cost is independent of
// budget enforcement — we ALWAYS add the cost, even if it overshoots the cap,
// so the DB accurately reflects spend.
export function accumulateSessionCost(opts: {
  workflow_id: number;
  role: Role;
  total_cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  sdk_session_id?: string | null;
  db?: Db;
}): WorkflowRecord {
  const db = opts.db ?? getDb();
  const now = Date.now();
  const amount = Number.isFinite(opts.total_cost_usd) ? Math.max(0, opts.total_cost_usd) : 0;
  const inTok = Number.isFinite(opts.input_tokens) ? Math.max(0, opts.input_tokens) : 0;
  const outTok = Number.isFinite(opts.output_tokens) ? Math.max(0, opts.output_tokens) : 0;

  const before = getWorkflow(opts.workflow_id, db);
  if (!before) throw new Error(`workflow ${opts.workflow_id} not found`);

  db.transaction(() => {
    // Upsert workflow_agents row for this role.
    db.prepare(
      `INSERT INTO workflow_agents (
         workflow_id, role, sdk_session_id, total_cost_usd,
         total_input_tokens, total_output_tokens,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workflow_id, role) DO UPDATE SET
         sdk_session_id = COALESCE(excluded.sdk_session_id, workflow_agents.sdk_session_id),
         total_cost_usd = workflow_agents.total_cost_usd + excluded.total_cost_usd,
         total_input_tokens = workflow_agents.total_input_tokens + excluded.total_input_tokens,
         total_output_tokens = workflow_agents.total_output_tokens + excluded.total_output_tokens,
         updated_at = excluded.updated_at`
    ).run(
      opts.workflow_id,
      opts.role,
      opts.sdk_session_id ?? null,
      amount,
      inTok,
      outTok,
      now,
      now
    );

    db.prepare(
      `UPDATE workflows SET spent_usd = spent_usd + ?, updated_at = ? WHERE id = ?`
    ).run(amount, now, opts.workflow_id);
  })();

  const updated = getWorkflow(opts.workflow_id, db);
  if (!updated) {
    throw new Error(`workflow ${opts.workflow_id} disappeared during cost accounting`);
  }

  // Emit budget_exceeded exactly once on the transition from under→over to
  // avoid log noise.
  if (before.spent_usd < before.budget_usd && updated.spent_usd >= updated.budget_usd) {
    recordWorkflowEvent({
      workflow_id: opts.workflow_id,
      phase: updated.state,
      actor_role: opts.role,
      kind: "budget_exceeded",
      payload: { spent_usd: updated.spent_usd, budget_usd: updated.budget_usd },
      db,
    });
  }
  return updated;
}

export function overBudget(wf: WorkflowRecord): boolean {
  return wf.spent_usd >= wf.budget_usd;
}
