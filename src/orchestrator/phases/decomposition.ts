import type { Db } from "@/lib/db";
import { getDb } from "@/lib/db";
import {
  getAgent,
  insertAspects,
  recordWorkflowEvent,
  setAgentLastText,
  transitionWorkflow,
  type WorkflowRecord,
} from "@/lib/workflows";
import { assertBudgetHeadroom, accumulateSessionCost } from "../budget";
import { runAgent } from "../session";
import { parsePlan, parseStatusLine, plansAlign, validateParsedPlan } from "../plan-parser";

export const DECOMPOSITION_MAX_ROUNDS = 5;

function initialTask(idea: string): string {
  return `## Task
Decompose the following project idea into an ordered list of implementable aspects. Produce the most natural granularity — neither one giant aspect nor dozens of trivial ones.

## Idea
${idea}

## Deliverable
Produce exactly one \`## Plan\` section followed by aspects using this format:

## Plan

### Aspect 1: [short descriptive title]
- Description: 1-2 sentences describing scope and intent
- Depends on: list of earlier aspect numbers, or \`none\`
- Acceptance criteria: 1-2 sentences describing what "done" looks like

### Aspect 2: [short title]
- Description: ...
- Depends on: [1]
- Acceptance criteria: ...

Rules for aspect numbering:
- Aspects are numbered 1..N in implementation order.
- An aspect may depend only on earlier-numbered aspects.
- 1 to 50 aspects total.

End your message with a status line (see protocol).`;
}

function converseTask(opts: {
  round: number;
  peerPlan: string;
  yourPrevious: string;
}): string {
  return `## Task
Your peer (the other System Design agent) proposed a plan. Review it, compare to your own prior plan, and produce an updated plan that reflects your best-considered position for this round.

If you have converged — i.e., you now fully agree with the peer's structure — reproduce their plan verbatim (same aspect ords and titles) and emit \`STATUS: CONSENSUS_REACHED\`. If you believe further discussion is necessary, produce your refined plan and emit \`STATUS: NEED_ROUND\`. If you believe the process cannot converge, emit \`STATUS: DEADLOCK\`.

This is round ${opts.round} of ${DECOMPOSITION_MAX_ROUNDS} maximum rounds. Lean toward convergence unless there is a substantive architectural disagreement.

## Peer's plan
${opts.peerPlan}

## Your previous plan
${opts.yourPrevious}

## Deliverable
Output one \`## Plan\` section exactly as before, then the status line.`;
}

async function runSysDesignTurn(opts: {
  role: "sd1" | "sd2";
  workflow: WorkflowRecord;
  task: string;
  db: Db;
}): Promise<{ text: string; error: string | null }> {
  const { role, workflow, task, db } = opts;
  const prevAgent = getAgent(workflow.id, role, db);
  const resume = prevAgent?.sdk_session_id ?? undefined;

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
    phase: "decomposition",
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
  return { text: out.text, error: out.error };
}

export interface DecompositionStepResult {
  transitioned: boolean;
  newState: WorkflowRecord["state"] | null;
  reason: string;
}

