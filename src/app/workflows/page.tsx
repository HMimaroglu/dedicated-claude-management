import Link from "next/link";
import { redirect } from "next/navigation";
import { hasAnyUser } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { listWorkflows } from "@/lib/workflows";
import { listProjects } from "@/lib/projects";
import { anthropicAuthStatus } from "@/lib/anthropic-auth";
import { Nav } from "../Nav";
import WorkflowsClient from "./WorkflowsClient";

export const dynamic = "force-dynamic";

export default async function WorkflowsPage() {
  if (!hasAnyUser()) redirect("/setup");
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const workflows = listWorkflows();
  const enabledProjects = listProjects().filter((p) => p.multi_agent_enabled);
  const auth = anthropicAuthStatus();

  return (
    <main className="max-w-5xl mx-auto pt-12 px-4">
      <header className="flex justify-between items-center mb-8">
        <div className="flex items-center gap-4">
          <Link href="/dashboard" className="text-2xl font-semibold hover:text-zinc-300">
            DCM
          </Link>
          <Nav current="workflows" />
        </div>
        <span className="text-sm text-zinc-400">{user.username}</span>
      </header>
      <div className="mb-4">
        <h2 className="text-xl font-semibold">Multi-agent workflows</h2>
        <p className="text-sm text-zinc-400 mt-1">
          9 Claude agents across 4 layers collaborate to take a project idea from decomposition to
          completion. Opt-in per project.
        </p>
      </div>
      <WorkflowsClient
        initialWorkflows={workflows}
        enabledProjects={enabledProjects}
        anthropic={auth}
      />
    </main>
  );
}
