import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { getHost, recordProbe } from "@/lib/hosts";
import { getSsh } from "@/lib/ssh-lazy";
import { audit } from "@/lib/audit";
import { getRequestIp } from "@/lib/request-ip";
import { checkProbeCooldown } from "@/lib/probe-limit";

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
  const cd = checkProbeCooldown(hostId);
  if (!cd.allowed) {
    return NextResponse.json(
      { error: "Probe cooldown active, try again shortly" },
      { status: 429, headers: { "Retry-After": Math.ceil(cd.retryAfterMs / 1000).toString() } }
    );
  }
  const { probeHost } = await getSsh();
  const result = await probeHost(host);
  const status = recordProbe(hostId, result);
  audit({
    event: "host.probe_manual",
    actorUserId: auth.user.id,
    ip: getRequestIp(req),
    details: { host_id: hostId, success: result.success },
  });
  return NextResponse.json({ status, result });
}
