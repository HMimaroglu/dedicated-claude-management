import os from "node:os";
import { execLocal } from "./local-exec";
import type { Db } from "./db";
import { getDb } from "./db";
import { listHosts, recentProbes, type HostRecord, type ProbeSnapshot } from "./hosts";
import { listInstances } from "./instances";

export interface HostMetric {
  host: HostRecord;
  latest: ProbeSnapshot | null;
  series: ProbeSnapshot[]; // newest first; UI should reverse for left-to-right time axis
}

// Live snapshot of the controller's own resources. The controller isn't a
// row in `hosts` — local instances/projects use host_id=null — so we surface
// its utilization as its own object on the dashboard.
export interface LocalMetric {
  hostname: string;
  platform: string;
  cores: number;
  load_1m: number; // system load avg (1-min), BSD-style queue metric
  cpu_pct: number; // 0..100 aggregated across all cores, Activity-Monitor-style
  mem_total_mb: number;
  mem_used_mb: number; // Activity-Monitor-style (wired+active+compressed on darwin)
  uptime_sec: number;
}

// Samples os.cpus() twice separated by `ms` and computes the aggregate CPU
// busy percentage (0..100) across cores. Matches how Activity Monitor
// reports CPU: 50% = half of all cores busy. Caller awaits ~200ms.
async function sampleCpuPct(ms = 200): Promise<number> {
  const s1 = os.cpus();
  await new Promise((r) => setTimeout(r, ms));
  const s2 = os.cpus();
  let totalDelta = 0;
  let idleDelta = 0;
  for (let i = 0; i < s1.length; i++) {
    const a = s1[i]?.times;
    const b = s2[i]?.times;
    if (!a || !b) continue;
    const aSum = a.user + a.nice + a.sys + a.idle + a.irq;
    const bSum = b.user + b.nice + b.sys + b.idle + b.irq;
    totalDelta += bSum - aSum;
    idleDelta += b.idle - a.idle;
  }
  if (totalDelta <= 0) return 0;
  const busy = (totalDelta - idleDelta) / totalDelta;
  return Math.max(0, Math.min(100, busy * 100));
}

// On macOS, os.freemem() reports ONLY free pages. Activity Monitor's "Memory
// Used" is wired + active + compressed (cached pages aren't counted). We
// exec `vm_stat` to get those counters and compute the same number.
async function resolveMemUsedMb(totalMb: number): Promise<number> {
  if (os.platform() !== "darwin") {
    const freeMb = Math.round(os.freemem() / (1024 * 1024));
    return Math.max(0, totalMb - freeMb);
  }
  try {
    const r = await execLocal("vm_stat", { timeoutMs: 2_000 });
    if (r.code !== 0) throw new Error(`vm_stat exited ${r.code}`);
    const pageSizeMatch = r.stdout.match(/page size of (\d+) bytes/);
    const pageSize = pageSizeMatch && pageSizeMatch[1] ? parseInt(pageSizeMatch[1], 10) : 4096;
    const get = (re: RegExp): number => {
      const m = r.stdout.match(re);
      return m && m[1] ? parseInt(m[1], 10) : 0;
    };
    const wired = get(/Pages wired down:\s+(\d+)/);
    const active = get(/Pages active:\s+(\d+)/);
    const compressed = get(/Pages occupied by compressor:\s+(\d+)/);
    const usedPages = wired + active + compressed;
    return Math.round((usedPages * pageSize) / (1024 * 1024));
  } catch {
    // Fall back to os.freemem accounting if vm_stat fails.
    const freeMb = Math.round(os.freemem() / (1024 * 1024));
    return Math.max(0, totalMb - freeMb);
  }
}

export async function computeLocalMetric(): Promise<LocalMetric> {
  const totalMb = Math.round(os.totalmem() / (1024 * 1024));
  const [cpuPct, memUsedMb] = await Promise.all([
    sampleCpuPct(200),
    resolveMemUsedMb(totalMb),
  ]);
  return {
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.arch()}`,
    cores: os.cpus().length,
    load_1m: os.loadavg()[0] ?? 0,
    cpu_pct: cpuPct,
    mem_total_mb: totalMb,
    mem_used_mb: memUsedMb,
    uptime_sec: Math.floor(os.uptime()),
  };
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

export async function computeDashboard(
  d?: Db
): Promise<{ totals: Totals; hosts: HostMetric[]; local: LocalMetric }> {
  const db = d ?? getDb();
  const hosts = listHosts(db);
  const instances = listInstances(db);

  const metrics: HostMetric[] = hosts.map((h) => {
    const series = recentProbes(h.id, 30, db);
    const latest = series.find((p) => p.success) ?? series[0] ?? null;
    return { host: h, latest, series };
  });

  // Local/controller counts as the implicit first machine — include its
  // cores + RAM in the aggregate totals.
  const local = await computeLocalMetric();

  let ram_total_mb = local.mem_total_mb;
  let ram_used_mb = local.mem_used_mb;
  let cores_total = local.cores;
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
    // hosts counts remote hosts only; the controller is surfaced separately
    // as `local`. Running/online counts still refer to configured hosts.
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

  return { totals, hosts: metrics, local };
}
