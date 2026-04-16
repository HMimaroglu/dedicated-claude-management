"use client";
import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";
import type {
  AspectRecord,
  WorkflowEventRecord,
  WorkflowRecord,
} from "@/lib/workflows";
import type { ProjectRecord } from "@/lib/projects";

interface AgentSummary {
  role: string;
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
}

const ACTIVE_STATES: Array<WorkflowRecord["state"]> = [
  "decomposition",
  "aspect_research",
  "aspect_research_review",
  "aspect_impl",
  "aspect_audit",
  "aspect_push",
  "aspect_signoff",
  "final_review",
];

export default function WorkflowClient({
  workflow,
  project,
  aspects,
  events,
  agents,
}: {
  workflow: WorkflowRecord;
  project: ProjectRecord | null;
  aspects: AspectRecord[];
  events: WorkflowEventRecord[];
  agents: AgentSummary[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  // Auto-refresh every 5s while the workflow is advancing. Stops once it
  // reaches a terminal or waiting state so the operator can inspect without
  // flicker.
  useEffect(() => {
    if (!ACTIVE_STATES.includes(workflow.state)) return;
    const t = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(t);
  }, [workflow.state, router]);

  function remove() {
    if (
      !confirm(
        `Delete workflow "${workflow.name}"? This removes the DB row and the workspace directory on disk.`
      )
    )
      return;
    start(async () => {
      const r = await fetch(`/api/workflows/${workflow.id}`, { method: "DELETE" });
      if (r.ok) router.push("/workflows");
      else alert((await r.json().catch(() => ({}))).error ?? "Delete failed");
    });
  }

  function runAction(path: string) {
    start(async () => {
      const r = await fetch(path, { method: "POST" });
      if (!r.ok) alert((await r.json().catch(() => ({}))).error ?? "Request failed");
      router.refresh();
    });
  }

  const canStart = workflow.state === "idea_intake" || workflow.state === "paused";
  const canApprove = workflow.state === "awaiting_human_gate";
  const canStop =
    workflow.state !== "complete" &&
    workflow.state !== "error" &&
    workflow.state !== "paused";

  const budgetPct = Math.min(100, (workflow.spent_usd / workflow.budget_usd) * 100);

  return (
    <div className="space-y-6">
      <section className="bg-zinc-900 border border-zinc-800 rounded-md p-4">
        <div className="flex justify-between items-start mb-3">
          <div>
            <div className="text-xl font-semibold font-mono">{workflow.name}</div>
            <div className="text-sm text-zinc-400 mt-1">
              Project: {project?.name ?? `#${workflow.project_id}`} · Model: {workflow.model}
            </div>
          </div>
          <StatePill state={workflow.state} />
        </div>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <Stat label="Workspace" value={workflow.workspace_path} mono />
          <Stat
            label="Human gate"
            value={workflow.require_human_gate ? "enabled" : "disabled"}
          />
          <Stat
            label="Budget"
            value={`$${workflow.spent_usd.toFixed(2)} / $${workflow.budget_usd.toFixed(2)}`}
          />
          <Stat
            label="Max iterations / aspect"
            value={String(workflow.max_iterations_per_aspect)}
          />
          <Stat
            label="Current aspect"
            value={workflow.current_aspect_ord !== null ? `#${workflow.current_aspect_ord}` : "—"}
          />
          <Stat
            label="Created"
            value={new Date(workflow.created_at).toLocaleString()}
          />
        </div>
        <div className="mt-3">
          <div className="h-1.5 bg-zinc-800 rounded overflow-hidden">
            <div
              className={`h-full ${budgetPct >= 100 ? "bg-red-500" : "bg-emerald-500"}`}
              style={{ width: `${budgetPct}%` }}
            />
          </div>
          <div className="text-xs text-zinc-500 mt-1">
            Budget {budgetPct.toFixed(1)}% consumed
          </div>
        </div>
        {workflow.last_error && (
          <p className="mt-3 text-sm text-red-400 font-mono break-all">
            Error: {workflow.last_error}
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            disabled={pending || !canStart}
            onClick={() => runAction(`/api/workflows/${workflow.id}/start`)}
            className="bg-emerald-900 text-emerald-100 px-3 py-1.5 rounded text-sm font-medium disabled:opacity-50"
          >
            {workflow.state === "paused" ? "Resume" : "Start"}
          </button>
          <button
            disabled={pending || !canApprove}
            onClick={() => runAction(`/api/workflows/${workflow.id}/approve`)}
            className="bg-blue-900 text-blue-100 px-3 py-1.5 rounded text-sm font-medium disabled:opacity-50"
            title={canApprove ? "Approve the decomposition plan and continue to research" : "Only available at the human gate"}
          >
            Approve plan
          </button>
          <button
            disabled={pending || !canStop}
            onClick={() => runAction(`/api/workflows/${workflow.id}/stop`)}
            className="bg-yellow-900 text-yellow-100 px-3 py-1.5 rounded text-sm font-medium disabled:opacity-50"
          >
            Pause
          </button>
          <button
            disabled={pending}
            onClick={remove}
            className="bg-red-900 text-red-100 px-3 py-1.5 rounded text-sm font-medium disabled:opacity-50"
          >
            Delete
          </button>
        </div>
        <p className="text-xs text-zinc-500 mt-3">
          Orchestrator drives all 8 phases. Active workflows auto-refresh every 5s.
        </p>
      </section>

      <section>
        <h3 className="text-sm font-semibold mb-2 text-zinc-400">Agent costs</h3>
        {agents.length === 0 ? (
          <p className="text-sm text-zinc-500">No agent sessions yet.</p>
        ) : (
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-zinc-800 text-left text-zinc-400">
                <th className="py-2 px-2">Role</th>
                <th className="py-2 px-2">Cost (USD)</th>
                <th className="py-2 px-2">Input tokens</th>
                <th className="py-2 px-2">Output tokens</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.role} className="border-b border-zinc-900">
                  <td className="py-1.5 px-2 font-mono">{a.role}</td>
                  <td className="py-1.5 px-2 font-mono">${a.total_cost_usd.toFixed(4)}</td>
                  <td className="py-1.5 px-2 font-mono text-zinc-400">
                    {a.total_input_tokens.toLocaleString()}
                  </td>
                  <td className="py-1.5 px-2 font-mono text-zinc-400">
                    {a.total_output_tokens.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h3 className="text-sm font-semibold mb-2 text-zinc-400">Aspects</h3>
        {aspects.length === 0 ? (
          <p className="text-sm text-zinc-500">
            Not decomposed yet. Sys-design agents will produce the aspect list during the
            decomposition phase.
          </p>
        ) : (
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-zinc-800 text-left text-zinc-400">
                <th className="py-2 px-2 w-12">#</th>
                <th className="py-2 px-2">Title</th>
                <th className="py-2 px-2">State</th>
                <th className="py-2 px-2">Loops</th>
              </tr>
            </thead>
            <tbody>
              {aspects.map((a) => (
                <tr key={a.id} className="border-b border-zinc-900">
                  <td className="py-2 px-2 font-mono">{a.ord}</td>
                  <td className="py-2 px-2">{a.title}</td>
                  <td className="py-2 px-2 text-zinc-400">{a.state}</td>
                  <td className="py-2 px-2 font-mono text-xs">{a.loop_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h3 className="text-sm font-semibold mb-2 text-zinc-400">Event log (most recent first)</h3>
        {events.length === 0 ? (
          <p className="text-sm text-zinc-500">No events yet.</p>
        ) : (
          <div className="space-y-1 font-mono text-xs">
            {events.map((e) => (
              <div key={e.id} className="flex gap-3 text-zinc-400">
                <span className="text-zinc-600">{new Date(e.created_at).toLocaleTimeString()}</span>
                <span className="text-zinc-500 w-24 shrink-0">{e.phase}</span>
                {e.actor_role && <span className="text-zinc-500 w-8 shrink-0">{e.actor_role}</span>}
                <span className="text-zinc-300">{e.kind}</span>
                {e.payload !== null && (
                  <span className="text-zinc-600 truncate">
                    {JSON.stringify(e.payload)}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="text-zinc-500 text-xs mb-0.5">{label}</div>
      <div className={`${mono ? "font-mono" : ""} break-all`}>{value}</div>
    </div>
  );
}

function StatePill({ state }: { state: WorkflowRecord["state"] }) {
  const color =
    state === "complete"
      ? "bg-emerald-900 text-emerald-300"
      : state === "error"
      ? "bg-red-900 text-red-300"
      : state === "paused" || state === "awaiting_human_gate"
      ? "bg-yellow-900 text-yellow-300"
      : "bg-blue-900 text-blue-300";
  return <span className={`px-2 py-0.5 rounded text-xs ${color}`}>{state}</span>;
}
