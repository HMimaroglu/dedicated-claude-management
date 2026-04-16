import { afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { createDb, type Db } from "../src/lib/db";
import { _setKeyForTests } from "../src/lib/crypto";
import { createHost, recordProbe } from "../src/lib/hosts";
import { createProject } from "../src/lib/projects";
import { createInstanceRow, setInstanceStatus } from "../src/lib/instances";
import { computeDashboard } from "../src/lib/dashboard-metrics";

let db: Db;
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

describe("computeDashboard", () => {
  it("returns zero-remote + controller baseline when nothing exists", () => {
    const { totals, hosts, local } = computeDashboard(db);
    expect(hosts).toHaveLength(0);
    expect(totals.hosts).toBe(0);
    expect(totals.instances).toBe(0);
    // Controller always contributes its own cores + RAM to the totals.
    expect(local.cores).toBeGreaterThan(0);
    expect(totals.cores_total).toBe(local.cores);
    expect(totals.ram_total_mb).toBe(local.mem_total_mb);
  });

  it("aggregates cores, RAM, and instance counts", () => {
    const h1 = createHost(
      {
        name: "h1",
        address: "10.0.0.1",
        ssh_user: "u",
        auth_method: "privkey",
        privkey: PEM,
        capabilities: { cores: 8, ram_mb: 16000, gpu: "A100", gpu_count: 1 },
      },
      db
    );
    const h2 = createHost(
      {
        name: "h2",
        address: "10.0.0.2",
        ssh_user: "u",
        auth_method: "privkey",
        privkey: PEM,
        capabilities: { cores: 16, ram_mb: 32000 },
      },
      db
    );
    recordProbe(
      h1.id,
      {
        success: true,
        latency_ms: 10,
        error: null,
        cpu_load_1m: 1,
        mem_total_mb: 16000,
        mem_used_mb: 8000,
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
        cpu_load_1m: 2,
        mem_total_mb: 32000,
        mem_used_mb: 16000,
        disk_used_pct: 50,
        gpu_info: null,
      },
      db
    );
    const p = createProject(
      { name: "p", source_type: "local", host_id: h1.id, path_on_host: "/home/u/p" },
      db
    );
    const inst = createInstanceRow({ name: "i", project_id: p.id }, db);
    setInstanceStatus(inst.id, "running", {}, db);
    const { totals, hosts, local } = computeDashboard(db);
    expect(totals.hosts).toBe(2);
    expect(totals.instances).toBe(1);
    expect(totals.running).toBe(1);
    // Controller contributes too — hosts are 8+16 cores, RAM 16000+32000 MB
    // used 8000+16000. Totals include local as well.
    expect(totals.cores_total).toBe(24 + local.cores);
    expect(totals.ram_total_mb).toBe(48000 + local.mem_total_mb);
    expect(totals.ram_used_mb).toBe(24000 + local.mem_used_mb);
    expect(totals.gpu_count).toBe(1);
    expect(hosts).toHaveLength(2);
  });

  it("skips remote hosts without a successful probe in RAM totals (controller always counted)", () => {
    createHost(
      {
        name: "noprobe",
        address: "10.0.0.3",
        ssh_user: "u",
        auth_method: "privkey",
        privkey: PEM,
        capabilities: { cores: 4, ram_mb: 8000 },
      },
      db
    );
    const { totals, local } = computeDashboard(db);
    // The unprobed remote host doesn't contribute to RAM; only the
    // controller's own RAM shows up in the total.
    expect(totals.ram_total_mb).toBe(local.mem_total_mb);
    // Cores count the host's declared 4 + the controller's own cores.
    expect(totals.cores_total).toBe(4 + local.cores);
  });
});
