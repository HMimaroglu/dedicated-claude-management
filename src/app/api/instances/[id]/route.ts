import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import {
  deleteInstanceRow,
  getInstance,
  killInstance,
  refreshInstanceStatus,
} from "@/lib/instances";
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
  const instanceId = parseId(id);
  if (instanceId === null) return NextResponse.json({ error: "Bad id" }, { status: 400 });
  const instance = getInstance(instanceId);
  if (!instance) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // Non-blocking status refresh: fire and forget so UI doesn't hang on a slow
  // SSH probe, but if the caller wants a fresh view they can hit /status.
  return NextResponse.json({ instance });
}

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const instanceId = parseId(id);
  if (instanceId === null) return NextResponse.json({ error: "Bad id" }, { status: 400 });

  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "true";

  const instance = getInstance(instanceId);
  if (!instance) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let killError: string | null = null;
  if (instance.status !== "stopped" && instance.status !== "error" && instance.status !== "crashed") {
    try {
      const kr = await killInstance(instanceId);
      if (!kr.ok) killError = kr.error;
    } catch (e) {
      killError = e instanceof Error ? e.message : String(e);
    }
  }

  // Refuse to delete a row when the kill didn't confirm the process is gone —
  // otherwise we'd lose the only handle on a claude --dangerously-skip-
  // permissions process. Operator can override with ?force=true.
  if (killError && !force) {
    return NextResponse.json(
      { error: `Kill failed: ${killError}. Retry or DELETE with ?force=true to remove the row anyway.` },
      { status: 409 }
    );
  }

  deleteInstanceRow(instanceId);
  audit({
    event: "instance.deleted",
    actorUserId: auth.user.id,
    ip: getRequestIp(req),
    details: { instance_id: instanceId, kill_error: killError, forced: force },
  });
  return NextResponse.json({ ok: true, kill_error: killError });
}

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  // /api/instances/:id with POST refreshes status (tmux has-session)
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const instanceId = parseId(id);
  if (instanceId === null) return NextResponse.json({ error: "Bad id" }, { status: 400 });
  const status = await refreshInstanceStatus(instanceId);
  return NextResponse.json({ status });
}
