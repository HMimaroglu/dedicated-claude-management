import type { Db } from "./db";
import { getDb } from "./db";
import { listHosts, recentProbes, type HostRecord, type ProbeSnapshot } from "./hosts";
import { listInstances } from "./instances";

export interface HostMetric {
  host: HostRecord;
  latest: ProbeSnapshot | null;
  series: ProbeSnapshot[]; // newest first; UI should reverse for left-to-right time axis
}

export interface Totals {
  hosts: number;
  online: number;
  quarantined: number;
  instances: number;
  running: number;
  paused: number;
  crashed: number;
  cores_total: number;
  ram_total_mb: number;
  ram_used_mb: number; // across hosts with fresh successful probe
  gpu_count: number;
}

export function computeDashboard(d?: Db): { totals: Totals; hosts: HostMetric[] } {
  const db = d ?? getDb();
  const hosts = listHosts(db);
  const instances = listInstances(db);

  const metrics: HostMetric[] = hosts.map((h) => {
    const series = recentProbes(h.id, 30, db);
    const latest = series.find((p) => p.success) ?? series[0] ?? null;
    return { host: h, latest, series };
  });

  let ram_total_mb = 0;
  let ram_used_mb = 0;
  let cores_total = 0;
  let gpu_count = 0;
  for (const m of metrics) {
    cores_total += m.host.capabilities.cores ?? 0;
    if (m.host.capabilities.gpu && m.host.capabilities.gpu !== "none") {
      gpu_count += m.host.capabilities.gpu_count ?? 1;
    }
    if (m.latest && m.latest.success && m.latest.mem_total_mb && m.latest.mem_used_mb != null) {
      ram_total_mb += m.latest.mem_total_mb;
      ram_used_mb += m.latest.mem_used_mb;
    }
  }

  const totals: Totals = {
    hosts: hosts.length,
    online: hosts.filter((h) => h.status === "online").length,
    quarantined: hosts.filter((h) => h.status === "quarantined").length,
    instances: instances.length,
    running: instances.filter((i) => i.status === "running").length,
    paused: instances.filter((i) => i.status === "paused").length,
    crashed: instances.filter((i) => i.status === "crashed").length,
    cores_total,
    ram_total_mb,
    ram_used_mb,
    gpu_count,
  };

  return { totals, hosts: metrics };
}
