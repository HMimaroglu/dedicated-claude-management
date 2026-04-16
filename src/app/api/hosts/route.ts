import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/api-auth";
import { createHost, listHosts } from "@/lib/hosts";
import { audit } from "@/lib/audit";
import { getRequestIp } from "@/lib/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const hosts = listHosts();
  // never expose secrets via list
  return NextResponse.json({
    hosts: hosts.map(({ ...h }) => h),
  });
}

const CreateSchema = z.object({
  name: z.string(),
  address: z.string(),
  port: z.number().int().optional(),
  ssh_user: z.string(),
  auth_method: z.enum(["privkey", "agent"]),
  privkey: z.string().optional(),
  passphrase: z.string().optional(),
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

export async function POST(req: Request) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }

  try {
    const host = createHost(parsed.data);
    audit({
      event: "host.created",
      actorUserId: auth.user.id,
      ip: getRequestIp(req),
      details: { host_id: host.id, name: host.name, address: host.address },
    });
    return NextResponse.json({ host }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "create failed";
    if (/UNIQUE constraint failed/.test(msg)) {
      return NextResponse.json({ error: "Host name already exists" }, { status: 409 });
    }
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
