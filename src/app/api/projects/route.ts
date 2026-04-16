import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/api-auth";
import { createProject, listProjects } from "@/lib/projects";
import { audit } from "@/lib/audit";
import { getRequestIp } from "@/lib/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  return NextResponse.json({ projects: listProjects() });
}

const CreateSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  source_type: z.enum(["git", "local"]),
  git_url: z.string().optional(),
  git_branch: z.string().optional(),
  host_id: z.number().int().positive(),
  path_on_host: z.string(),
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

  try {
    const project = createProject(parsed.data);
    audit({
      event: "project.created",
      actorUserId: auth.user.id,
      ip: getRequestIp(req),
      details: { project_id: project.id, name: project.name, source_type: project.source_type },
    });
    return NextResponse.json({ project }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "create failed";
    if (/UNIQUE constraint failed/.test(msg)) {
      return NextResponse.json({ error: "Project name already exists" }, { status: 409 });
    }
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
