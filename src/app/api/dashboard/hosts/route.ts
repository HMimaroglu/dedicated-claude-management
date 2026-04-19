import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { listHosts, recentProbes } from "@/lib/hosts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const hosts = listHosts();
  const result = hosts.map((h) => {
    const series = recentProbes(h.id, 30);
    const latest = series.find((p) => p.success) ?? series[0] ?? null;
    return {
      id: h.id,
      name: h.name,
      status: h.status,
      capabilities: h.capabilities,
      latest,
      series: series
        .filter((p) => p.success && p.cpu_load_1m !== null)
        .map((p) => p.cpu_load_1m as number)
        .reverse(),
    };
  });

  return NextResponse.json(result);
}
