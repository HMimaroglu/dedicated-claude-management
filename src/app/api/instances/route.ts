import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/api-auth";
import {
  createInstanceRow,
  deleteInstanceRow,
  listInstances,
  spawnInstance,
} from "@/lib/instances";
import { audit } from "@/lib/audit";
import { getRequestIp } from "@/lib/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  return NextResponse.json({ instances: listInstances() });
}

const CreateSchema = z.object({
  name: z.string().min(1).max(64),
  project_id: z.number().int().positive(),
  // null = local/controller (inherits from project). optional = inherit from
  // project.host_id. Both are accepted over the wire.
  host_id: z.number().int().positive().nullable().optional(),
  use_workflow: z.boolean().optional(),
  requirements: z
    .object({
      gpu: z.boolean().optional(),
      min_cores: z.number().int().optional(),
      min_ram_mb: z.number().int().optional(),
      tags: z.array(z.string()).optional(),
    })
    .optional(),
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
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  let inst;
  try {
    inst = createInstanceRow(parsed.data);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "create failed";
    if (/UNIQUE/.test(msg)) return NextResponse.json({ error: "Name in use" }, { status: 409 });
    return NextResponse.json({ error: msg }, { status: 400 });
  }
  audit({
    event: "instance.created",
    actorUserId: auth.user.id,
    ip: getRequestIp(req),
    details: { instance_id: inst.id, name: inst.name, project_id: inst.project_id },
  });

  // Spawn synchronously so the client sees the result. Clean up the row on
  // failure so the user can retry with the same name.
  const spawn = await spawnInstance(inst.id, undefined, {
    useWorkflow: parsed.data.use_workflow ?? false,
  });
  if (!spawn.success) {
    try {
      deleteInstanceRow(inst.id);
    } catch {
      // keep error instance for inspection
    }
    return NextResponse.json({ error: spawn.error ?? "spawn failed" }, { status: 500 });
  }
  audit({
    event: "instance.spawned",
    actorUserId: auth.user.id,
    ip: getRequestIp(req),
    details: { instance_id: inst.id },
  });
  return NextResponse.json({ instance: inst }, { status: 201 });
}
