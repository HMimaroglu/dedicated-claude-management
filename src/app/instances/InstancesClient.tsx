"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { InstanceRecord } from "@/lib/instances";
import type { ProjectRecord } from "@/lib/projects";
import type { HostRecord } from "@/lib/hosts";

export default function InstancesClient({
  initialInstances,
  projects,
  hosts,
}: {
  initialInstances: InstanceRecord[];
  projects: ProjectRecord[];
  hosts: HostRecord[];
}) {
  const router = useRouter();
  const [showAdd, setShowAdd] = useState(false);
  const spawnable = projects.filter(
    (p) => p.clone_status === "ready" || p.clone_status === "skipped"
  );
  return (
    <div className="space-y-4">
      <button
        onClick={() => setShowAdd((s) => !s)}
        disabled={spawnable.length === 0}
        className="bg-zinc-100 text-zinc-900 px-3 py-1.5 rounded text-sm font-medium disabled:opacity-50"
        title={spawnable.length === 0 ? "Need a project in ready/skipped state" : ""}
      >
        {showAdd ? "Cancel" : "+ Spawn instance"}
      </button>
      {spawnable.length === 0 && (
        <p className="text-sm text-yellow-400">
          No projects available. Add + clone a project first. <Link href="/projects" className="underline">Go to projects →</Link>
        </p>
      )}
      {showAdd && spawnable.length > 0 && (
        <SpawnForm
          projects={spawnable}
          hosts={hosts}
          onDone={() => { setShowAdd(false); router.refresh(); }}
        />
      )}
      {initialInstances.length === 0 ? (
        <p className="text-zinc-500 text-sm">No instances yet.</p>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-zinc-800 text-left text-zinc-400">
              <th className="py-2 px-2">Name</th>
              <th className="py-2 px-2">Project</th>
              <th className="py-2 px-2">Host</th>
              <th className="py-2 px-2">tmux</th>
              <th className="py-2 px-2">Status</th>
              <th className="py-2 px-2">Spawned</th>
              <th className="py-2 px-2"></th>
            </tr>
          </thead>
          <tbody>
            {initialInstances.map((i) => {
              const project = projects.find((p) => p.id === i.project_id);
              const host = hosts.find((h) => h.id === i.host_id);
              return (
                <tr key={i.id} className="border-b border-zinc-900">
                  <td className="py-2 px-2 font-mono">{i.name}</td>
                  <td className="py-2 px-2 text-zinc-400">{project?.name ?? "—"}</td>
                  <td className="py-2 px-2 text-zinc-400">
                    {i.host_id === null ? "local" : (host?.name ?? "—")}
                  </td>
                  <td className="py-2 px-2 font-mono text-zinc-500 text-xs">{i.tmux_session}</td>
                  <td className="py-2 px-2"><StatusPill status={i.status} /></td>
                  <td className="py-2 px-2 text-zinc-500 text-xs">
                    {i.spawned_at ? new Date(i.spawned_at).toLocaleTimeString() : "—"}
                  </td>
                  <td className="py-2 px-2 text-right">
                    <Link href={`/instances/${i.id}`} className="text-zinc-300 hover:text-zinc-100">Open →</Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: InstanceRecord["status"] }) {
  const color =
    status === "running" ? "bg-emerald-900 text-emerald-300" :
    status === "starting" ? "bg-blue-900 text-blue-300" :
    status === "paused" ? "bg-yellow-900 text-yellow-300" :
    status === "stopped" ? "bg-zinc-700 text-zinc-300" :
    status === "crashed" ? "bg-red-900 text-red-300" :
    "bg-red-900 text-red-300";
  return <span className={`px-2 py-0.5 rounded text-xs ${color}`}>{status}</span>;
}

function SpawnForm({
  projects,
  hosts,
  onDone,
}: {
  projects: ProjectRecord[];
  hosts: HostRecord[];
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState<string>(projects[0] ? String(projects[0].id) : "");
  // "" = local (controller). Otherwise a specific remote host id.
  const [hostId, setHostId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const r = await fetch("/api/instances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          project_id: parseInt(projectId, 10),
          host_id: hostId === "" ? null : parseInt(hostId, 10),
        }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "Spawn failed");
        return;
      }
      onDone();
    });
  }

  return (
    <form onSubmit={submit} className="bg-zinc-900 border border-zinc-800 rounded-md p-4 space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <label className="block text-sm">
          <span className="block mb-1">Instance name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required
            className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5"
            placeholder="research-agent-1" />
        </label>
        <label className="block text-sm">
          <span className="block mb-1">Project</span>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}
            className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5">
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="block mb-1">Run on</span>
          <select value={hostId} onChange={(e) => setHostId(e.target.value)}
            className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5"
            title="Local by default. Pick a remote host only if you need its compute.">
            <option value="">Local (controller)</option>
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>{h.name}</option>
            ))}
          </select>
        </label>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <p className="text-xs text-zinc-500">
        Runs <code className="bg-zinc-950 px-1 rounded">claude remote-control --dangerously-skip-permissions</code> inside tmux. Defaults to this machine; pick a remote host for extra compute (GPU, more cores).
      </p>
      <button type="submit" disabled={pending}
        className="bg-zinc-100 text-zinc-900 px-3 py-1.5 rounded text-sm font-medium disabled:opacity-50">
        {pending ? "Spawning…" : "Spawn"}
      </button>
    </form>
  );
}
