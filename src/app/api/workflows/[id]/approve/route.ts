import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { getWorkflow, listAspects, recordWorkflowEvent, transitionWorkflow } from "@/lib/workflows";
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
  if (wf.state !== "awaiting_human_gate") {
    return NextResponse.json(
      { error: `workflow is not at the human gate (state=${wf.state})` },
      { status: 409 }
    );
  }
  const aspects = listAspects(workflowId);
  if (aspects.length === 0) {
    return NextResponse.json(
      { error: "no aspects to approve (decomposition produced nothing)" },
      { status: 409 }
    );
  }
  const ok = transitionWorkflow({
    id: workflowId,
    from: "awaiting_human_gate",
    to: "aspect_research",
    current_aspect_ord: aspects[0]!.ord,
  });
  if (!ok) return NextResponse.json({ error: "transition failed (race)" }, { status: 409 });
  recordWorkflowEvent({
    workflow_id: workflowId,
    phase: "aspect_research",
    kind: "human_gate_approved",
    payload: { aspect_count: aspects.length },
  });
  audit({
    event: "workflow.resumed",
    actorUserId: auth.user.id,
    ip: getRequestIp(req),
    details: { workflow_id: workflowId, gate: "decomposition" },
  });
  return NextResponse.json({ ok: true, state: "aspect_research" });
}
