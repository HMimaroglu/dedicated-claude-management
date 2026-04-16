import { describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/lib/db";
import {
  createSession,
  destroyAllSessionsForUser,
  destroySession,
  getSessionUserByToken,
  purgeExpiredSessions,
} from "../src/lib/session";

function withUser(): { db: Db; userId: number } {
  const db = createDb(":memory:");
  const r = db
    .prepare(
      "INSERT INTO users (username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)"
    )
    .run("alice", "h", Date.now(), Date.now());
  return { db, userId: Number(r.lastInsertRowid) };
}

describe("sessions", () => {
  it("createSession returns token + future expiry", () => {
    const { db, userId } = withUser();
    const { token, expiresAt } = createSession({ userId, db });
    expect(token).toBeTypeOf("string");
    expect(expiresAt).toBeGreaterThan(Date.now());
    db.close();
  });

  it("getSessionUserByToken returns user for valid token", () => {
    const { db, userId } = withUser();
    const { token } = createSession({ userId, db });
    const user = getSessionUserByToken(token, db);
    expect(user).not.toBeNull();
    expect(user!.id).toBe(userId);
    expect(user!.username).toBe("alice");
    db.close();
  });

  it("returns null for unknown token", () => {
    const { db } = withUser();
    expect(getSessionUserByToken("not-a-token", db)).toBeNull();
    db.close();
  });

  it("returns null for expired session", () => {
    const { db, userId } = withUser();
    const { token } = createSession({ userId, db });
    db.prepare("UPDATE sessions SET expires_at = 1 WHERE user_id = ?").run(userId);
    expect(getSessionUserByToken(token, db)).toBeNull();
    db.close();
  });

  it("destroySession removes the row", () => {
    const { db, userId } = withUser();
    const { token } = createSession({ userId, db });
    destroySession(token, db);
    expect(getSessionUserByToken(token, db)).toBeNull();
    db.close();
  });

  it("purgeExpiredSessions clears expired rows", () => {
    const { db, userId } = withUser();
    createSession({ userId, db });
    db.prepare("UPDATE sessions SET expires_at = 1").run();
    expect(purgeExpiredSessions(db)).toBeGreaterThan(0);
    db.close();
  });

  it("destroyAllSessionsForUser invalidates every session for that user", () => {
    const { db, userId } = withUser();
    const { token: t1 } = createSession({ userId, db });
    const { token: t2 } = createSession({ userId, db });
    expect(destroyAllSessionsForUser(userId, db)).toBe(2);
    expect(getSessionUserByToken(t1, db)).toBeNull();
    expect(getSessionUserByToken(t2, db)).toBeNull();
    db.close();
  });

  it("session is bound to current user (cross-user isolation)", () => {
    const { db, userId } = withUser();
    const r2 = db
      .prepare(
        "INSERT INTO users (username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)"
      )
      .run("bob", "h", Date.now(), Date.now());
    const userId2 = Number(r2.lastInsertRowid);
    const { token: aliceToken } = createSession({ userId, db });
    const { token: bobToken } = createSession({ userId: userId2, db });
    expect(getSessionUserByToken(aliceToken, db)!.username).toBe("alice");
    expect(getSessionUserByToken(bobToken, db)!.username).toBe("bob");
    db.close();
  });
});
