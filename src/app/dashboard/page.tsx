import Link from "next/link";
import { redirect } from "next/navigation";
import { hasAnyUser } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { computeDashboard } from "@/lib/dashboard-metrics";
import LogoutButton from "./LogoutButton";
import Sparkline from "./Sparkline";
import { Nav } from "../Nav";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  if (!hasAnyUser()) redirect("/setup");
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const { totals, hosts, local } = await computeDashboard();
  const memUsedPct = totals.ram_total_mb > 0 ? (totals.ram_used_mb / totals.ram_total_mb) * 100 : null;
  const localMemPct = local.mem_total_mb > 0 ? (local.mem_used_mb / local.mem_total_mb) * 100 : 0;

  return (
    <main className="max-w-5xl mx-auto pt-12 px-4 pb-16">
      <header className="flex justify-between items-center mb-8">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-semibold">DCM</h1>
          <Nav current="dashboard" />
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-zinc-400">{user.username}</span>
          <LogoutButton />
        </div>
      </header>

      <section className="grid grid-cols-5 gap-3 mb-8">
        <StatCard label="Hosts" value={`${totals.online}/${totals.hosts}`} sub="online/total" />
        <StatCard
          label="Quarantined"
          value={totals.quarantined.toString()}
          tone={totals.quarantined > 0 ? "warn" : undefined}
        />
        <StatCard label="Instances" value={`${totals.running}/${totals.instances}`} sub="running/total" />
        <StatCard
          label="Crashed"
          value={totals.crashed.toString()}
          tone={totals.crashed > 0 ? "warn" : undefined}
        />
        <StatCard label="GPUs" value={totals.gpu_count.toString()} />
      </section>

      <section className="grid grid-cols-3 gap-3 mb-8">
        <StatCard label="Total cores" value={totals.cores_total.toString()} />
        <StatCard
          label="RAM used"
          value={memUsedPct !== null ? `${memUsedPct.toFixed(0)}%` : "—"}
          sub={memUsedPct !== null ? `${Math.round(totals.ram_used_mb / 1024)} / ${Math.round(totals.ram_total_mb / 1024)} GB` : "no fresh probes"}
        />
        <StatCard label="Paused" value={totals.paused.toString()} />
      </section>

      <section className="mb-8">
        <h2 className="text-sm font-semibold text-zinc-400 mb-3">Local (controller)</h2>
        <div className="bg-zinc-900 border border-zinc-800 rounded-md p-4">
          <div className="flex justify-between items-start mb-3">
            <div>
              <div className="text-xl font-semibold font-mono">{local.hostname}</div>
              <div className="text-xs text-zinc-500 mt-0.5">{local.platform} · {local.cores} cores</div>
            </div>
            <span className="px-2 py-0.5 rounded text-xs bg-emerald-900 text-emerald-300">online</span>
          </div>
          <div className="grid grid-cols-3 gap-3 text-sm">
            <Stat
              label="CPU"
              value={`${local.cpu_pct.toFixed(0)}%`}
              bar={local.cpu_pct}
              sub={`load ${local.load_1m.toFixed(2)}`}
              tone={local.cpu_pct > 80 ? "warn" : "ok"}
            />
            <Stat
              label="Memory"
              value={`${localMemPct.toFixed(0)}%`}
              bar={localMemPct}
              sub={`${Math.round(local.mem_used_mb / 1024)} / ${Math.round(local.mem_total_mb / 1024)} GB`}
              tone={localMemPct > 85 ? "warn" : "ok"}
            />
            <Stat label="Uptime" value={formatUptime(local.uptime_sec)} />
          </div>
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-zinc-400 mb-3">Remote hosts — CPU load (last 30 probes)</h2>
        {hosts.length === 0 ? (
          <p className="text-sm text-zinc-500">
            No remote hosts registered.{" "}
            <Link href="/hosts" className="underline">Add one →</Link>{" "}
            when you want more compute.
          </p>
        ) : (
          <div className="space-y-2">
            {hosts.map((m) => {
              const points = m.series
                .filter((p) => p.success && p.cpu_load_1m !== null)
                .map((p) => p.cpu_load_1m as number)
                .reverse();
              const cores = m.host.capabilities.cores ?? 1;
              const maxY = Math.max(cores, ...points, 1);
              const latest = m.latest && m.latest.success ? m.latest : null;
              return (
                <div key={m.host.id} className="flex items-center gap-3 bg-zinc-900 border border-zinc-800 rounded-md p-3">
                  <div className="w-40 text-sm min-w-0">
                    <Link href={`/hosts/${m.host.id}`} className="font-mono truncate block hover:text-zinc-100">
                      {m.host.name}
                    </Link>
                    <span className={`text-xs ${m.host.status === "online" ? "text-emerald-400" : "text-zinc-500"}`}>
                      {m.host.status}
                    </span>
                  </div>
                  <div className="flex-1">
                    <Sparkline values={points} maxY={maxY} />
                  </div>
                  <div className="w-32 text-right text-xs font-mono text-zinc-400">
                    {latest ? (
                      <>
                        <div>load {latest.cpu_load_1m?.toFixed(2) ?? "—"}</div>
                        <div>
                          mem {latest.mem_used_mb ?? "?"}/{latest.mem_total_mb ?? "?"} MB
                        </div>
                      </>
                    ) : (
                      <span className="text-zinc-600">no data</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

    </main>
  );
}

function StatCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "warn";
}) {
  return (
    <div className={`bg-zinc-900 border rounded-md p-4 ${tone === "warn" ? "border-red-900" : "border-zinc-800"}`}>
      <div className="text-xs text-zinc-500 mb-1">{label}</div>
      <div className="text-2xl font-mono">{value}</div>
      {sub && <div className="text-xs text-zinc-500 mt-1">{sub}</div>}
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  bar,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  bar?: number;
  tone?: "ok" | "warn";
}) {
  return (
    <div>
      <div className="text-zinc-500 text-xs mb-0.5">{label}</div>
      <div className="font-mono">{value}</div>
      {sub && <div className="text-zinc-500 text-xs mt-0.5">{sub}</div>}
      {bar !== undefined && (
        <div className="mt-1 h-1 bg-zinc-800 rounded overflow-hidden">
          <div
            className={`h-full ${tone === "warn" ? "bg-red-500" : "bg-emerald-500"}`}
            style={{ width: `${Math.min(100, Math.max(0, bar))}%` }}
          />
        </div>
      )}
    </div>
  );
}

function formatUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}
