import { afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { createDb, type Db } from "../src/lib/db";
import { _setKeyForTests } from "../src/lib/crypto";
import { createHost } from "../src/lib/hosts";
import { createProject } from "../src/lib/projects";
import { createInstanceRow } from "../src/lib/instances";
import {
  issueTerminalTicket,
  purgeExpiredTickets,
  redeemTerminalTicket,
} from "../src/lib/terminal-tickets";

let db: Db;
const { privateKey } = crypto.generateKeyPairSync("ed25519");
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function seedUser(): number {
  const r = db
    .prepare(
      "INSERT INTO users (username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)"
    )
    .run("alice", "h", Date.now(), Date.now());
  return Number(r.lastInsertRowid);
}
function seedInstance(): number {
  const host = createHost(
    { name: "h1", address: "a", ssh_user: "u", auth_method: "privkey", privkey: PEM },
    db
  );
  const project = createProject(
    { name: "p1", source_type: "local", host_id: host.id, path_on_host: "/home/u/p" },
    db
  );
  return createInstanceRow({ name: "i", project_id: project.id }, db).id;
}

beforeEach(() => {
  _setKeyForTests(crypto.randomBytes(32));
  db = createDb(":memory:");
});
afterEach(() => {
  _setKeyForTests(null);
  db.close();
});

describe("terminal tickets", () => {
  it("issue then redeem returns payload", () => {
    const userId = seedUser();
    const instanceId = seedInstance();
    const { token } = issueTerminalTicket({ userId, instanceId, db });
    const redeemed = redeemTerminalTicket(token, db);
    expect(redeemed).toEqual({ userId, instanceId });
  });

  it("redeem returns null for unknown token", () => {
    expect(redeemTerminalTicket("nope", db)).toBeNull();
  });

  it("redeem is one-shot", () => {
    seedUser();
    const instanceId = seedInstance();
    const { token } = issueTerminalTicket({ userId: 1, instanceId, db });
    expect(redeemTerminalTicket(token, db)).not.toBeNull();
    expect(redeemTerminalTicket(token, db)).toBeNull();
  });

  it("redeem returns null for expired ticket", () => {
    seedUser();
    const instanceId = seedInstance();
    const { token } = issueTerminalTicket({ userId: 1, instanceId, db });
    db.prepare("UPDATE terminal_tickets SET expires_at = 1").run();
    expect(redeemTerminalTicket(token, db)).toBeNull();
  });

  it("purges expired", () => {
    seedUser();
    const instanceId = seedInstance();
    issueTerminalTicket({ userId: 1, instanceId, db });
    db.prepare("UPDATE terminal_tickets SET expires_at = 1").run();
    expect(purgeExpiredTickets(db)).toBeGreaterThan(0);
  });

  it("ticket cascades when instance is deleted", () => {
    seedUser();
    const instanceId = seedInstance();
    issueTerminalTicket({ userId: 1, instanceId, db });
    db.prepare("DELETE FROM instances WHERE id = ?").run(instanceId);
    const count = db.prepare("SELECT COUNT(*) as c FROM terminal_tickets").get() as { c: number };
    expect(count.c).toBe(0);
  });
});
