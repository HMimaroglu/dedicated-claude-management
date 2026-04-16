"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { WorkflowRecord } from "@/lib/workflows";
import type { ProjectRecord } from "@/lib/projects";
import type { AnthropicAuthStatus } from "@/lib/anthropic-auth";

const MODELS = [
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6 (recommended)" },
  { value: "claude-opus-4-6", label: "Opus 4.6 (most capable, more expensive)" },
  { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5 (fastest, cheapest)" },
];

export default function WorkflowsClient({
  initialWorkflows,
  enabledProjects,
  anthropic,
}: {
  initialWorkflows: WorkflowRecord[];
  enabledProjects: ProjectRecord[];
  anthropic: AnthropicAuthStatus;
}) {
  const router = useRouter();
  const [showAdd, setShowAdd] = useState(false);

  const canCreate = anthropic.configured && enabledProjects.length > 0;

  return (
    <div className="space-y-4">
      {!anthropic.configured && (
        <div className="bg-yellow-900/40 border border-yellow-800 rounded-md p-3 text-sm">
          <div className="font-semibold text-yellow-200">ANTHROPIC_API_KEY is not configured</div>
          <div className="text-yellow-300 mt-1">
            Set the env var on the DCM controller and restart before creating a workflow. The
            Claude Agent SDK requires it — claude.ai login is not supported for third-party apps.
          </div>
        </div>
      )}
      {anthropic.configured && enabledProjects.length === 0 && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-md p-3 text-sm text-zinc-400">
          No projects have multi-agent workflows enabled.{" "}
          <Link href="/projects" className="underline">Open a project</Link> and toggle it on first.
        </div>
      )}
      <button
        disabled={!canCreate}
        onClick={() => setShowAdd((s) => !s)}
        className="bg-zinc-100 text-zinc-900 px-3 py-1.5 rounded text-sm font-medium disabled:opacity-50"
      >
        {showAdd ? "Cancel" : "+ New workflow"}
      </button>

      {showAdd && canCreate && (
        <CreateForm
          projects={enabledProjects}
          onDone={() => {
            setShowAdd(false);
            router.refresh();
          }}
        />
      )}

      {initialWorkflows.length === 0 ? (
        <p className="text-zinc-500 text-sm">No workflows yet.</p>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-zinc-800 text-left text-zinc-400">
              <th className="py-2 px-2">Name</th>
              <th className="py-2 px-2">Project</th>
              <th className="py-2 px-2">State</th>
              <th className="py-2 px-2">Spent / budget</th>
              <th className="py-2 px-2">Model</th>
              <th className="py-2 px-2"></th>
            </tr>
          </thead>
          <tbody>
            {initialWorkflows.map((w) => (
              <tr key={w.id} className="border-b border-zinc-900">
                <td className="py-2 px-2 font-mono">{w.name}</td>
                <td className="py-2 px-2 text-zinc-400">
                  {enabledProjects.find((p) => p.id === w.project_id)?.name ?? `#${w.project_id}`}
                </td>
                <td className="py-2 px-2">
                  <StatePill state={w.state} />
                </td>
                <td className="py-2 px-2 font-mono text-xs">
                  ${w.spent_usd.toFixed(2)} / ${w.budget_usd.toFixed(2)}
                </td>
                <td className="py-2 px-2 text-zinc-400 font-mono text-xs">{w.model}</td>
                <td className="py-2 px-2 text-right">
                  <Link href={`/workflows/${w.id}`} className="text-zinc-300 hover:text-zinc-100">
                    Open →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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

function CreateForm({
  projects,
  onDone,
}: {
  projects: ProjectRecord[];
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState(String(projects[0]?.id ?? ""));
  const [idea, setIdea] = useState("");
  const [humanGate, setHumanGate] = useState(true);
  const [budget, setBudget] = useState("10");
  const [maxIter, setMaxIter] = useState("10");
  const [model, setModel] = useState("claude-sonnet-4-6");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const r = await fetch("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          project_id: parseInt(projectId, 10),
          idea,
          require_human_gate: humanGate,
          budget_usd: parseFloat(budget),
          max_iterations_per_aspect: parseInt(maxIter, 10),
          model,
        }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "Create failed");
        return;
      }
      onDone();
    });
  }

  return (
    <form onSubmit={submit} className="bg-zinc-900 border border-zinc-800 rounded-md p-4 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <label className="block text-sm">
          <span className="block mb-1">Name</span>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5"
          />
        </label>
        <label className="block text-sm">
          <span className="block mb-1">Project</span>
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block text-sm">
        <span className="block mb-1">Idea / prompt</span>
        <textarea
          required
          rows={6}
          minLength={10}
          maxLength={10000}
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          placeholder="Describe what you want built. Be as specific or as vague as you like — the sys-design agents will decompose it."
          className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 font-mono text-xs"
        />
      </label>
      <div className="grid grid-cols-3 gap-3">
        <label className="block text-sm">
          <span className="block mb-1">Budget USD</span>
          <input
            type="number"
            step="0.1"
            min="0.1"
            max="1000"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5"
          />
        </label>
        <label className="block text-sm">
          <span className="block mb-1">Max iterations / aspect</span>
          <input
            type="number"
            min="1"
            max="50"
            value={maxIter}
            onChange={(e) => setMaxIter(e.target.value)}
            className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5"
          />
        </label>
        <label className="block text-sm">
          <span className="block mb-1">Model</span>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5"
          >
            {MODELS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={humanGate}
          onChange={(e) => setHumanGate(e.target.checked)}
          className="accent-zinc-100"
        />
        <span>
          Pause for human approval after decomposition (recommended — 9-agent runs are expensive)
        </span>
      </label>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="bg-zinc-100 text-zinc-900 px-3 py-1.5 rounded text-sm font-medium disabled:opacity-50"
      >
        {pending ? "Creating…" : "Create workflow"}
      </button>
      <p className="text-xs text-zinc-500">
        The workflow row is created here. In this release the orchestration loop is not yet wired up;
        the row is a placeholder until Phase 2 lands.
      </p>
    </form>
  );
}
