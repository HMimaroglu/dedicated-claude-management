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
import { parseStatusLine } from "../plan-parser";
import { ensureBudget, runTurnsParallel } from "../phase-helpers";

// Research runs at most these rounds per aspect: one independent round, then
// one cross-examination round. The aspect's loop_count tracks how many
// research attempts we have made — if a later audit sends us back here with
// a new question, we can reuse this counter.
export const MAX_RESEARCH_ROUNDS = 3;

export interface ResearchStepResult {
  transitioned: boolean;
  newState: WorkflowRecord["state"] | null;
  reason: string;
}

function independentTask(idea: string, aspect: AspectRecord): string {
  return `## Task
Research aspect ${aspect.ord} of the project independently. Do NOT look at your peer's output.

## Project context
${idea}

## Aspect ${aspect.ord}: ${aspect.title}
${aspect.description}

Acceptance criteria: ${aspect.acceptance_criteria ?? "(none specified)"}

## Deliverable
Produce a well-structured markdown research document covering:
- Background
- Design considerations / trade-offs relevant to this aspect
- Any cited sources (URLs, papers, docs) with a "Sources" section at the end

End with a status line. Use RESEARCH_READY only if you are confident the findings need no further investigation.`;
}

function crossExamTask(idea: string, aspect: AspectRecord, peerText: string): string {
  return `## Task
Cross-examine your peer's research for aspect ${aspect.ord}. Challenge sources, test logical chains, check statistics, look for gaps.

## Project context
${idea}

## Aspect ${aspect.ord}: ${aspect.title}
${aspect.description}

## Peer's research
${peerText}

## Deliverable
Produce a structured critique: enumerate specific issues (claim → issue → evidence → suggested resolution). If you find no substantive issues, say so explicitly.

End with a status line. Use RESEARCH_READY only if, after this critique, you believe the merged research is ready for sys-design review.`;
}

function mergeResearch(textR1: string, textR2: string): string {
  return `# Merged research\n\n## From R1\n\n${textR1}\n\n---\n\n## From R2 (cross-exam included)\n\n${textR2}\n`;
}

export async function advanceResearch(wf: WorkflowRecord, d?: Db): Promise<ResearchStepResult> {
  const db = d ?? getDb();
  if (wf.state !== "aspect_research") {
    return { transitioned: false, newState: null, reason: `wrong state: ${wf.state}` };
  }
  if (wf.current_aspect_ord === null) {
    transitionWorkflow({
      id: wf.id,
      from: "aspect_research",
      to: "error",
      last_error: "no current aspect during research",
      db,
    });
    return { transitioned: true, newState: "error", reason: "no current_aspect_ord" };
  }

  try {
    ensureBudget(wf);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    transitionWorkflow({
      id: wf.id,
      from: "aspect_research",
      to: "error",
      last_error: msg,
      db,
    });
    return { transitioned: true, newState: "error", reason: msg };
  }

  const aspect = db
    .prepare("SELECT * FROM aspects WHERE workflow_id = ? AND ord = ?")
    .get(wf.id, wf.current_aspect_ord) as Record<string, unknown> | undefined;
  if (!aspect) {
    transitionWorkflow({
      id: wf.id,
      from: "aspect_research",
      to: "error",
      last_error: `aspect ord ${wf.current_aspect_ord} not found`,
      db,
    });
    return { transitioned: true, newState: "error", reason: "aspect missing" };
  }

  const aspectRecord: AspectRecord = {
    id: aspect.id as number,
    workflow_id: aspect.workflow_id as number,
    ord: aspect.ord as number,
    title: aspect.title as string,
    description: aspect.description as string,
    depends_on: JSON.parse((aspect.depends_on as string) || "[]"),
    acceptance_criteria: (aspect.acceptance_criteria as string | null) ?? null,
    state: aspect.state as AspectRecord["state"],
    research_md: (aspect.research_md as string | null) ?? null,
    loop_count: aspect.loop_count as number,
    created_at: aspect.created_at as number,
    updated_at: aspect.updated_at as number,
  };

  const r1 = getAgent(wf.id, "r1", db);
  const r2 = getAgent(wf.id, "r2", db);
  const round = aspectRecord.loop_count;

  // Round 0: independent research.
  if (round === 0 || !r1?.last_text || !r2?.last_text) {
    await runTurnsParallel({
      roles: ["r1", "r2"],
      workflow: wf,
      taskFor: () => independentTask(wf.idea, aspectRecord),
      db,
      phase: "aspect_research",
      aspect_ord: aspectRecord.ord,
    });
    db.prepare("UPDATE aspects SET loop_count = 1, state = 'research', updated_at = ? WHERE id = ?").run(
      Date.now(),
      aspectRecord.id
    );
    return { transitioned: false, newState: null, reason: "independent research dispatched" };
  }

  if (round >= MAX_RESEARCH_ROUNDS) {
    transitionWorkflow({
      id: wf.id,
      from: "aspect_research",
      to: "error",
      last_error: `research did not converge after ${MAX_RESEARCH_ROUNDS} rounds`,
      db,
    });
    return { transitioned: true, newState: "error", reason: "research rounds exhausted" };
  }

  // After independent round, the cross-exam round may already have happened.
  // Check both agents' status lines.
  const statusA = parseStatusLine(r1.last_text);
  const statusB = parseStatusLine(r2.last_text);
  if (statusA.kind === "research_ready" && statusB.kind === "research_ready") {
    // Merge and write to workspace + DB.
    const merged = mergeResearch(r1.last_text, r2.last_text);
    try {
      const dir = path.join(wf.workspace_path, "aspects", String(aspectRecord.ord));
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(dir, "research-merged.md"), merged, { mode: 0o600 });
    } catch {
      // best-effort workspace write; DB copy is authoritative
    }
    db.prepare(
      "UPDATE aspects SET research_md = ?, state = 'review', updated_at = ? WHERE id = ?"
    ).run(merged, Date.now(), aspectRecord.id);
    transitionWorkflow({
      id: wf.id,
      from: "aspect_research",
      to: "aspect_research_review",
      db,
    });
    recordWorkflowEvent({
      workflow_id: wf.id,
      aspect_ord: aspectRecord.ord,
      phase: "aspect_research",
      kind: "research_ready",
      payload: { round, merged_chars: merged.length },
      db,
    });
    return { transitioned: true, newState: "aspect_research_review", reason: "research ready" };
  }

  // Cross-exam round.
  await runTurnsParallel({
    roles: ["r1", "r2"],
    workflow: wf,
    taskFor: (role) =>
      crossExamTask(
        wf.idea,
        aspectRecord,
        role === "r1" ? (r2.last_text ?? "") : (r1.last_text ?? "")
      ),
    db,
    phase: "aspect_research",
    aspect_ord: aspectRecord.ord,
  });
  db.prepare("UPDATE aspects SET loop_count = ?, updated_at = ? WHERE id = ?").run(
    round + 1,
    Date.now(),
    aspectRecord.id
  );
  return { transitioned: false, newState: null, reason: `cross-exam round ${round + 1} dispatched` };
}
