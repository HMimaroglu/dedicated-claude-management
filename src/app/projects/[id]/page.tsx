import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { hasAnyUser } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { getProject } from "@/lib/projects";
import { getHost } from "@/lib/hosts";
import ProjectClient from "./ProjectClient";

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
    <main className="max-w-4xl mx-auto pt-12 px-4">
      <header className="flex justify-between items-center mb-8">
        <div className="flex items-center gap-4">
          <Link href="/dashboard" className="text-2xl font-semibold hover:text-zinc-300">DCM</Link>
          <nav className="text-sm flex gap-4 text-zinc-400">
            <Link href="/dashboard" className="hover:text-zinc-100">Dashboard</Link>
            <Link href="/hosts" className="hover:text-zinc-100">Hosts</Link>
            <Link href="/projects" className="hover:text-zinc-100">Projects</Link>
            <span className="text-zinc-100 font-mono">/ {project.name}</span>
          </nav>
        </div>
        <span className="text-sm text-zinc-400">{user.username}</span>
      </header>
      <ProjectClient project={project} host={host} />
    </main>
  );
}
