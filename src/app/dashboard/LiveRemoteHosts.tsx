"use client";
import Link from "next/link";
import { useEffect, useState } from "react";

interface HostLatest {
  cpu_load_1m?: number | null;
  mem_used_mb?: number | null;
  mem_total_mb?: number | null;
}

interface RemoteHost {
  id: number;
  name: string;
  status: string;
  capabilities: { cores?: number };
  latest: HostLatest | null;
  series: number[];
}

export default function LiveRemoteHosts({ initial }: { initial: RemoteHost[] }) {
  const [hosts, setHosts] = useState(initial);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      try {
        const r = await fetch("/api/dashboard/hosts");
        if (r.ok && active) {
          setHosts(await r.json());
        }
      } catch {
        // ignore
      }
    };
    const t = setInterval(poll, 3000);
    return () => { active = false; clearInterval(t); };
  }, []);

  if (hosts.length === 0) {
    return (
      <p className="text-sm text-zinc-500">
        No remote hosts registered.{" "}
        <Link href="/hosts" className="underline">Add one →</Link>{" "}
        when you want more compute.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {hosts.map((m) => {
        const cores = m.capabilities.cores ?? 1;
        const maxY = Math.max(cores, ...m.series, 1);
        return (
          <div key={m.id} className="flex items-center gap-3 bg-zinc-900 border border-zinc-800 rounded-md p-3">
            <div className="w-40 text-sm min-w-0">
              <Link href={`/hosts/${m.id}`} className="font-mono truncate block hover:text-zinc-100">
                {m.name}
              </Link>
              <span className={`text-xs ${m.status === "online" ? "text-emerald-400" : "text-zinc-500"}`}>
                {m.status}
              </span>
            </div>
            <div className="flex-1">
              <Sparkline values={m.series} maxY={maxY} />
            </div>
            <div className="w-32 text-right text-xs font-mono text-zinc-400">
              {m.latest ? (
                <>
                  <div>load {m.latest.cpu_load_1m?.toFixed(2) ?? "—"}</div>
                  <div>
                    mem {m.latest.mem_used_mb ?? "?"}/{m.latest.mem_total_mb ?? "?"} MB
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
  );
}

function Sparkline({
  values,
  maxY,
  width = 300,
  height = 32,
}: {
  values: number[];
  maxY: number;
  width?: number;
  height?: number;
}) {
  if (values.length < 2) {
    return <div className="text-xs text-zinc-600">not enough data</div>;
  }
  const max = maxY > 0 ? maxY : 1;
  const stepX = width / (values.length - 1);
  const points = values.map((v, i) => {
    const x = i * stepX;
    const y = height - Math.max(0, Math.min(1, v / max)) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const path = `M${points.join(" L")}`;

  return (
    <svg width={width} height={height} className="block" viewBox={`0 0 ${width} ${height}`}>
      <path d={path} fill="none" stroke="currentColor" strokeWidth={1.25} className="text-emerald-400" />
    </svg>
  );
}
