import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/api-auth";
import { getDb } from "@/lib/db";
import { getInstance } from "@/lib/instances";
import { audit } from "@/lib/audit";
import { getRequestIp } from "@/lib/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseId(s: string): number | null {
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const Schema = z.object({ enabled: z.boolean() });

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const instanceId = parseId(id);
  if (instanceId === null) return NextResponse.json({ error: "Bad id" }, { status: 400 });
  const inst = getInstance(instanceId);
  if (!inst) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  const db = getDb();
  db.prepare(
    `UPDATE instances SET auto_restart = ?, restart_count = 0, next_restart_at = NULL, updated_at = ? WHERE id = ?`
  ).run(parsed.data.enabled ? 1 : 0, Date.now(), instanceId);
  audit({
    event: "instance.auto_restart_toggled",
    actorUserId: auth.user.id,
    ip: getRequestIp(req),
    details: { instance_id: instanceId, enabled: parsed.data.enabled },
  });
  return NextResponse.json({ ok: true });
}
