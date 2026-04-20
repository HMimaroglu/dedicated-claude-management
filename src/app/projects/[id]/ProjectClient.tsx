"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { ProjectRecord, PathExistsResult } from "@/lib/projects";
import type { HostRecord } from "@/lib/hosts";

export default function ProjectClient({
  project,
  host,
  controllerPath,
}: {
  project: ProjectRecord;
  host: HostRecord | null;
  controllerPath: PathExistsResult | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [cloneOut, setCloneOut] = useState<{ stdout: string; stderr: string; error: string | null } | null>(null);

  function clone() {
    start(async () => {
      const r = await fetch(`/api/projects/${project.id}/clone`, { method: "POST" });
      const j = (await r.json().catch(() => ({}))) as { stdout?: string; stderr?: string; error?: string | null };
      setCloneOut({ stdout: j.stdout ?? "", stderr: j.stderr ?? "", error: j.error ?? null });
      router.refresh();
    });
  }

  function remove() {
    if (!confirm(`Delete project "${project.name}"? (This does NOT delete files on the host.)`)) return;
    start(async () => {
      const r = await fetch(`/api/projects/${project.id}`, { method: "DELETE" });
      if (r.ok) router.push("/projects");
      else alert((await r.json().catch(() => ({}))).error ?? "Delete failed");
    });
  }

  return (
    <div className="space-y-6">
      <section className="bg-zinc-900 border border-zinc-800 rounded-md p-4">
        <div className="flex justify-between items-start mb-3">
          <div>
            <div className="text-xl font-semibold font-mono">{project.name}</div>
            {project.description && <div className="text-sm text-zinc-400 mt-1">{project.description}</div>}
          </div>
          <StatusPill status={project.clone_status} />
        </div>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <Stat label="Source" value={project.source_type} />
          <Stat
            label="Stored on"
            value={project.host_id === null ? "local (controller)" : (host?.name ?? `#${project.host_id}`)}
          />
          {project.source_type === "git" && (
            <>
              <Stat label="Git URL" value={project.git_url ?? "—"} />
              <Stat label="Branch" value={project.git_branch ?? "(default)"} />
            </>
          )}
          <Stat
            label="Local path"
            value={project.path_on_host}
            badge={controllerPath ? <PathBadge result={controllerPath} /> : null}
          />
          {project.source_type === "git" && (
            <Stat
              label="Last cloned"
              value={project.last_cloned_at ? new Date(project.last_cloned_at).toLocaleString() : "—"}
            />
          )}
        </div>
        {project.clone_error && (
          <p className="mt-3 text-sm text-red-400 font-mono break-all">Error: {project.clone_error}</p>
        )}
        <div className="mt-4 flex gap-2">
          {project.source_type === "git" && (
            <button disabled={pending || project.clone_status === "cloning"} onClick={clone}
              className="bg-zinc-100 text-zinc-900 px-3 py-1.5 rounded text-sm font-medium disabled:opacity-50">
              {pending ? "…" : project.clone_status === "ready" ? "Re-clone" : "Clone now"}
            </button>
          )}
          <button disabled={pending} onClick={remove}
            className="bg-red-900 text-red-100 px-3 py-1.5 rounded text-sm font-medium disabled:opacity-50">
            Delete
          </button>
        </div>
      </section>
      {cloneOut && (
        <section>
          <h3 className="text-sm font-semibold mb-2 text-zinc-400">Clone output</h3>
          <pre className="bg-zinc-950 border border-zinc-800 rounded-md p-3 text-xs overflow-x-auto whitespace-pre-wrap">
{(cloneOut.stderr || cloneOut.stdout || cloneOut.error) ?? "(no output)"}
          </pre>
        </section>
      )}

    </div>
  );
}

function Stat({ label, value, badge }: { label: string; value: string; badge?: React.ReactNode }) {
  return (
    <div>
      <div className="text-zinc-500 text-xs mb-0.5 flex items-center gap-2">
        <span>{label}</span>
        {badge}
      </div>
      <div className="font-mono break-all">{value}</div>
    </div>
  );
}

function PathBadge({ result }: { result: PathExistsResult }) {
  if (result.exists && result.isDirectory) {
    return <span className="px-1.5 py-0.5 rounded text-[10px] bg-emerald-900 text-emerald-300">exists on controller</span>;
  }
  if (result.exists) {
    return <span className="px-1.5 py-0.5 rounded text-[10px] bg-yellow-900 text-yellow-300">not a directory</span>;
  }
  return <span className="px-1.5 py-0.5 rounded text-[10px] bg-red-900 text-red-300">does not exist on controller</span>;
}

function StatusPill({ status }: { status: ProjectRecord["clone_status"] }) {
  const color =
    status === "ready" ? "bg-emerald-900 text-emerald-300" :
    status === "error" ? "bg-red-900 text-red-300" :
    status === "cloning" ? "bg-blue-900 text-blue-300" :
    status === "skipped" ? "bg-zinc-700 text-zinc-300" :
    "bg-yellow-900 text-yellow-300";
  return <span className={`px-2 py-0.5 rounded text-xs ${color}`}>{status}</span>;
}
