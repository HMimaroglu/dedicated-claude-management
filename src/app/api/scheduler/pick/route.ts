import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/api-auth";
import { rankHosts } from "@/lib/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  gpu: z.boolean().optional(),
  min_cores: z.number().int().optional(),
  min_ram_mb: z.number().int().optional(),
  tags: z.array(z.string()).optional(),
});

export async function POST(req: Request) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  const ranked = rankHosts(parsed.data).map((r) => ({
    host_id: r.host.id,
    host_name: r.host.name,
    score: r.score,
    reasons: r.reasons,
  }));
  return NextResponse.json({ ranked });
}
