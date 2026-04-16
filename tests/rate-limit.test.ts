import { describe, expect, it } from "vitest";
import { createDb } from "../src/lib/db";
import {
  checkLoginRateLimit,
  LOGIN_MAX_FAILED_PER_IP,
  LOGIN_MAX_FAILED_PER_USERNAME,
  recordLoginAttempt,
} from "../src/lib/rate-limit";

describe("login rate limit", () => {
  it("allows initial attempts", () => {
    const db = createDb(":memory:");
    const r = checkLoginRateLimit({ ip: "1.2.3.4", db });
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(LOGIN_MAX_FAILED_PER_IP);
    db.close();
  });

  it("blocks after exceeding per-IP threshold", () => {
    const db = createDb(":memory:");
    for (let i = 0; i < LOGIN_MAX_FAILED_PER_IP; i++) {
      recordLoginAttempt({ ip: "1.2.3.4", succeeded: false, db });
    }
    const r = checkLoginRateLimit({ ip: "1.2.3.4", db });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("ip");
    expect(r.retryAfterMs).toBeGreaterThan(0);
    db.close();
  });

  it("blocks after exceeding per-username threshold even from many IPs", () => {
    const db = createDb(":memory:");
    for (let i = 0; i < LOGIN_MAX_FAILED_PER_USERNAME; i++) {
      // Each attempt from a different IP — defeats per-IP only throttling
      recordLoginAttempt({ ip: `10.0.0.${i}`, username: "alice", succeeded: false, db });
    }
    const r = checkLoginRateLimit({ ip: "10.0.0.99", username: "alice", db });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("username");
    db.close();
  });

  it("does not count successful attempts", () => {
    const db = createDb(":memory:");
    for (let i = 0; i < LOGIN_MAX_FAILED_PER_IP + 5; i++) {
      recordLoginAttempt({ ip: "1.2.3.4", succeeded: true, db });
    }
    expect(checkLoginRateLimit({ ip: "1.2.3.4", db }).allowed).toBe(true);
    db.close();
  });

  it("rate limit is per-IP", () => {
    const db = createDb(":memory:");
    for (let i = 0; i < LOGIN_MAX_FAILED_PER_IP; i++) {
      recordLoginAttempt({ ip: "1.1.1.1", succeeded: false, db });
    }
    expect(checkLoginRateLimit({ ip: "1.1.1.1", db }).allowed).toBe(false);
    expect(checkLoginRateLimit({ ip: "2.2.2.2", db }).allowed).toBe(true);
    db.close();
  });

  it("does not check username throttle when username is omitted", () => {
    const db = createDb(":memory:");
    for (let i = 0; i < LOGIN_MAX_FAILED_PER_USERNAME; i++) {
      recordLoginAttempt({ ip: `10.0.0.${i}`, username: "alice", succeeded: false, db });
    }
    // Querying without username only checks per-IP bucket; new IP is allowed
    expect(checkLoginRateLimit({ ip: "10.0.0.99", db }).allowed).toBe(true);
    db.close();
  });
});
