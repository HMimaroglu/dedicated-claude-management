"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { HostRecord, ProbeSnapshot } from "@/lib/hosts";

export default function HostDetailClient({
  host,
  probes,
}: {
  host: HostRecord;
  probes: ProbeSnapshot[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);

  function act(path: string, method = "POST") {
    start(async () => {
      const r = await fetch(path, { method });
      if (r.ok) router.refresh();
      else alert((await r.json().catch(() => ({}))).error ?? "Failed");
    });
  }

  function remove() {
    if (!confirm(`Delete host "${host.name}"?`)) return;
    start(async () => {
      const r = await fetch(`/api/hosts/${host.id}`, { method: "DELETE" });
      if (r.ok) router.push("/hosts");
      else alert((await r.json().catch(() => ({}))).error ?? "Delete failed");
    });
  }

  return (
    <div className="space-y-6">
      <section className="bg-zinc-900 border border-zinc-800 rounded-md p-4">
        <div className="flex justify-between items-start mb-3">
          <div>
            <div className="text-xl font-semibold font-mono">{host.name}</div>
            <div className="text-sm text-zinc-400 font-mono">
              {host.ssh_user}@{host.address}:{host.port}
            </div>
          </div>
          <StatusPill status={host.status} />
        </div>
        <div className="grid grid-cols-4 gap-3 text-sm">
          <Stat label="Latency" value={host.last_latency_ms != null ? `${host.last_latency_ms}ms` : "—"} />
          <Stat label="Consec. failures" value={String(host.consecutive_failures)} />
          <Stat label="Cores" value={host.capabilities.cores?.toString() ?? "—"} />
          <Stat label="RAM" value={host.capabilities.ram_mb ? `${Math.round(host.capabilities.ram_mb / 1024)} GB (${host.capabilities.ram_mb} MB)` : "—"} />
          <Stat label="Storage" value={host.capabilities.storage_gb ? `${host.capabilities.storage_gb} GB` : "—"} />
          <Stat label="GPU" value={host.capabilities.gpu ?? "—"} />
          <Stat label="GPU count" value={host.capabilities.gpu_count?.toString() ?? "—"} />
          <Stat label="Labels" value={host.labels.join(", ") || "—"} />
          <Stat label="Auth" value={host.auth_method} />
          <Stat label="Last probe" value={host.last_probe_at ? new Date(host.last_probe_at).toLocaleString() : "—"} />
        </div>
        {host.last_probe_error && (
          <p className="mt-3 text-sm text-red-400 font-mono break-all">
            Error: {host.last_probe_error}
          </p>
        )}
        <div className="mt-4 flex gap-2">
          <button disabled={pending} onClick={() => act(`/api/hosts/${host.id}/probe`)}
            className="bg-zinc-100 text-zinc-900 px-3 py-1.5 rounded text-sm font-medium disabled:opacity-50">
            {pending ? "…" : "Probe now"}
          </button>
          <button disabled={pending} onClick={() => act(`/api/hosts/${host.id}/scan`)}
            className="bg-zinc-100 text-zinc-900 px-3 py-1.5 rounded text-sm font-medium disabled:opacity-50">
            {pending ? "…" : "Re-scan capabilities"}
          </button>
          <button onClick={() => setEditing((v) => !v)}
            className="bg-zinc-800 text-zinc-100 px-3 py-1.5 rounded text-sm font-medium">
            {editing ? "Cancel edit" : "Edit"}
          </button>
          {host.status === "quarantined" && (
            <button disabled={pending} onClick={() => act(`/api/hosts/${host.id}/unquarantine`)}
              className="bg-yellow-900 text-yellow-100 px-3 py-1.5 rounded text-sm font-medium disabled:opacity-50">
              Unquarantine
            </button>
          )}
          <button disabled={pending} onClick={remove}
            className="bg-red-900 text-red-100 px-3 py-1.5 rounded text-sm font-medium disabled:opacity-50">
            Delete
          </button>
        </div>
      </section>

      {editing && (
        <EditForm host={host} onDone={() => { setEditing(false); router.refresh(); }} />
      )}

      <SshKeySetup host={host} onDone={() => router.refresh()} />

      <section>
        <h3 className="text-sm font-semibold mb-2 text-zinc-400">Recent probes</h3>
        {probes.length === 0 ? (
          <p className="text-sm text-zinc-500">No probes yet.</p>
        ) : (
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-zinc-800 text-left text-zinc-400">
                <th className="py-1 px-2">Time</th>
                <th className="py-1 px-2">OK</th>
                <th className="py-1 px-2">Latency</th>
                <th className="py-1 px-2">Load 1m</th>
                <th className="py-1 px-2">Mem</th>
                <th className="py-1 px-2">Disk</th>
                <th className="py-1 px-2">GPU</th>
                <th className="py-1 px-2">Error</th>
              </tr>
            </thead>
            <tbody>
              {probes.map((p, i) => (
                <tr key={i} className="border-b border-zinc-900">
                  <td className="py-1 px-2">{new Date(p.probed_at).toLocaleTimeString()}</td>
                  <td className="py-1 px-2">{p.success ? "✓" : "✗"}</td>
                  <td className="py-1 px-2">{p.latency_ms != null ? `${p.latency_ms}ms` : "—"}</td>
                  <td className="py-1 px-2">{p.cpu_load_1m != null ? p.cpu_load_1m.toFixed(2) : "—"}</td>
                  <td className="py-1 px-2">
                    {p.mem_used_mb != null && p.mem_total_mb != null
                      ? `${p.mem_used_mb}/${p.mem_total_mb}MB`
                      : "—"}
                  </td>
                  <td className="py-1 px-2">{p.disk_used_pct != null ? `${p.disk_used_pct}%` : "—"}</td>
                  <td className="py-1 px-2 max-w-xs truncate">
                    {p.gpu_info ? JSON.stringify(p.gpu_info) : "—"}
                  </td>
                  <td className="py-1 px-2 text-red-400 max-w-xs truncate">{p.error ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function EditForm({ host, onDone }: { host: HostRecord; onDone: () => void }) {
  const [name, setName] = useState(host.name);
  const [address, setAddress] = useState(host.address);
  const [port, setPort] = useState(String(host.port));
  const [sshUser, setSshUser] = useState(host.ssh_user);
  const [cores, setCores] = useState(host.capabilities.cores?.toString() ?? "");
  const [ramMb, setRamMb] = useState(host.capabilities.ram_mb?.toString() ?? "");
  const [storageGb, setStorageGb] = useState(host.capabilities.storage_gb?.toString() ?? "");
  const [gpu, setGpu] = useState(host.capabilities.gpu ?? "");
  const [gpuCount, setGpuCount] = useState(host.capabilities.gpu_count?.toString() ?? "");
  const [labels, setLabels] = useState(host.labels.join(", "));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const body: Record<string, unknown> = {
        name, address, port: parseInt(port, 10), ssh_user: sshUser,
        capabilities: {
          cores: cores ? parseInt(cores, 10) : undefined,
          ram_mb: ramMb ? parseInt(ramMb, 10) : undefined,
          storage_gb: storageGb ? parseInt(storageGb, 10) : undefined,
          gpu: gpu || null,
          gpu_count: gpuCount ? parseInt(gpuCount, 10) : undefined,
        },
        labels: labels ? labels.split(",").map((s) => s.trim()).filter(Boolean) : [],
      };
      const r = await fetch(`/api/hosts/${host.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "Update failed");
        return;
      }
      onDone();
    });
  }

  return (
    <form onSubmit={submit} className="bg-zinc-900 border border-zinc-800 rounded-md p-4 space-y-3">
      <h3 className="text-sm font-semibold text-zinc-400">Edit host</h3>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name" value={name} onChange={setName} required />
        <Field label="Address" value={address} onChange={setAddress} required />
        <Field label="Port" value={port} onChange={setPort} />
        <Field label="SSH user" value={sshUser} onChange={setSshUser} required />
      </div>
      <div className="grid grid-cols-4 gap-3">
        <Field label="Cores" value={cores} onChange={setCores} />
        <Field label="RAM (MB)" value={ramMb} onChange={setRamMb} />
        <Field label="Storage (GB)" value={storageGb} onChange={setStorageGb} />
        <Field label="GPU" value={gpu} onChange={setGpu} />
        <Field label="GPU count" value={gpuCount} onChange={setGpuCount} />
      </div>
      <Field label="Labels (comma-separated)" value={labels} onChange={setLabels} />
      {error && <p className="text-sm text-red-400">{error}</p>}
      <button type="submit" disabled={pending}
        className="bg-zinc-100 text-zinc-900 px-3 py-1.5 rounded text-sm font-medium disabled:opacity-50">
        {pending ? "Saving…" : "Save"}
      </button>
    </form>
  );
}

function SshKeySetup({ host, onDone }: { host: HostRecord; onDone: () => void }) {
  const [show, setShow] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();

  if (done) return null;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const r = await fetch(`/api/hosts/${host.id}/setup-key`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "Failed");
        return;
      }
      setPassword("");
      setShow(false);
      setDone(true);
      onDone();
    });
  }

  return (
    <section className="bg-zinc-900 border border-zinc-800 rounded-md p-4">
      <div className="flex justify-between items-start">
        <div>
          <h3 className="text-sm font-semibold">Push SSH key</h3>
          <p className="text-xs text-zinc-400 mt-1">
            One-time password to push your key. Password is never stored.
          </p>
        </div>
        <button onClick={() => setShow((v) => !v)}
          className="bg-zinc-800 text-zinc-100 px-3 py-1.5 rounded text-sm font-medium">
          {show ? "Cancel" : "Setup key"}
        </button>
      </div>
      {show && (
        <form onSubmit={submit} className="mt-3 flex gap-2 items-end">
          <label className="flex-1 text-sm">
            <span className="block mb-1">SSH password</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              required className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5" />
          </label>
          <button type="submit" disabled={pending}
            className="bg-zinc-100 text-zinc-900 px-3 py-1.5 rounded text-sm font-medium disabled:opacity-50">
            {pending ? "Pushing…" : "Push key"}
          </button>
          {error && <p className="text-sm text-red-400 ml-2">{error}</p>}
        </form>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-zinc-500 text-xs mb-0.5">{label}</div>
      <div className="font-mono">{value}</div>
    </div>
  );
}

function StatusPill({ status }: { status: HostRecord["status"] }) {
  const color =
    status === "online" ? "bg-emerald-900 text-emerald-300" :
    status === "quarantined" ? "bg-red-900 text-red-300" :
    status === "offline" ? "bg-yellow-900 text-yellow-300" :
    status === "error" ? "bg-red-900 text-red-300" :
    "bg-zinc-800 text-zinc-400";
  return <span className={`px-2 py-0.5 rounded text-xs ${color}`}>{status}</span>;
}

function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
}) {
  return (
    <label className="block text-sm">
      <span className="block mb-1">{props.label}</span>
      <input
        type={props.type ?? "text"}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        required={props.required}
        className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5"
      />
    </label>
  );
}
