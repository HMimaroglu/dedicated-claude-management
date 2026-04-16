import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/api-auth";
import { deleteProject, getProject, updateProject } from "@/lib/projects";
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
  const projectId = parseId(id);
  if (projectId === null) return NextResponse.json({ error: "Bad id" }, { status: 400 });
  const project = getProject(projectId);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ project });
}

const PatchSchema = z.object({
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  git_url: z.string().optional(),
  git_branch: z.string().optional(),
  path_on_host: z.string().optional(),
});

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const projectId = parseId(id);
  if (projectId === null) return NextResponse.json({ error: "Bad id" }, { status: 400 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  try {
    const project = updateProject(projectId, parsed.data);
    if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });
    audit({
      event: "project.updated",
      actorUserId: auth.user.id,
      ip: getRequestIp(req),
      details: { project_id: projectId, fields: Object.keys(parsed.data) },
    });
    return NextResponse.json({ project });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "update failed";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const projectId = parseId(id);
  if (projectId === null) return NextResponse.json({ error: "Bad id" }, { status: 400 });
  const ok = deleteProject(projectId);
  if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
  audit({
    event: "project.deleted",
    actorUserId: auth.user.id,
    ip: getRequestIp(req),
    details: { project_id: projectId },
  });
  return NextResponse.json({ ok: true });
}
