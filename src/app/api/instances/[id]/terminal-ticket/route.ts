import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { getInstance } from "@/lib/instances";
import { issueTerminalTicket, TERMINAL_TICKET_TTL_MS } from "@/lib/terminal-tickets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseId(s: string): number | null {
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const instanceId = parseId(id);
  if (instanceId === null) return NextResponse.json({ error: "Bad id" }, { status: 400 });
  const inst = getInstance(instanceId);
  if (!inst) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const ticket = issueTerminalTicket({ instanceId, userId: auth.user.id });
  return NextResponse.json({
    token: ticket.token,
    expires_at: ticket.expiresAt,
    ttl_ms: TERMINAL_TICKET_TTL_MS,
  });
}
