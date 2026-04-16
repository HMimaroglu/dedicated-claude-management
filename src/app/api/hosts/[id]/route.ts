import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/api-auth";
import { deleteHost, getHost, recentProbes, updateHost } from "@/lib/hosts";
import { audit } from "@/lib/audit";
import { getRequestIp } from "@/lib/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseId(idStr: string): number | null {
  const n = Number.parseInt(idStr, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const hostId = parseId(id);
  if (hostId === null) return NextResponse.json({ error: "Bad id" }, { status: 400 });
  const host = getHost(hostId);
  if (!host) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const probes = recentProbes(hostId, 50);
  return NextResponse.json({ host, probes });
}

const PatchSchema = z.object({
  name: z.string().optional(),
  address: z.string().optional(),
  port: z.number().int().optional(),
  ssh_user: z.string().optional(),
  auth_method: z.enum(["privkey", "agent"]).optional(),
  privkey: z.string().nullable().optional(),
  passphrase: z.string().nullable().optional(),
  capabilities: z
    .object({
      gpu: z.string().nullable().optional(),
      gpu_count: z.number().int().optional(),
      cores: z.number().int().optional(),
      ram_mb: z.number().int().optional(),
      tags: z.array(z.string()).optional(),
    })
    .optional(),
  labels: z.array(z.string()).optional(),
});

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const hostId = parseId(id);
  if (hostId === null) return NextResponse.json({ error: "Bad id" }, { status: 400 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }
  try {
    const host = updateHost(hostId, parsed.data);
    if (!host) return NextResponse.json({ error: "Not found" }, { status: 404 });
    audit({
      event: "host.updated",
      actorUserId: auth.user.id,
      ip: getRequestIp(req),
      details: { host_id: hostId, fields: Object.keys(parsed.data) },
    });
    return NextResponse.json({ host });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "update failed";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const hostId = parseId(id);
  if (hostId === null) return NextResponse.json({ error: "Bad id" }, { status: 400 });
  const ok = deleteHost(hostId);
  if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
  audit({
    event: "host.deleted",
    actorUserId: auth.user.id,
    ip: getRequestIp(req),
    details: { host_id: hostId },
  });
  return NextResponse.json({ ok: true });
}
