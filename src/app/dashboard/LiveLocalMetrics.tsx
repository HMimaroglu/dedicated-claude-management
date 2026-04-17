"use client";
import { useEffect, useState } from "react";
import type { LocalMetric } from "@/lib/dashboard-metrics";

export default function LiveLocalMetrics({ initial }: { initial: LocalMetric }) {
  const [m, setM] = useState(initial);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      try {
        const r = await fetch("/api/dashboard/metrics");
        if (r.ok && active) {
          const data = (await r.json()) as LocalMetric;
          setM(data);
        }
      } catch {
        // ignore
      }
    };
    const t = setInterval(poll, 1000);
    return () => { active = false; clearInterval(t); };
  }, []);

  const memPct = m.mem_total_mb > 0 ? (m.mem_used_mb / m.mem_total_mb) * 100 : 0;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-md p-4">
      <div className="flex justify-between items-start mb-3">
        <div>
          <div className="text-xl font-semibold font-mono">{m.hostname}</div>
          <div className="text-xs text-zinc-500 mt-0.5">{m.platform} · {m.cores} cores</div>
        </div>
        <span className="px-2 py-0.5 rounded text-xs bg-emerald-900 text-emerald-300">online</span>
      </div>
      <div className="grid grid-cols-3 gap-3 text-sm">
        <Stat
          label="CPU"
          value={`${m.cpu_pct.toFixed(1)}%`}
          bar={m.cpu_pct}
          sub={`load ${m.load_1m.toFixed(2)}`}
          tone={m.cpu_pct > 80 ? "warn" : "ok"}
        />
        <Stat
          label="Memory"
          value={`${memPct.toFixed(1)}%`}
          bar={memPct}
          sub={`${(m.mem_used_mb / 1024).toFixed(1)} / ${(m.mem_total_mb / 1024).toFixed(1)} GB (${m.mem_used_mb} MB)`}
          tone={memPct > 85 ? "warn" : "ok"}
        />
        <Stat label="Uptime" value={formatUptime(m.uptime_sec)} />
      </div>
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
            className={`h-full transition-all duration-500 ${tone === "warn" ? "bg-red-500" : "bg-emerald-500"}`}
            style={{ width: `${Math.min(100, Math.max(0, bar))}%` }}
          />
        </div>
      )}
    </div>
  );
}

function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
