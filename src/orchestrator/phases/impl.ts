import path from "node:path";
import { mkdirSync } from "node:fs";
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

export interface ImplStepResult {
  transitioned: boolean;
  newState: WorkflowRecord["state"] | null;
  reason: string;
}

function implTask(opts: {
  wf: WorkflowRecord;
  aspect: AspectRecord;
  aspectDir: string;
  isDiv: "d1" | "d2";
  peerLastText?: string | null;
}): string {
  const { wf, aspect, aspectDir, peerLastText } = opts;
  return `## Task
Implement aspect ${aspect.ord} of the project. You are Dev Agent ${opts.isDiv === "d1" ? "A" : "B"} — collaborate with Agent ${opts.isDiv === "d1" ? "B" : "A"}.

## Aspect ${aspect.ord}: ${aspect.title}
${aspect.description}

Acceptance criteria: ${aspect.acceptance_criteria ?? "(none specified)"}

## Merged research
${aspect.research_md ?? "(empty)"}

## Workspace
Your working directory is already set to: ${wf.workspace_path}
Write all code under the subdirectory: aspects/${aspect.ord}/src/
The tooling is: Read, Write, Edit, Glob, Grep. **No Bash for MVP** — all implementation is file-based. If you believe shell access is required, describe why in your "Changes" note so the operator can grant it manually.

## Peer's most recent note (if any)
${peerLastText ?? "(none yet — this is round 1)"}

## Deliverable
Make concrete progress on the implementation. End with a short \`## Changes\` section listing files touched and why. Finish with one of:
- \`STATUS: IMPL_READY_FOR_AUDIT\` — complete, ready for auditors
- \`STATUS: NEED_MORE_TURNS\` — substantive work remains

Project workspace root on disk: ${aspectDir}`;
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

export async function advanceImpl(wf: WorkflowRecord, d?: Db): Promise<ImplStepResult> {
  const db = d ?? getDb();
  if (wf.state !== "aspect_impl") {
    return { transitioned: false, newState: null, reason: `wrong state: ${wf.state}` };
  }

  try {
    ensureBudget(wf);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    transitionWorkflow({ id: wf.id, from: "aspect_impl", to: "error", last_error: msg, db });
    return { transitioned: true, newState: "error", reason: msg };
  }

  const aspect = loadAspect(wf, db);
  if (!aspect) {
    transitionWorkflow({
      id: wf.id,
      from: "aspect_impl",
      to: "error",
      last_error: "current aspect not found during impl",
      db,
    });
    return { transitioned: true, newState: "error", reason: "aspect missing" };
  }

  const aspectDir = path.join(wf.workspace_path, "aspects", String(aspect.ord));
  try {
    mkdirSync(path.join(aspectDir, "src"), { recursive: true, mode: 0o700 });
  } catch {
    // best-effort
  }

  const max = wf.max_iterations_per_aspect;
  const round = aspect.loop_count;

  if (round >= max) {
    transitionWorkflow({
      id: wf.id,
      from: "aspect_impl",
      to: "error",
      last_error: `implementation did not complete after ${max} rounds`,
      db,
    });
    return { transitioned: true, newState: "error", reason: "impl rounds exhausted" };
  }

  // Check existing outputs for readiness before dispatching another round.
  const d1 = getAgent(wf.id, "d1", db);
  const d2 = getAgent(wf.id, "d2", db);
  if (d1?.last_text && d2?.last_text) {
    const s1 = parseStatusLine(d1.last_text);
    const s2 = parseStatusLine(d2.last_text);
    // Dev roles emit IMPL_READY_FOR_AUDIT; parseStatusLine maps it as unknown
    // (no dedicated kind); match against the raw text line instead.
    const ready = (text: string) => /STATUS:\s*IMPL_READY_FOR_AUDIT/i.test(text);
    if (ready(d1.last_text) && ready(d2.last_text) && s1.raw !== undefined && s2.raw !== undefined) {
      db.prepare("UPDATE aspects SET state = 'audit', updated_at = ? WHERE id = ?").run(
        Date.now(),
        aspect.id
      );
      transitionWorkflow({
        id: wf.id,
        from: "aspect_impl",
        to: "aspect_audit",
        db,
      });
      recordWorkflowEvent({
        workflow_id: wf.id,
        aspect_ord: aspect.ord,
        phase: "aspect_impl",
        kind: "impl_ready_for_audit",
        payload: { rounds_used: round },
        db,
      });
      return { transitioned: true, newState: "aspect_audit", reason: "both devs ready for audit" };
    }
  }

  // Another impl round.
  await runTurnsParallel({
    roles: ["d1", "d2"],
    workflow: wf,
    taskFor: (role) =>
      implTask({
        wf,
        aspect,
        aspectDir,
        isDiv: role as "d1" | "d2",
        peerLastText: role === "d1" ? (d2?.last_text ?? null) : (d1?.last_text ?? null),
      }),
    db,
    phase: "aspect_impl",
    aspect_ord: aspect.ord,
  });
  db.prepare("UPDATE aspects SET loop_count = ?, updated_at = ? WHERE id = ?").run(
    round + 1,
    Date.now(),
    aspect.id
  );
  return {
    transitioned: false,
    newState: null,
    reason: `impl round ${round + 1} dispatched`,
  };
}
