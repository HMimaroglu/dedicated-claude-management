import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { hasAnyUser } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { getProject } from "@/lib/projects";
import { getHost } from "@/lib/hosts";
import ProjectClient from "./ProjectClient";
import { Nav } from "../../Nav";

export const dynamic = "force-dynamic";

export default async function ProjectDetail(
  { params }: { params: Promise<{ id: string }> }
) {
  if (!hasAnyUser()) redirect("/setup");
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const { id } = await params;
  const projectId = Number.parseInt(id, 10);
  if (!Number.isFinite(projectId)) notFound();
  const project = getProject(projectId);
  if (!project) notFound();
  const host = project.host_id ? getHost(project.host_id) : null;

  return (
    <main className="max-w-5xl mx-auto pt-12 px-4">
      <header className="flex justify-between items-center mb-8">
        <div className="flex items-center gap-4">
          <Link href="/dashboard" className="text-2xl font-semibold hover:text-zinc-300">DCM</Link>
          <div className="flex items-center gap-4">
            <Nav current="projects" />
            <span className="text-zinc-100 font-mono text-sm">/ {project.name}</span>
          </div>
        </div>
        <span className="text-sm text-zinc-400">{user.username}</span>
      </header>
      <ProjectClient project={project} host={host} />
    </main>
  );
}
