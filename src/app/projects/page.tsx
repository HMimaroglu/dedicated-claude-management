import Link from "next/link";
import { redirect } from "next/navigation";
import { hasAnyUser } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { listProjects } from "@/lib/projects";
import { listHosts } from "@/lib/hosts";
import ProjectsClient from "./ProjectsClient";
import { Nav } from "../Nav";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  if (!hasAnyUser()) redirect("/setup");
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const projects = listProjects();
  const hosts = listHosts();

  return (
    <main className="max-w-5xl mx-auto pt-12 px-4">
      <header className="flex justify-between items-center mb-8">
        <div className="flex items-center gap-4">
          <Link href="/dashboard" className="text-2xl font-semibold hover:text-zinc-300">DCM</Link>
          <Nav current="projects" />
        </div>
        <span className="text-sm text-zinc-400">{user.username}</span>
      </header>
      <div className="mb-4">
        <h2 className="text-xl font-semibold">Projects</h2>
      </div>
      <ProjectsClient initialProjects={projects} hosts={hosts} />
    </main>
  );
}
