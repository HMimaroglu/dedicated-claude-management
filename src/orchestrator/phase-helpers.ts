import type { Db } from "@/lib/db";
import {
  getAgent,
  recordWorkflowEvent,
  setAgentLastText,
  type WorkflowRecord,
} from "@/lib/workflows";
import type { Role } from "./roles";
import { runAgent } from "./session";
import { accumulateSessionCost, assertBudgetHeadroom } from "./budget";

export interface AgentTurnResult {
  role: Role;
  text: string;
  error: string | null;
}

// Drives one turn for a given role: runs the SDK call, persists cost + last
// text + session id, records a session_turn event. Never throws — SDK errors
// surface as result.error. Budget guard is assertBudgetHeadroom; callers must
// wrap their overall phase driver to check once before dispatching a batch.
export async function runTurn(opts: {
  role: Role;
  workflow: WorkflowRecord;
  task: string;
  db: Db;
  phase: string;
  aspect_ord?: number | null;
}): Promise<AgentTurnResult> {
  const { role, workflow, task, db, phase, aspect_ord } = opts;
  const prev = getAgent(workflow.id, role, db);
  const resume = prev?.sdk_session_id ?? undefined;

  const out = await runAgent({ role, workflow, task, resume });
  accumulateSessionCost({
    workflow_id: workflow.id,
    role,
    total_cost_usd: out.total_cost_usd,
    input_tokens: out.input_tokens,
    output_tokens: out.output_tokens,
    sdk_session_id: out.session_id || null,
    db,
  });
  setAgentLastText(workflow.id, role, out.text, out.session_id || null, db);
  recordWorkflowEvent({
    workflow_id: workflow.id,
    aspect_ord: aspect_ord ?? null,
    phase,
    actor_role: role,
    kind: "session_turn",
    payload: {
      cost_usd: out.total_cost_usd,
      turns: out.num_turns,
      text_len: out.text.length,
      tool_uses: out.tool_uses.length,
      text_only_violated: out.textOnlyViolated,
      error: out.error,
    },
    db,
  });
  return { role, text: out.text, error: out.error };
}

// Dispatches multiple roles in parallel, returning results in the same order
// as `roles`.
export async function runTurnsParallel(opts: {
  roles: Role[];
  workflow: WorkflowRecord;
  taskFor: (role: Role) => string;
  db: Db;
  phase: string;
  aspect_ord?: number | null;
}): Promise<AgentTurnResult[]> {
  return Promise.all(
    opts.roles.map((role) =>
      runTurn({
        role,
        workflow: opts.workflow,
        task: opts.taskFor(role),
        db: opts.db,
        phase: opts.phase,
        aspect_ord: opts.aspect_ord,
      })
    )
  );
}

// Shared budget pre-check. Throws BudgetExceededError to short-circuit the
// phase; caller is expected to translate that into a state transition to
// 'error'.
export function ensureBudget(wf: WorkflowRecord): void {
  assertBudgetHeadroom(wf);
}
