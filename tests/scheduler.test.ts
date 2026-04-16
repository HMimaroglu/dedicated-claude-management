import { afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { createDb, type Db } from "../src/lib/db";
import { _setKeyForTests } from "../src/lib/crypto";
import { createHost, recordProbe } from "../src/lib/hosts";
import { pickBestHost, rankHosts, hostCapacity } from "../src/lib/scheduler";

let db: Db;
const { privateKey } = crypto.generateKeyPairSync("ed25519");
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function mkHost(
  name: string,
  caps: { gpu?: string | null; cores?: number; ram_mb?: number; tags?: string[] } = {}
) {
  return createHost(
    {
      name,
      address: `10.0.0.${Math.floor(Math.random() * 254) + 1}`,
      ssh_user: "u",
      auth_method: "privkey",
      privkey: PEM,
      capabilities: caps,
    },
    db
  );
}

beforeEach(() => {
  _setKeyForTests(crypto.randomBytes(32));
  db = createDb(":memory:");
});
afterEach(() => {
  _setKeyForTests(null);
  db.close();
});

describe("scheduler filters", () => {
  it("rejects host missing GPU when gpu required", () => {
    mkHost("nogpu", { cores: 8, ram_mb: 16000 });
    const ranked = rankHosts({ gpu: true }, db);
    expect(ranked[0]!.score).toBe(0);
    expect(ranked[0]!.reasons.join(" ")).toMatch(/GPU/);
  });

  it("rejects host with insufficient cores", () => {
    mkHost("small", { cores: 4, ram_mb: 16000 });
    const ranked = rankHosts({ min_cores: 8 }, db);
    expect(ranked[0]!.score).toBe(0);
    expect(ranked[0]!.reasons.join(" ")).toMatch(/cores/);
  });

  it("rejects host missing required tag", () => {
    mkHost("notag", { cores: 16, ram_mb: 32000, tags: ["linux"] });
    const ranked = rankHosts({ tags: ["macos"] }, db);
    expect(ranked[0]!.score).toBe(0);
  });
});

describe("scheduler ranking", () => {
  it("prefers host with more free capacity (fresh probe)", () => {
    const h1 = mkHost("busy", { cores: 16, ram_mb: 32000 });
    const h2 = mkHost("idle", { cores: 16, ram_mb: 32000 });

    recordProbe(
      h1.id,
      {
        success: true,
        latency_ms: 10,
        error: null,
        cpu_load_1m: 14,
        mem_total_mb: 32000,
        mem_used_mb: 28000,
        disk_used_pct: 50,
        gpu_info: null,
      },
      db
    );
    recordProbe(
      h2.id,
      {
        success: true,
        latency_ms: 10,
        error: null,
        cpu_load_1m: 1,
        mem_total_mb: 32000,
        mem_used_mb: 4000,
        disk_used_pct: 50,
        gpu_info: null,
      },
      db
    );

    const ranked = rankHosts({ min_cores: 8 }, db);
    expect(ranked[0]!.host.name).toBe("idle");
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it("pickBestHost returns null when nothing qualifies", () => {
    mkHost("nogpu", { cores: 8, ram_mb: 16000 });
    expect(pickBestHost({ gpu: true }, db)).toBeNull();
  });

  it("hostCapacity handles no-probe-yet gracefully", () => {
    const h = mkHost("fresh", { cores: 8, ram_mb: 16000 });
    const cap = hostCapacity(h, db);
    expect(cap.cpu_free_pct).toBe(0);
    expect(cap.mem_free_pct).toBe(0);
    expect(cap.gpu_free_pct).toBeNull();
  });
});
