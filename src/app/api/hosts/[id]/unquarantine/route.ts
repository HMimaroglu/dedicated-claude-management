import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { getHost, unquarantineHost } from "@/lib/hosts";
import { audit } from "@/lib/audit";
import { getRequestIp } from "@/lib/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseId(idStr: string): number | null {
  const n = Number.parseInt(idStr, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const hostId = parseId(id);
  if (hostId === null) return NextResponse.json({ error: "Bad id" }, { status: 400 });
  const host = getHost(hostId);
  if (!host) return NextResponse.json({ error: "Not found" }, { status: 404 });
  unquarantineHost(hostId);
  audit({
    event: "host.unquarantined",
    actorUserId: auth.user.id,
    ip: getRequestIp(req),
    details: { host_id: hostId },
  });
  return NextResponse.json({ ok: true });
}
