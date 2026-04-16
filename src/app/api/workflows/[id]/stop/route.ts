import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { getWorkflow, recordWorkflowEvent, transitionWorkflow } from "@/lib/workflows";
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
  if (wf.state === "complete" || wf.state === "error" || wf.state === "paused") {
    return NextResponse.json({ ok: true, state: wf.state });
  }
  const ok = transitionWorkflow({
    id: workflowId,
    from: wf.state,
    to: "paused",
    paused_at: Date.now(),
  });
  if (!ok) return NextResponse.json({ error: "transition failed (race)" }, { status: 409 });
  recordWorkflowEvent({
    workflow_id: workflowId,
    phase: wf.state,
    kind: "paused_by_operator",
  });
  audit({
    event: "workflow.paused",
    actorUserId: auth.user.id,
    ip: getRequestIp(req),
    details: { workflow_id: workflowId, prior_state: wf.state },
  });
  return NextResponse.json({ ok: true, state: "paused" });
}
