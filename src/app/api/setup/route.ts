import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb, hasAnyUser } from "@/lib/db";
import { hashPassword, validatePassword, validateUsername } from "@/lib/auth";
import { createSession, setSessionCookie } from "@/lib/session";
import { audit } from "@/lib/audit";
import { isSameOrigin } from "@/lib/csrf";
import { getRequestIp } from "@/lib/request-ip";

export const runtime = "nodejs";

const BodySchema = z.object({
  username: z.string(),
  password: z.string(),
});

export async function POST(req: Request) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  if (hasAnyUser()) {
    return NextResponse.json({ error: "Setup already complete" }, { status: 409 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const u = validateUsername(parsed.data.username);
  if (!u.ok) return NextResponse.json({ error: u.reason }, { status: 400 });
  const p = validatePassword(parsed.data.password);
  if (!p.ok) return NextResponse.json({ error: p.reason }, { status: 400 });

  const db = getDb();
  const now = Date.now();
  const passwordHash = await hashPassword(parsed.data.password);

  let userId: number | null = null;
  try {
    // better-sqlite3 transactions are synchronous and serialized per connection,
    // so the inner hasAnyUser check sees any prior INSERT. The UNIQUE constraint
    // on users.username is the second line of defense.
    db.transaction(() => {
      if (hasAnyUser(db)) throw new Error("ALREADY_SETUP");
      const r = db
        .prepare(
          `INSERT INTO users (username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)`
        )
        .run(parsed.data.username, passwordHash, now, now);
      userId = Number(r.lastInsertRowid);
    })();
  } catch (e) {
    if ((e as Error).message === "ALREADY_SETUP") {
      return NextResponse.json({ error: "Setup already complete" }, { status: 409 });
    }
    throw e;
  }

  const ip = getRequestIp(req);
  audit({ event: "user.created", actorUserId: userId, ip });
  const { token, expiresAt } = createSession({
    userId: userId!,
    ip,
    userAgent: req.headers.get("user-agent"),
  });
  audit({ event: "session.created", actorUserId: userId, ip });
  await setSessionCookie(token, expiresAt);
  return NextResponse.json({ ok: true });
}
