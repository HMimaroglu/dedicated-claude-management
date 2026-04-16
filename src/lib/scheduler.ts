import type { Db } from "./db";
import { getDb } from "./db";
import { listHosts, recentProbes, type HostRecord } from "./hosts";
import type { InstanceRequirements } from "./instances";

export interface HostScore {
  host: HostRecord;
  score: number; // higher is better. 0 = rejected.
  reasons: string[]; // human-readable rationale
}

export interface Capacity {
  cpu_free_pct: number; // 0..100, based on 1-minute load vs cores
  mem_free_pct: number;
  gpu_free_pct: number | null; // null if no GPU
  last_probed_at: number | null;
}

// Inspects the most recent successful probe for a host and distills a simple
// free-capacity view used in ranking. If no recent successful probe, return
// capacities = 0 (we don't know anything fresh).
export function hostCapacity(host: HostRecord, d?: Db): Capacity {
  const db = d ?? getDb();
  const probes = recentProbes(host.id, 10, db);
  const successful = probes.find((p) => p.success);
  if (!successful) {
    return { cpu_free_pct: 0, mem_free_pct: 0, gpu_free_pct: null, last_probed_at: null };
  }
  const cores = host.capabilities.cores ?? 1;
  const load = successful.cpu_load_1m ?? 0;
  const cpuUsedPct = Math.min(100, (load / cores) * 100);
  const memFreePct =
    successful.mem_total_mb && successful.mem_used_mb != null
      ? Math.max(0, 100 - (successful.mem_used_mb / successful.mem_total_mb) * 100)
      : 0;
  let gpuFreePct: number | null = null;
  const gi = successful.gpu_info as
    | Array<{ util_pct?: number; memory_total_mb?: number; memory_used_mb?: number }>
    | null
    | undefined;
  if (gi && gi.length > 0) {
    // Use average utilisation across reported GPUs.
    let utilSum = 0;
    let n = 0;
    for (const g of gi) {
      if (typeof g.util_pct === "number" && Number.isFinite(g.util_pct)) {
        utilSum += g.util_pct;
        n += 1;
      }
    }
    gpuFreePct = n > 0 ? Math.max(0, 100 - utilSum / n) : null;
  }
  return {
    cpu_free_pct: Math.max(0, 100 - cpuUsedPct),
    mem_free_pct: memFreePct,
    gpu_free_pct: gpuFreePct,
    last_probed_at: successful.probed_at,
  };
}

// Returns a sorted (descending score) list of candidates. Hosts that fail any
// hard requirement receive score 0 and appear at the end with reasons.
export function rankHosts(req: InstanceRequirements, d?: Db): HostScore[] {
  const db = d ?? getDb();
  const hosts = listHosts(db);
  const scored = hosts.map((h) => scoreHost(h, req, db));
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function scoreHost(host: HostRecord, req: InstanceRequirements, db: Db): HostScore {
  const reasons: string[] = [];

  // Hard filters
  if (host.status === "quarantined") {
    return { host, score: 0, reasons: ["host is quarantined"] };
  }
  if (host.status === "offline" || host.status === "error") {
    return { host, score: 0, reasons: [`host status '${host.status}'`] };
  }

  const caps = host.capabilities;

  if (req.gpu === true) {
    const hasGpu = !!caps.gpu && caps.gpu !== "none";
    if (!hasGpu) return { host, score: 0, reasons: ["GPU required, host has none"] };
    reasons.push(`GPU: ${caps.gpu}`);
  }
  if (typeof req.min_cores === "number" && req.min_cores > 0) {
    if ((caps.cores ?? 0) < req.min_cores) {
      return {
        host,
        score: 0,
        reasons: [`requires ${req.min_cores} cores, host has ${caps.cores ?? "?"}`],
      };
    }
    reasons.push(`cores: ${caps.cores}`);
  }
  if (typeof req.min_ram_mb === "number" && req.min_ram_mb > 0) {
    if ((caps.ram_mb ?? 0) < req.min_ram_mb) {
      return {
        host,
        score: 0,
        reasons: [`requires ${req.min_ram_mb} MB RAM, host has ${caps.ram_mb ?? "?"}`],
      };
    }
    reasons.push(`RAM: ${caps.ram_mb} MB`);
  }
  if (req.tags && req.tags.length > 0) {
    const hostTags = new Set(caps.tags ?? []);
    const missing = req.tags.filter((t) => !hostTags.has(t));
    if (missing.length > 0) {
      return { host, score: 0, reasons: [`missing tags: ${missing.join(", ")}`] };
    }
    reasons.push(`tags: ${req.tags.join(", ")}`);
  }

  // Soft scoring
  const cap = hostCapacity(host, db);
  if (cap.last_probed_at === null) {
    reasons.push("no recent successful probe — low confidence");
  }
  // Weighted: CPU 0.5, mem 0.3, gpu 0.2 (if applicable)
  const cpuPart = cap.cpu_free_pct * 0.5;
  const memPart = cap.mem_free_pct * 0.3;
  let gpuPart = 0;
  let weightSum = 0.5 + 0.3;
  if (req.gpu === true && cap.gpu_free_pct !== null) {
    gpuPart = cap.gpu_free_pct * 0.2;
    weightSum += 0.2;
  }
  // Bonus for online + fresh probe.
  const freshness = cap.last_probed_at && Date.now() - cap.last_probed_at < 60_000 ? 5 : 0;
  const online = host.status === "online" ? 5 : 0;

  const score = Math.round(((cpuPart + memPart + gpuPart) / weightSum) * 10 + freshness + online);
  reasons.push(
    `cpu_free=${cap.cpu_free_pct.toFixed(0)}% mem_free=${cap.mem_free_pct.toFixed(0)}%` +
      (cap.gpu_free_pct !== null ? ` gpu_free=${cap.gpu_free_pct.toFixed(0)}%` : "")
  );
  return { host, score, reasons };
}

export function pickBestHost(req: InstanceRequirements, d?: Db): HostScore | null {
  const ranked = rankHosts(req, d);
  const top = ranked[0];
  if (!top || top.score === 0) return null;
  return top;
}
