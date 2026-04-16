import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/api-auth";
import { getProject } from "@/lib/projects";
import { setProjectMultiAgent } from "@/lib/workflows";
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
  const projectId = parseId(id);
  if (projectId === null) return NextResponse.json({ error: "Bad id" }, { status: 400 });
  const project = getProject(projectId);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  setProjectMultiAgent(projectId, parsed.data.enabled);
  audit({
    event: "project.updated",
    actorUserId: auth.user.id,
    ip: getRequestIp(req),
    details: { project_id: projectId, fields: ["multi_agent_enabled"], enabled: parsed.data.enabled },
  });
  return NextResponse.json({ ok: true });
}
