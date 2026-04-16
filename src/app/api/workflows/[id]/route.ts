import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import {
  deleteWorkflow,
  getWorkflow,
  listAspects,
  recentWorkflowEvents,
  removeWorkflowWorkspace,
} from "@/lib/workflows";
import { getDb } from "@/lib/db";
import { audit } from "@/lib/audit";
import { getRequestIp } from "@/lib/request-ip";
import { isInFlight } from "@/orchestrator/workflow-lock";

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
  const db = getDb();
  const agents = db
    .prepare(
      "SELECT role, total_cost_usd, total_input_tokens, total_output_tokens, updated_at FROM workflow_agents WHERE workflow_id = ? ORDER BY role"
    )
    .all(workflowId);
  return NextResponse.json({
    workflow,
    aspects: listAspects(workflowId),
    events: recentWorkflowEvents(workflowId, 200),
    agents,
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

  // Refuse to delete while the orchestrator watcher holds a lock on this
  // workflow — an in-flight SDK turn may still write workflow_events/
  // workflow_agents rows, which would fail with a dangling FK after CASCADE
  // wipes the parent. Operator should /stop first.
  if (isInFlight(workflowId)) {
    return NextResponse.json(
      { error: "workflow is currently being advanced; pause first then retry" },
      { status: 409 }
    );
  }

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