// Runs ONE round of the decomposition consensus loop. Called repeatedly by
// the orchestrator watcher until the workflow transitions out of
// `decomposition`.
export async function advanceDecomposition(
  workflow: WorkflowRecord,
  d?: Db
): Promise<DecompositionStepResult> {
  const db = d ?? getDb();

  // Safety: refuse to run if the workflow isn't actually in decomposition.
  // Callers (orchestrator / tests) may pass a stale record after a concurrent
  // transition; re-running would double-insert aspects etc.
  if (workflow.state !== "decomposition") {
    return {
      transitioned: false,
      newState: null,
      reason: `workflow state is '${workflow.state}', not 'decomposition'`,
    };
  }

  try {
    assertBudgetHeadroom(workflow);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    transitionWorkflow({ id: workflow.id, from: "decomposition", to: "error", last_error: msg, db });
    return { transitioned: true, newState: "error", reason: msg };
  }

  const round = workflow.consensus_round;
  const agentA = getAgent(workflow.id, "sd1", db);
  const agentB = getAgent(workflow.id, "sd2", db);

  // Round 0: both agents produce independent plans.
  if (round === 0 || !agentA?.last_text || !agentB?.last_text) {
    const task = initialTask(workflow.idea);
    recordWorkflowEvent({
      workflow_id: workflow.id,
      phase: "decomposition",
      kind: "round_start",
      payload: { round },
      db,
    });
    const [a, b] = await Promise.all([
      runSysDesignTurn({ role: "sd1", workflow, task, db }),
      runSysDesignTurn({ role: "sd2", workflow, task, db }),
    ]);
    if (a.error || b.error) {
      const msg = `decomposition turn error: sd1=${a.error ?? "ok"} sd2=${b.error ?? "ok"}`;
      transitionWorkflow({
        id: workflow.id,
        from: "decomposition",
        to: "error",
        last_error: msg,
        db,
      });
      return { transitioned: true, newState: "error", reason: msg };
    }
    transitionWorkflow({
      id: workflow.id,
      from: "decomposition",
      to: "decomposition",
      consensus_round: 1,
      db,
    });
    return {
      transitioned: false,
      newState: null,
      reason: "initial plans produced; awaiting next round",
    };
  }

  if (round >= DECOMPOSITION_MAX_ROUNDS) {
    const msg = `decomposition did not converge after ${DECOMPOSITION_MAX_ROUNDS} rounds`;
    transitionWorkflow({
      id: workflow.id,
      from: "decomposition",
      to: "error",
      last_error: msg,
      db,
    });
    return { transitioned: true, newState: "error", reason: msg };
  }

  // Check current outputs for convergence before spending more tokens.
  const statusA = parseStatusLine(agentA.last_text);
  const statusB = parseStatusLine(agentB.last_text);
  const planA = parsePlan(agentA.last_text);
  const planB = parsePlan(agentB.last_text);

  if (
    statusA.kind === "consensus" &&
    statusB.kind === "consensus" &&
    plansAlign(planA, planB)
  ) {
    const verr = validateParsedPlan(planA);
    if (verr) {
      transitionWorkflow({
        id: workflow.id,
        from: "decomposition",
        to: "error",
        last_error: `consensus reached but plan invalid: ${verr}`,
        db,
      });
      return { transitioned: true, newState: "error", reason: verr };
    }
    const nextState = workflow.require_human_gate ? "awaiting_human_gate" : "aspect_research";
    // Wrap aspect insertion + state transition in one transaction so a failed
    // transition (racing operator pause, etc.) doesn't leave orphan aspects.
    let committed = false;
    const commit = db.transaction(() => {
      insertAspects(workflow.id, planA, db);
      committed = transitionWorkflow({
        id: workflow.id,
        from: "decomposition",
        to: nextState,
        plan_md: agentA.last_text,
        current_aspect_ord: nextState === "aspect_research" ? 1 : null,
        db,
      });
      if (!committed) {
        throw new Error("workflow state changed concurrently; aborting aspect insert");
      }
    });
    try {
      commit();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { transitioned: false, newState: null, reason: msg };
    }
    recordWorkflowEvent({
      workflow_id: workflow.id,
      phase: "decomposition",
      kind: "consensus_reached",
      payload: { aspects: planA.length },
      db,
    });
    return { transitioned: true, newState: nextState, reason: "consensus reached" };
  }

  if (statusA.kind === "deadlock" || statusB.kind === "deadlock") {
    const msg = `sys-design agent reported deadlock`;
    transitionWorkflow({
      id: workflow.id,
      from: "decomposition",
      to: "error",
      last_error: msg,
      db,
    });
    return { transitioned: true, newState: "error", reason: msg };
  }

  // Another discussion round.
  recordWorkflowEvent({
    workflow_id: workflow.id,
    phase: "decomposition",
    kind: "round_start",
    payload: { round },
    db,
  });
  const taskA = converseTask({
    round,
    peerPlan: agentB.last_text,
    yourPrevious: agentA.last_text,
  });
  const taskB = converseTask({
    round,
    peerPlan: agentA.last_text,
    yourPrevious: agentB.last_text,
  });
  const [a, b] = await Promise.all([
    runSysDesignTurn({ role: "sd1", workflow, task: taskA, db }),
    runSysDesignTurn({ role: "sd2", workflow, task: taskB, db }),
  ]);
  if (a.error || b.error) {
    const msg = `decomposition turn error: sd1=${a.error ?? "ok"} sd2=${b.error ?? "ok"}`;
    transitionWorkflow({
      id: workflow.id,
      from: "decomposition",
      to: "error",
      last_error: msg,
      db,
    });
    return { transitioned: true, newState: "error", reason: msg };
  }
  transitionWorkflow({
    id: workflow.id,
    from: "decomposition",
    to: "decomposition",
    consensus_round: round + 1,
    db,
  });
  return {
    transitioned: false,
    newState: null,
    reason: `round ${round + 1} dispatched; awaiting next tick`,
  };
}
