import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { cloneProject, getProject } from "@/lib/projects";
import { audit } from "@/lib/audit";
import { getRequestIp } from "@/lib/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseId(s: string): number | null {
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const projectId = parseId(id);
  if (projectId === null) return NextResponse.json({ error: "Bad id" }, { status: 400 });
  const project = getProject(projectId);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (project.source_type !== "git") {
    return NextResponse.json({ error: "Only git projects can be cloned" }, { status: 400 });
  }
  // Atomic claim lives inside cloneProject; this pre-check is only a fast path.
  if (project.clone_status === "cloning") {
    return NextResponse.json({ error: "Already cloning" }, { status: 409 });
  }
  let result;
  try {
    result = await cloneProject(projectId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "clone failed";
    if (/another clone/.test(msg)) {
      return NextResponse.json({ error: "Already cloning" }, { status: 409 });
    }
    return NextResponse.json({ error: msg }, { status: 400 });
  }
  audit({
    event: "project.cloned",
    actorUserId: auth.user.id,
    ip: getRequestIp(req),
    details: { project_id: projectId, success: result.success },
  });
  return NextResponse.json(result);
}
