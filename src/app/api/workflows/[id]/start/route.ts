import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import {
  clearAgentLastText,
  getWorkflow,
  recordWorkflowEvent,
  transitionWorkflow,
} from "@/lib/workflows";
import { anthropicAuthStatus } from "@/lib/anthropic-auth";
import { audit } from "@/lib/audit";
import { getRequestIp } from "@/lib/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseId(s: string): number | null {
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const workflowId = parseId(id);
  if (workflowId === null) return NextResponse.json({ error: "Bad id" }, { status: 400 });
  const wf = getWorkflow(workflowId);
  if (!wf) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Re-check API key at start — the operator may have removed it since
  // workflow creation.
  const authStatus = anthropicAuthStatus();
  if (!authStatus.configured) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is not set on the controller" },
      { status: 412 }
    );
  }

  // Only idea_intake or paused workflows can be (re)started. A workflow
  // already mid-decomposition doesn't need explicit start — the watcher
  // drives it forward.
  if (wf.state !== "idea_intake" && wf.state !== "paused") {
    return NextResponse.json(
      { error: `cannot start workflow in state '${wf.state}'` },
      { status: 409 }
    );
  }
  const ok = transitionWorkflow({
    id: wf.id,
    from: wf.state,
    to: "decomposition",
    consensus_round: 0,
    paused_at: null,
    last_error: null,
  });
  if (!ok) return NextResponse.json({ error: "transition failed (race)" }, { status: 409 });
  // Starting (or restarting) means the sys-design consensus loop begins from
  // round 0 — clear any stale per-agent last_text so we don't carry forward
  // a prior aborted run's context.
  clearAgentLastText(wf.id);
  recordWorkflowEvent({
    workflow_id: wf.id,
    phase: "decomposition",
    kind: "phase_entered",
  });
  audit({
    event: "workflow.started",
    actorUserId: auth.user.id,
    ip: getRequestIp(req),
    details: { workflow_id: wf.id },
  });
  return NextResponse.json({ ok: true, state: "decomposition" });
}
