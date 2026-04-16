"use client";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import type { InstanceRecord } from "@/lib/instances";
import type { ProjectRecord } from "@/lib/projects";
import type { HostRecord } from "@/lib/hosts";

export default function InstanceClient({
  instance,
  project,
  host,
}: {
  instance: InstanceRecord;
  project: ProjectRecord | null;
  host: HostRecord | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function refresh() {
    start(async () => {
      await fetch(`/api/instances/${instance.id}`, { method: "POST" });
      router.refresh();
    });
  }
  function kill() {
    if (!confirm(`Kill instance "${instance.name}"? (tmux kill-session)`)) return;
    start(async () => {
      await fetch(`/api/instances/${instance.id}/kill`, { method: "POST" });
      router.refresh();
    });
  }
  function remove() {
    if (!confirm(`Delete instance "${instance.name}"? (kills tmux session then removes the row)`)) return;
    start(async () => {
      const r = await fetch(`/api/instances/${instance.id}`, { method: "DELETE" });
      if (r.ok) router.push("/instances");
      else alert((await r.json().catch(() => ({}))).error ?? "Delete failed");
    });
  }

  const canKill = instance.status === "running" || instance.status === "starting" || instance.status === "paused";

  return (
    <div className="space-y-6">
      <section className="bg-zinc-900 border border-zinc-800 rounded-md p-4">
        <div className="flex justify-between items-start mb-3">
          <div>
            <div className="text-xl font-semibold font-mono">{instance.name}</div>
            <div className="text-sm text-zinc-400 font-mono mt-1">tmux session: {instance.tmux_session}</div>
          </div>
          <StatusPill status={instance.status} />
        </div>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <Stat label="Project" value={project?.name ?? "—"} />
          <Stat label="Host" value={host ? `${host.ssh_user}@${host.address}:${host.port}` : "—"} />
          <Stat label="Working dir" value={project?.path_on_host ?? "—"} />
          <Stat label="Restart count" value={String(instance.restart_count)} />
          <Stat label="Spawned at" value={instance.spawned_at ? new Date(instance.spawned_at).toLocaleString() : "—"} />
          <Stat label="Stopped at" value={instance.stopped_at ? new Date(instance.stopped_at).toLocaleString() : "—"} />
          <Stat label="Last checked" value={instance.last_check_at ? new Date(instance.last_check_at).toLocaleString() : "—"} />
        </div>
        {instance.spawn_error && (
          <p className="mt-3 text-sm text-red-400 font-mono break-all">Error: {instance.spawn_error}</p>
        )}
        <div className="mt-4 flex gap-2">
          <button disabled={pending} onClick={refresh}
            className="bg-zinc-100 text-zinc-900 px-3 py-1.5 rounded text-sm font-medium disabled:opacity-50">
            {pending ? "…" : "Refresh status"}
          </button>
          <button disabled={pending || !canKill} onClick={kill}
            className="bg-yellow-900 text-yellow-100 px-3 py-1.5 rounded text-sm font-medium disabled:opacity-50">
            Kill
          </button>
          <button disabled={pending} onClick={remove}
            className="bg-red-900 text-red-100 px-3 py-1.5 rounded text-sm font-medium disabled:opacity-50">
            Delete
          </button>
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-zinc-500 text-xs mb-0.5">{label}</div>
      <div className="font-mono break-all">{value}</div>
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
