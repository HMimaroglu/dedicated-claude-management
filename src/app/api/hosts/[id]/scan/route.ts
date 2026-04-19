import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { getHost, updateHost, recordProbe } from "@/lib/hosts";
import { getSsh } from "@/lib/ssh-lazy";
import { audit } from "@/lib/audit";
import { getRequestIp } from "@/lib/request-ip";

export const runtime = "nodejs";

// Probes the host via SSH, updates capabilities (cores, ram_mb, gpu) from the
// probe results, and records the probe. Called after host creation or manually.
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const hostId = parseInt(id, 10);
  if (!Number.isFinite(hostId) || hostId <= 0) {
    return NextResponse.json({ error: "Bad id" }, { status: 400 });
  }
  const host = getHost(hostId);
  if (!host) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { probeHost, openSession, execOnce } = await getSsh();
  const probeResult = await probeHost(host);
  recordProbe(hostId, probeResult);

  if (!probeResult.success) {
    return NextResponse.json({
      error: probeResult.error ?? "Probe failed",
      probeResult,
    }, { status: 422 });
  }

  // Extract capabilities from probe and update host.
  const caps = { ...host.capabilities };

  // Detect cores via SSH.
  try {
    const conn = await openSession(host);
    try {
      const nproc = await execOnce(conn, "nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 0");
      const cores = parseInt(nproc.stdout.trim(), 10);
      if (Number.isFinite(cores) && cores > 0) caps.cores = cores;
    } finally {
      conn.end();
    }
  } catch {
    // ignore — we still have probe data
  }

  if (probeResult.mem_total_mb) caps.ram_mb = probeResult.mem_total_mb;
  if (probeResult.gpu_info && probeResult.gpu_info.length > 0) {
    caps.gpu = probeResult.gpu_info.map((g) => g.name).join(", ");
    caps.gpu_count = probeResult.gpu_info.length;
  }

  updateHost(hostId, { capabilities: caps });

  audit({
    event: "host.updated",
    actorUserId: auth.user.id,
    ip: getRequestIp(req),
    details: { host_id: hostId, action: "auto-scan", caps },
  });

  return NextResponse.json({
    ok: true,
    capabilities: caps,
    probeResult,
  });
}
