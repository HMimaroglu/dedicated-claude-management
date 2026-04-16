"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { ProjectRecord } from "@/lib/projects";
import type { HostRecord } from "@/lib/hosts";

export default function ProjectsClient({
  initialProjects,
  hosts,
}: {
  initialProjects: ProjectRecord[];
  hosts: HostRecord[];
}) {
  const router = useRouter();
  const [showAdd, setShowAdd] = useState(false);
  return (
    <div className="space-y-4">
      <button
        onClick={() => setShowAdd((s) => !s)}
        className="bg-zinc-100 text-zinc-900 px-3 py-1.5 rounded text-sm font-medium"
      >
        {showAdd ? "Cancel" : "+ Add project"}
      </button>
      {hosts.length === 0 && !showAdd && (
        <p className="text-sm text-zinc-500">
          Projects default to running on this machine (the controller).{" "}
          <Link href="/hosts" className="underline">Add remote hosts →</Link>{" "}
          when you want more compute.
        </p>
      )}
      {showAdd && (
        <AddForm hosts={hosts} onDone={() => { setShowAdd(false); router.refresh(); }} />
      )}
      {initialProjects.length === 0 ? (
        <p className="text-zinc-500 text-sm">No projects yet.</p>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-zinc-800 text-left text-zinc-400">
              <th className="py-2 px-2">Name</th>
              <th className="py-2 px-2">Source</th>
              <th className="py-2 px-2">Host</th>
              <th className="py-2 px-2">Path</th>
              <th className="py-2 px-2">Status</th>
              <th className="py-2 px-2"></th>
            </tr>
          </thead>
          <tbody>
            {initialProjects.map((p) => {
              const host = hosts.find((h) => h.id === p.host_id);
              return (
                <tr key={p.id} className="border-b border-zinc-900">
                  <td className="py-2 px-2 font-mono">{p.name}</td>
                  <td className="py-2 px-2 text-zinc-400">{p.source_type}</td>
                  <td className="py-2 px-2 font-mono text-zinc-400">
                    {p.host_id === null ? "local (controller)" : (host?.name ?? "—")}
                  </td>
                  <td className="py-2 px-2 font-mono text-zinc-400 truncate max-w-xs">{p.path_on_host}</td>
                  <td className="py-2 px-2"><StatusPill status={p.clone_status} /></td>
                  <td className="py-2 px-2 text-right">
                    <Link href={`/projects/${p.id}`} className="text-zinc-300 hover:text-zinc-100">Open →</Link>
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

function StatusPill({ status }: { status: ProjectRecord["clone_status"] }) {
  // "skipped" is an internal value meaning "source_type=local, nothing to
  // clone". Display it as "ready" so the UI matches how the user thinks
  // about the project — the files are on disk and usable.
  const label = status === "skipped" ? "ready" : status;
  const color =
    status === "ready" || status === "skipped" ? "bg-emerald-900 text-emerald-300" :
    status === "error" ? "bg-red-900 text-red-300" :
    status === "cloning" ? "bg-blue-900 text-blue-300" :
    "bg-yellow-900 text-yellow-300";
  return <span className={`px-2 py-0.5 rounded text-xs ${color}`}>{label}</span>;
}

function AddForm({ onDone }: { hosts: HostRecord[]; onDone: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [sourceType, setSourceType] = useState<"git" | "local">("git");
  const [gitUrl, setGitUrl] = useState("");
  const [gitBranch, setGitBranch] = useState("");
  const [pathOnHost, setPathOnHost] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    // Projects are always local (stored/managed on the controller). Remote
    // hosts come in at instance-spawn time for extra compute.
    const body: Record<string, unknown> = {
      name,
      description: description || undefined,
      source_type: sourceType,
      host_id: null,
      path_on_host: pathOnHost,
    };
    if (sourceType === "git") {
      body.git_url = gitUrl;
      if (gitBranch) body.git_branch = gitBranch;
    }
    start(async () => {
      const r = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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
      <Field label="Name" value={name} onChange={setName} required />
      <label className="block text-sm">
        <span className="block mb-1">Description (optional)</span>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5"
        />
      </label>
      <label className="block text-sm">
        <span className="block mb-1">Source</span>
        <select value={sourceType} onChange={(e) => setSourceType(e.target.value as "git" | "local")}
          className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5">
          <option value="git">Git repository (will be cloned)</option>
          <option value="local">Local path on host (already present)</option>
        </select>
      </label>
      {sourceType === "git" && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Git URL" value={gitUrl} onChange={setGitUrl} required placeholder="https://github.com/…" />
          <Field label="Branch (optional)" value={gitBranch} onChange={setGitBranch} placeholder="main" />
        </div>
      )}
      <Field
        label={sourceType === "git" ? "Clone to (local path)" : "Local path"}
        value={pathOnHost}
        onChange={setPathOnHost}
        required
        placeholder="/Users/you/projects/my-repo"
      />
      <p className="text-xs text-zinc-500">
        Projects always live on this machine (the controller). Remote hosts are
        only used when you explicitly spawn an instance on one for extra compute.
      </p>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <button type="submit" disabled={pending}
        className="bg-zinc-100 text-zinc-900 px-3 py-1.5 rounded text-sm font-medium disabled:opacity-50">
        {pending ? "Saving…" : "Save project"}
      </button>
    </form>
  );
}

function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
  type?: string;
}) {
  return (
    <label className="block text-sm">
      <span className="block mb-1">{props.label}</span>
      <input
        type={props.type ?? "text"}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        required={props.required}
        placeholder={props.placeholder}
        className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5"
      />
    </label>
  );
}
