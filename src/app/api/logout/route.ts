import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  clearSessionCookie,
  destroySession,
  getSessionUserByToken,
  SESSION_COOKIE_NAME,
} from "@/lib/session";
import { audit } from "@/lib/audit";
import { isSameOrigin } from "@/lib/csrf";
import { getRequestIp } from "@/lib/request-ip";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const c = await cookies();
  const token = c.get(SESSION_COOKIE_NAME)?.value;
  if (token) {
    const user = getSessionUserByToken(token);
    destroySession(token);
    if (user) {
      audit({ event: "user.logout", actorUserId: user.id, ip: getRequestIp(req) });
      audit({ event: "session.destroyed", actorUserId: user.id, ip: getRequestIp(req) });
    }
  }
  await clearSessionCookie();
  return NextResponse.json({ ok: true });
}
