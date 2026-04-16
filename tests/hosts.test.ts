import { afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { createDb, type Db } from "../src/lib/db";
import { _setKeyForTests } from "../src/lib/crypto";
import {
  createHost,
  deleteHost,
  getHost,
  getHostSecrets,
  listHosts,
  QUARANTINE_THRESHOLD,
  recentProbes,
  recordProbe,
  unquarantineHost,
  updateHost,
  validateHostName,
  validateAddress,
  validatePort,
  validateSshUser,
  type ProbeResult,
} from "../src/lib/hosts";

let db: Db;
// Real PKCS8 Ed25519 PEM — needed now that validatePrivkey parses structurally.
const { privateKey } = crypto.generateKeyPairSync("ed25519");
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

beforeEach(() => {
  _setKeyForTests(crypto.randomBytes(32));
  db = createDb(":memory:");
});
afterEach(() => {
  _setKeyForTests(null);
  db.close();
});

describe("host validators", () => {
  it("validateHostName", () => {
    expect(validateHostName("ok")).toBeNull();
    expect(validateHostName("my-host.1")).toBeNull();
    expect(validateHostName("-evil")).not.toBeNull();
    expect(validateHostName("bad space")).not.toBeNull();
    expect(validateHostName("a".repeat(65))).not.toBeNull();
  });
  it("validateAddress", () => {
    expect(validateAddress("10.0.0.1")).toBeNull();
    expect(validateAddress("host.example.com")).toBeNull();
    expect(validateAddress("::1")).toBeNull();
    expect(validateAddress("http://host")).not.toBeNull();
    expect(validateAddress("bad space")).not.toBeNull();
  });
  it("validatePort", () => {
    expect(validatePort(22)).toBeNull();
    expect(validatePort(65535)).toBeNull();
    expect(validatePort(0)).not.toBeNull();
    expect(validatePort(70000)).not.toBeNull();
  });
  it("validateSshUser", () => {
    expect(validateSshUser("ubuntu")).toBeNull();
    expect(validateSshUser("-root")).not.toBeNull();
    expect(validateSshUser("a b")).not.toBeNull();
  });
});

describe("host CRUD", () => {
  it("creates + lists + gets", () => {
    const h = createHost(
      { name: "n1", address: "10.0.0.1", ssh_user: "ubuntu", auth_method: "privkey", privkey: PEM },
      db
    );
    expect(h.id).toBeGreaterThan(0);
    expect(h.status).toBe("unknown");
    const list = listHosts(db);
    expect(list).toHaveLength(1);
    expect(getHost(h.id, db)!.name).toBe("n1");
  });

  it("rejects duplicate name", () => {
    createHost(
      { name: "dup", address: "a", ssh_user: "u", auth_method: "privkey", privkey: PEM },
      db
    );
    expect(() =>
      createHost(
        { name: "dup", address: "b", ssh_user: "u", auth_method: "privkey", privkey: PEM },
        db
      )
    ).toThrow();
  });

  it("encrypts privkey at rest", () => {
    const h = createHost(
      { name: "enc", address: "a", ssh_user: "u", auth_method: "privkey", privkey: PEM, passphrase: "pp" },
      db
    );
    const raw = db.prepare("SELECT enc_privkey, enc_passphrase FROM hosts WHERE id = ?").get(h.id) as {
      enc_privkey: string;
      enc_passphrase: string;
    };
    expect(raw.enc_privkey).not.toContain("BEGIN");
    expect(raw.enc_privkey).not.toContain(PEM);
    expect(raw.enc_passphrase).not.toBe("pp");
    const secrets = getHostSecrets(h.id, db);
    expect(secrets!.privkey).toBe(PEM);
    expect(secrets!.passphrase).toBe("pp");
  });

  it("requires privkey for privkey auth_method", () => {
    expect(() =>
      createHost(
        { name: "x", address: "a", ssh_user: "u", auth_method: "privkey" },
        db
      )
    ).toThrow();
  });

  it("rejects obviously non-PEM privkey", () => {
    expect(() =>
      createHost(
        { name: "x", address: "a", ssh_user: "u", auth_method: "privkey", privkey: "nope" },
        db
      )
    ).toThrow();
  });

  it("rejects garbage wrapped in BEGIN/END headers (structural parse)", () => {
    const fakePem =
      "-----BEGIN OPENSSH PRIVATE KEY-----\n" + "a".repeat(200) + "\n-----END OPENSSH PRIVATE KEY-----";
    expect(() =>
      createHost(
        { name: "x", address: "a", ssh_user: "u", auth_method: "privkey", privkey: fakePem },
        db
      )
    ).toThrow(/valid PEM/);
  });

  it("rejects cloud metadata addresses", () => {
    expect(() =>
      createHost(
        {
          name: "bad",
          address: "169.254.169.254",
          ssh_user: "u",
          auth_method: "privkey",
          privkey: PEM,
        },
        db
      )
    ).toThrow(/blocked/);
  });

  it("updates fields and replaces secret when provided", () => {
    const { privateKey: pk2 } = crypto.generateKeyPairSync("ed25519");
    const PEM2 = pk2.export({ type: "pkcs8", format: "pem" }).toString();
    const h = createHost(
      { name: "n", address: "a", ssh_user: "u", auth_method: "privkey", privkey: PEM },
      db
    );
    const u = updateHost(h.id, { address: "new-addr", privkey: PEM2 }, db)!;
    expect(u.address).toBe("new-addr");
    expect(getHostSecrets(h.id, db)!.privkey).toBe(PEM2);
  });

  it("wipes stored privkey when auth_method switched to agent", () => {
    const h = createHost(
      { name: "n", address: "a", ssh_user: "u", auth_method: "privkey", privkey: PEM, passphrase: "pp" },
      db
    );
    expect(getHostSecrets(h.id, db)!.privkey).toBe(PEM);
    updateHost(h.id, { auth_method: "agent" }, db);
    const after = getHostSecrets(h.id, db)!;
    expect(after.privkey).toBeNull();
    expect(after.passphrase).toBeNull();
  });

  it("delete removes host + probes cascade", () => {
    const h = createHost(
      { name: "n", address: "a", ssh_user: "u", auth_method: "privkey", privkey: PEM },
      db
    );
    recordProbe(h.id, fakeProbe(true), db);
    expect(recentProbes(h.id, 10, db)).toHaveLength(1);
    expect(deleteHost(h.id, db)).toBe(true);
    expect(getHost(h.id, db)).toBeNull();
    const count = db.prepare("SELECT COUNT(*) as c FROM host_probes").get() as { c: number };
    expect(count.c).toBe(0);
  });
});

function fakeProbe(success: boolean, over?: Partial<ProbeResult>): ProbeResult {
  return {
    success,
    latency_ms: 42,
    error: success ? null : "simulated failure",
    cpu_load_1m: success ? 0.5 : null,
    mem_total_mb: success ? 16000 : null,
    mem_used_mb: success ? 8000 : null,
    disk_used_pct: success ? 50 : null,
    gpu_info: null,
    ...over,
  };
}

describe("probe recording + quarantine", () => {
  it("success → online, resets consecutive_failures", () => {
    const h = createHost(
      { name: "n", address: "a", ssh_user: "u", auth_method: "privkey", privkey: PEM },
      db
    );
    recordProbe(h.id, fakeProbe(false), db);
    recordProbe(h.id, fakeProbe(true), db);
    const after = getHost(h.id, db)!;
    expect(after.status).toBe("online");
    expect(after.consecutive_failures).toBe(0);
  });

  it("quarantines after N consecutive failures", () => {
    const h = createHost(
      { name: "n", address: "a", ssh_user: "u", auth_method: "privkey", privkey: PEM },
      db
    );
    for (let i = 0; i < QUARANTINE_THRESHOLD - 1; i++) {
      recordProbe(h.id, fakeProbe(false), db);
    }
    expect(getHost(h.id, db)!.status).toBe("offline");
    recordProbe(h.id, fakeProbe(false), db);
    expect(getHost(h.id, db)!.status).toBe("quarantined");
    expect(getHost(h.id, db)!.consecutive_failures).toBe(QUARANTINE_THRESHOLD);
  });

  it("unquarantine clears status and counter", () => {
    const h = createHost(
      { name: "n", address: "a", ssh_user: "u", auth_method: "privkey", privkey: PEM },
      db
    );
    for (let i = 0; i < QUARANTINE_THRESHOLD; i++) {
      recordProbe(h.id, fakeProbe(false), db);
    }
    expect(getHost(h.id, db)!.status).toBe("quarantined");
    unquarantineHost(h.id, db);
    const after = getHost(h.id, db)!;
    expect(after.status).toBe("unknown");
    expect(after.consecutive_failures).toBe(0);
  });
});
