import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { getInstance, resumeInstance } from "@/lib/instances";
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
  const instanceId = parseId(id);
  if (instanceId === null) return NextResponse.json({ error: "Bad id" }, { status: 400 });
  const inst = getInstance(instanceId);
  if (!inst) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (inst.status !== "paused") {
    return NextResponse.json({ error: `cannot resume instance in status '${inst.status}'` }, { status: 409 });
  }
  const r = await resumeInstance(instanceId);
  audit({
    event: "instance.resumed",
    actorUserId: auth.user.id,
    ip: getRequestIp(req),
    details: { instance_id: instanceId, success: r.ok },
  });
  return NextResponse.json(r, { status: r.ok ? 200 : 500 });
}
