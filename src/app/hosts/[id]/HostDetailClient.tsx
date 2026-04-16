"use client";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
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
          <Stat label="RAM MB" value={host.capabilities.ram_mb?.toString() ?? "—"} />
          <Stat label="GPU" value={host.capabilities.gpu ?? "—"} />
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
