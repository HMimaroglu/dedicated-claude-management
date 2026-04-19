import { redirect } from "next/navigation";
import { hasAnyUser } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { computeDashboard } from "@/lib/dashboard-metrics";
import LogoutButton from "./LogoutButton";
import LiveLocalMetrics from "./LiveLocalMetrics";
import LiveRemoteHosts from "./LiveRemoteHosts";
import { Nav } from "../Nav";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  if (!hasAnyUser()) redirect("/setup");
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const { totals, hosts, local } = await computeDashboard();
  const memUsedPct = totals.ram_total_mb > 0 ? (totals.ram_used_mb / totals.ram_total_mb) * 100 : null;

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
        <LiveLocalMetrics initial={local} />
      </section>

      <section>
        <h2 className="text-sm font-semibold text-zinc-400 mb-3">Remote hosts — CPU load (last 30 probes)</h2>
        <LiveRemoteHosts initial={hosts.map((m) => ({
          id: m.host.id,
          name: m.host.name,
          status: m.host.status,
          capabilities: m.host.capabilities,
          latest: m.latest && m.latest.success ? m.latest : null,
          series: m.series
            .filter((p) => p.success && p.cpu_load_1m !== null)
            .map((p) => p.cpu_load_1m as number)
            .reverse(),
        }))} />
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

