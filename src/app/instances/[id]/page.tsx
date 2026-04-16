import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { hasAnyUser } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { getInstance } from "@/lib/instances";
import { getProject } from "@/lib/projects";
import { getHost } from "@/lib/hosts";
import InstanceClient from "./InstanceClient";
import TerminalView from "./TerminalView";
import { Nav } from "../../Nav";

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
  const host = instance.host_id !== null ? getHost(instance.host_id) : null;

  return (
    <main className="max-w-5xl mx-auto pt-12 px-4">
      <header className="flex justify-between items-center mb-8">
        <div className="flex items-center gap-4">
          <Link href="/dashboard" className="text-2xl font-semibold hover:text-zinc-300">DCM</Link>
          <div className="flex items-center gap-4">
            <Nav current="instances" />
            <span className="text-zinc-100 font-mono text-sm">/ {instance.name}</span>
          </div>
        </div>
        <span className="text-sm text-zinc-400">{user.username}</span>
      </header>
      <div className="space-y-6">
        <InstanceClient instance={instance} project={project} host={host} />
        <section>
          <h3 className="text-sm font-semibold mb-2 text-zinc-400">Live terminal</h3>
          <TerminalView instance={instance} />
        </section>
      </div>
    </main>
  );
}
