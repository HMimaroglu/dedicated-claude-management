import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { hasAnyUser } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { getInstance } from "@/lib/instances";
import { getProject } from "@/lib/projects";
import { getHost } from "@/lib/hosts";
import InstanceClient from "./InstanceClient";

export const dynamic = "force-dynamic";

export default async function InstanceDetail(
  { params }: { params: Promise<{ id: string }> }
) {
  if (!hasAnyUser()) redirect("/setup");
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const { id } = await params;
  const instanceId = Number.parseInt(id, 10);
  if (!Number.isFinite(instanceId)) notFound();
  const instance = getInstance(instanceId);
  if (!instance) notFound();
  const project = getProject(instance.project_id);
  const host = getHost(instance.host_id);

  return (
    <main className="max-w-4xl mx-auto pt-12 px-4">
      <header className="flex justify-between items-center mb-8">
        <div className="flex items-center gap-4">
          <Link href="/dashboard" className="text-2xl font-semibold hover:text-zinc-300">DCM</Link>
          <nav className="text-sm flex gap-4 text-zinc-400">
            <Link href="/dashboard" className="hover:text-zinc-100">Dashboard</Link>
            <Link href="/hosts" className="hover:text-zinc-100">Hosts</Link>
            <Link href="/projects" className="hover:text-zinc-100">Projects</Link>
            <Link href="/instances" className="hover:text-zinc-100">Instances</Link>
            <span className="text-zinc-100 font-mono">/ {instance.name}</span>
          </nav>
        </div>
        <span className="text-sm text-zinc-400">{user.username}</span>
      </header>
      <InstanceClient instance={instance} project={project} host={host} />
    </main>
  );
}
