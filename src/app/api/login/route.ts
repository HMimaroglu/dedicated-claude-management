import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { getDummyHash, verifyPassword } from "@/lib/auth";
import { createSession, setSessionCookie } from "@/lib/session";
import { audit } from "@/lib/audit";
import { isSameOrigin } from "@/lib/csrf";
import { getRequestIp } from "@/lib/request-ip";
import { checkLoginRateLimit, recordLoginAttempt } from "@/lib/rate-limit";

export const runtime = "nodejs";

const BodySchema = z.object({
  username: z.string(),
  password: z.string(),
});

export async function POST(req: Request) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const ip = getRequestIp(req);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    recordLoginAttempt({ ip, succeeded: false });
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    recordLoginAttempt({ ip, succeeded: false });
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  const rl = checkLoginRateLimit({ ip, username: parsed.data.username });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many failed attempts. Try again later." },
      {
        status: 429,
        headers: { "Retry-After": Math.ceil(rl.retryAfterMs / 1000).toString() },
      }
    );
  }

  const db = getDb();
  const row = db
    .prepare("SELECT id, password_hash FROM users WHERE username = ?")
    .get(parsed.data.username) as { id: number; password_hash: string } | undefined;

  // Always compute argon2 to mitigate user-enumeration timing leak
  let ok: boolean;
  if (row) {
    ok = await verifyPassword(row.password_hash, parsed.data.password);
  } else {
    await verifyPassword(await getDummyHash(), parsed.data.password);
    ok = false;
  }

  if (!ok || !row) {
    recordLoginAttempt({ ip, username: parsed.data.username, succeeded: false });
    audit({ event: "user.login_failed", ip, details: { username: parsed.data.username } });
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  recordLoginAttempt({ ip, username: parsed.data.username, succeeded: true });
  audit({ event: "user.login", actorUserId: row.id, ip });
  const { token, expiresAt } = createSession({
    userId: row.id,
    ip,
    userAgent: req.headers.get("user-agent"),
  });
  audit({ event: "session.created", actorUserId: row.id, ip });
  await setSessionCookie(token, expiresAt);
  return NextResponse.json({ ok: true });
}
