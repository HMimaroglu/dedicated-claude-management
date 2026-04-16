import Link from "next/link";
import { redirect } from "next/navigation";
import { hasAnyUser } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { listInstances } from "@/lib/instances";
import { listProjects } from "@/lib/projects";
import { listHosts } from "@/lib/hosts";
import InstancesClient from "./InstancesClient";
import { Nav } from "../Nav";

export const dynamic = "force-dynamic";

export default async function InstancesPage() {
  if (!hasAnyUser()) redirect("/setup");
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const instances = listInstances();
  const projects = listProjects();
  const hosts = listHosts();

  return (
    <main className="max-w-5xl mx-auto pt-12 px-4">
      <header className="flex justify-between items-center mb-8">
        <div className="flex items-center gap-4">
          <Link href="/dashboard" className="text-2xl font-semibold hover:text-zinc-300">DCM</Link>
          <Nav current="instances" />
        </div>
        <span className="text-sm text-zinc-400">{user.username}</span>
      </header>
      <div className="mb-4">
        <h2 className="text-xl font-semibold">Claude Code instances</h2>
      </div>
      <InstancesClient initialInstances={instances} projects={projects} hosts={hosts} />
    </main>
  );
}
