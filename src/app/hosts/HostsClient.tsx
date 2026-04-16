"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { HostRecord } from "@/lib/hosts";

export default function HostsClient({ initialHosts }: { initialHosts: HostRecord[] }) {
  const router = useRouter();
  const [showAdd, setShowAdd] = useState(false);

  return (
    <div className="space-y-4">
      <button
        onClick={() => setShowAdd((s) => !s)}
        className="bg-zinc-100 text-zinc-900 px-3 py-1.5 rounded text-sm font-medium"
      >
        {showAdd ? "Cancel" : "+ Add host"}
      </button>

      {showAdd && <AddForm onDone={() => { setShowAdd(false); router.refresh(); }} />}

      {initialHosts.length === 0 ? (
        <p className="text-zinc-500 text-sm">No hosts yet. Add one to begin probing.</p>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-zinc-800 text-left text-zinc-400">
              <th className="py-2 px-2">Name</th>
              <th className="py-2 px-2">Address</th>
              <th className="py-2 px-2">Status</th>
              <th className="py-2 px-2">Latency</th>
              <th className="py-2 px-2">Last probe</th>
              <th className="py-2 px-2"></th>
            </tr>
          </thead>
          <tbody>
            {initialHosts.map((h) => (
              <tr key={h.id} className="border-b border-zinc-900">
                <td className="py-2 px-2 font-mono">{h.name}</td>
                <td className="py-2 px-2 font-mono text-zinc-400">{h.ssh_user}@{h.address}:{h.port}</td>
                <td className="py-2 px-2"><StatusPill status={h.status} /></td>
                <td className="py-2 px-2 text-zinc-400">{h.last_latency_ms != null ? `${h.last_latency_ms}ms` : "—"}</td>
                <td className="py-2 px-2 text-zinc-400">{h.last_probe_at ? new Date(h.last_probe_at).toLocaleTimeString() : "—"}</td>
                <td className="py-2 px-2 text-right">
                  <Link href={`/hosts/${h.id}`} className="text-zinc-300 hover:text-zinc-100">Open →</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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

function AddForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [port, setPort] = useState("22");
  const [sshUser, setSshUser] = useState("");
  const [authMethod, setAuthMethod] = useState<"privkey" | "agent">("privkey");
  const [privkey, setPrivkey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [labels, setLabels] = useState("");
  const [gpu, setGpu] = useState("");
  const [cores, setCores] = useState("");
  const [ramMb, setRamMb] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const body = {
      name,
      address,
      port: parseInt(port || "22", 10),
      ssh_user: sshUser,
      auth_method: authMethod,
      privkey: authMethod === "privkey" ? privkey : undefined,
      passphrase: authMethod === "privkey" && passphrase ? passphrase : undefined,
      capabilities: {
        gpu: gpu || null,
        cores: cores ? parseInt(cores, 10) : undefined,
        ram_mb: ramMb ? parseInt(ramMb, 10) : undefined,
      },
      labels: labels ? labels.split(",").map((s) => s.trim()).filter(Boolean) : [],
    };
    start(async () => {
      const r = await fetch("/api/hosts", {
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
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name" value={name} onChange={setName} required />
        <Field label="Address (host or IP)" value={address} onChange={setAddress} required />
        <Field label="Port" value={port} onChange={setPort} />
        <Field label="SSH user" value={sshUser} onChange={setSshUser} required />
      </div>
      <label className="block text-sm">
        <span className="block mb-1">Auth method</span>
        <select
          value={authMethod}
          onChange={(e) => setAuthMethod(e.target.value as "privkey" | "agent")}
          className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5"
        >
          <option value="privkey">Private key (PEM)</option>
          <option value="agent">SSH agent (uses controller&apos;s SSH_AUTH_SOCK)</option>
        </select>
      </label>
      {authMethod === "privkey" && (
        <>
          <label className="block text-sm">
            <span className="block mb-1">Private key (PEM)</span>
            <textarea
              value={privkey}
              onChange={(e) => setPrivkey(e.target.value)}
              rows={6}
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 font-mono text-xs"
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;..."
            />
          </label>
          <Field label="Key passphrase (optional)" value={passphrase} onChange={setPassphrase} type="password" />
        </>
      )}
      <div className="grid grid-cols-3 gap-3">
        <Field label="GPU (optional)" value={gpu} onChange={setGpu} />
        <Field label="Cores (optional)" value={cores} onChange={setCores} />
        <Field label="RAM MB (optional)" value={ramMb} onChange={setRamMb} />
      </div>
      <Field label="Labels (comma-separated)" value={labels} onChange={setLabels} />
      {error && <p className="text-sm text-red-400">{error}</p>}
      <button type="submit" disabled={pending}
        className="bg-zinc-100 text-zinc-900 px-3 py-1.5 rounded text-sm font-medium disabled:opacity-50">
        {pending ? "Saving…" : "Save host"}
      </button>
    </form>
  );
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
