import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { hasAnyUser } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { getWorkflow, listAspects, recentWorkflowEvents } from "@/lib/workflows";
import { getProject } from "@/lib/projects";
import { Nav } from "../../Nav";
import WorkflowClient from "./WorkflowClient";

export const dynamic = "force-dynamic";

export default async function WorkflowDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!hasAnyUser()) redirect("/setup");
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const { id } = await params;
  const workflowId = Number.parseInt(id, 10);
  if (!Number.isFinite(workflowId)) notFound();
  const workflow = getWorkflow(workflowId);
  if (!workflow) notFound();
  const project = getProject(workflow.project_id);
  const aspects = listAspects(workflowId);
  const events = recentWorkflowEvents(workflowId, 100);

  return (
    <main className="max-w-5xl mx-auto pt-12 px-4">
      <header className="flex justify-between items-center mb-8">
        <div className="flex items-center gap-4">
          <Link href="/dashboard" className="text-2xl font-semibold hover:text-zinc-300">
            DCM
          </Link>
          <div className="flex items-center gap-4">
            <Nav current="workflows" />
            <span className="text-zinc-100 font-mono text-sm">/ {workflow.name}</span>
          </div>
        </div>
        <span className="text-sm text-zinc-400">{user.username}</span>
      </header>
      <WorkflowClient
        workflow={workflow}
        project={project}
        aspects={aspects}
        events={events}
      />
    </main>
  );
}
