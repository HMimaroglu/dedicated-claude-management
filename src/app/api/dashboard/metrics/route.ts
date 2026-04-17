import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { computeLocalMetric } from "@/lib/dashboard-metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const local = await computeLocalMetric();
  return NextResponse.json(local);
}
