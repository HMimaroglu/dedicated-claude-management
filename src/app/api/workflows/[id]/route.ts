import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import {
  deleteWorkflow,
  getWorkflow,
  listAspects,
  recentWorkflowEvents,
  removeWorkflowWorkspace,
} from "@/lib/workflows";
import { audit } from "@/lib/audit";
import { getRequestIp } from "@/lib/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseId(s: string): number | null {
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const workflowId = parseId(id);
  if (workflowId === null) return NextResponse.json({ error: "Bad id" }, { status: 400 });
  const workflow = getWorkflow(workflowId);
  if (!workflow) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({
    workflow,
    aspects: listAspects(workflowId),
    events: recentWorkflowEvents(workflowId, 200),
  });
}

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const workflowId = parseId(id);
  if (workflowId === null) return NextResponse.json({ error: "Bad id" }, { status: 400 });

  const workflow = getWorkflow(workflowId);
  if (!workflow) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // When Phase 2+ lands this endpoint also needs to stop running orchestrator
  // sessions. For now it only tears down DB rows + workspace directory.
  const ok = deleteWorkflow(workflowId);
  if (!ok) return NextResponse.json({ error: "delete failed" }, { status: 500 });
  removeWorkflowWorkspace(workflow);
  audit({
    event: "workflow.deleted",
    actorUserId: auth.user.id,
    ip: getRequestIp(req),
    details: { workflow_id: workflowId },
  });
  return NextResponse.json({ ok: true });
}
