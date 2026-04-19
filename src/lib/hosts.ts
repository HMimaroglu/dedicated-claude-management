import crypto from "node:crypto";
import type { Db } from "./db";
import { getDb } from "./db";
import { decryptString, encryptString } from "./crypto";

export type HostStatus = "unknown" | "online" | "offline" | "quarantined" | "error";
export type AuthMethod = "privkey" | "agent";

export interface HostCapabilities {
  gpu?: string | null;
  gpu_count?: number;
  cores?: number;
  ram_mb?: number;
  storage_gb?: number;
  tags?: string[];
}

export interface HostRecord {
  id: number;
  name: string;
  address: string;
  port: number;
  ssh_user: string;
  auth_method: AuthMethod;
  known_host_key: string | null;
  capabilities: HostCapabilities;
  labels: string[];
  status: HostStatus;
  consecutive_failures: number;
  last_probe_at: number | null;
  last_probe_error: string | null;
  last_latency_ms: number | null;
  created_at: number;
  updated_at: number;
}

export interface HostCreateInput {
  name: string;
  address: string;
  port?: number;
  ssh_user: string;
  auth_method: AuthMethod;
  privkey?: string;
  passphrase?: string;
  capabilities?: HostCapabilities;
  labels?: string[];
}

export interface HostUpdateInput {
  name?: string;
  address?: string;
  port?: number;
  ssh_user?: string;
  auth_method?: AuthMethod;
  privkey?: string | null;
  passphrase?: string | null;
  capabilities?: HostCapabilities;
  labels?: string[];
}

interface HostRow {
  id: number;
  name: string;
  address: string;
  port: number;
  ssh_user: string;
  auth_method: AuthMethod;
  enc_privkey: string | null;
  enc_passphrase: string | null;
  known_host_key: string | null;
  capabilities: string;
  labels: string;
  status: HostStatus;
  consecutive_failures: number;
  last_probe_at: number | null;
  last_probe_error: string | null;
  last_latency_ms: number | null;
  created_at: number;
  updated_at: number;
}

function rowToHost(r: HostRow): HostRecord {
  return {
    id: r.id,
    name: r.name,
    address: r.address,
    port: r.port,
    ssh_user: r.ssh_user,
    auth_method: r.auth_method,
    known_host_key: r.known_host_key,
    capabilities: JSON.parse(r.capabilities || "{}") as HostCapabilities,
    labels: JSON.parse(r.labels || "[]") as string[],
    status: r.status,
    consecutive_failures: r.consecutive_failures,
    last_probe_at: r.last_probe_at,
    last_probe_error: r.last_probe_error,
    last_latency_ms: r.last_latency_ms,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

const HOST_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;

export function validateHostName(n: string): string | null {
  if (typeof n !== "string" || !HOST_NAME_RE.test(n)) {
    return "Name must be 1-64 chars, alphanumeric first, then [a-z0-9_.-]";
  }
  return null;
}

// Cloud metadata endpoints that should never be targeted via SSH probe. If
// someone points a host here we refuse at create/update time — adding such a
// host is almost always either a typo or an attempt to exploit SSRF.
const BLOCKED_ADDRESSES = new Set([
  "169.254.169.254",
  "fd00:ec2::254",
  "metadata.google.internal",
]);

export function validateAddress(a: string): string | null {
  if (typeof a !== "string") return "Address required";
  if (a.length < 1 || a.length > 253) return "Address length out of range";
  if (/\s/.test(a)) return "Address must not contain whitespace";
  if (a.includes("://")) return "Address must not be a URL";
  // Accept hostname, IPv4, IPv6 (optionally bracketed). Reject shell metachars
  // that have no place in a hostname/IP field.
  if (/[;&|`$<>(){}\\'"!*?#]/.test(a)) return "Address contains disallowed characters";
  if (BLOCKED_ADDRESSES.has(a.toLowerCase())) return "Address is blocked (metadata/internal)";
  return null;
}

// Structural validation — uses Node's crypto.createPrivateKey, which fails on
// malformed PEM instead of silently accepting garbage wrapped in BEGIN/END
// headers.
export function validatePrivkey(pem: string): string | null {
  if (typeof pem !== "string") return "privkey required";
  if (pem.length < 100 || pem.length > 32_768) return "privkey size out of range";
  try {
    crypto.createPrivateKey({ key: pem, format: "pem" });
    return null;
  } catch {
    return "privkey is not a valid PEM private key";
  }
}

export function validatePort(p: number): string | null {
  if (!Number.isInteger(p) || p < 1 || p > 65535) return "Port must be 1-65535";
  return null;
}

export function validateSshUser(u: string): string | null {
  if (typeof u !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,31}$/.test(u)) {
    return "SSH user must be 1-32 chars, alphanumeric first, then [a-z0-9_.-]";
  }
  return null;
}

export function createHost(input: HostCreateInput, d?: Db): HostRecord {
  const db = d ?? getDb();
  const now = Date.now();
  const port = input.port ?? 22;

  const errs = [
    validateHostName(input.name),
    validateAddress(input.address),
    validatePort(port),
    validateSshUser(input.ssh_user),
  ].filter((x): x is string => x !== null);
  if (errs.length) throw new Error(errs.join("; "));

  if (input.auth_method === "privkey") {
    if (!input.privkey) throw new Error("privkey is required for auth_method=privkey");
    const perr = validatePrivkey(input.privkey);
    if (perr) throw new Error(perr);
  }

  const encPrivkey = input.privkey ? encryptString(input.privkey) : null;
  const encPassphrase = input.passphrase ? encryptString(input.passphrase) : null;

  const r = db
    .prepare(
      `INSERT INTO hosts (
        name, address, port, ssh_user, auth_method,
        enc_privkey, enc_passphrase,
        capabilities, labels, status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?)`
    )
    .run(
      input.name,
      input.address,
      port,
      input.ssh_user,
      input.auth_method,
      encPrivkey,
      encPassphrase,
      JSON.stringify(input.capabilities ?? {}),
      JSON.stringify(input.labels ?? []),
      now,
      now
    );
  return getHost(Number(r.lastInsertRowid), db)!;
}

export function listHosts(d?: Db): HostRecord[] {
  const db = d ?? getDb();
  const rows = db.prepare("SELECT * FROM hosts ORDER BY name").all() as HostRow[];
  return rows.map(rowToHost);
}

export function getHost(id: number, d?: Db): HostRecord | null {
  const db = d ?? getDb();
  const row = db.prepare("SELECT * FROM hosts WHERE id = ?").get(id) as HostRow | undefined;
  return row ? rowToHost(row) : null;
}

export interface HostSecrets {
  privkey: string | null;
  passphrase: string | null;
}

export function getHostSecrets(id: number, d?: Db): HostSecrets | null {
  const db = d ?? getDb();
  const row = db
    .prepare("SELECT enc_privkey, enc_passphrase FROM hosts WHERE id = ?")
    .get(id) as { enc_privkey: string | null; enc_passphrase: string | null } | undefined;
  if (!row) return null;
  return {
    privkey: row.enc_privkey ? decryptString(row.enc_privkey) : null,
    passphrase: row.enc_passphrase ? decryptString(row.enc_passphrase) : null,
  };
}

export function updateHost(id: number, patch: HostUpdateInput, d?: Db): HostRecord | null {
  const db = d ?? getDb();
  const existing = getHost(id, db);
  if (!existing) return null;

  if (patch.name !== undefined) {
    const err = validateHostName(patch.name);
    if (err) throw new Error(err);
  }
  if (patch.address !== undefined) {
    const err = validateAddress(patch.address);
    if (err) throw new Error(err);
  }
  if (patch.port !== undefined) {
    const err = validatePort(patch.port);
    if (err) throw new Error(err);
  }
  if (patch.ssh_user !== undefined) {
    const err = validateSshUser(patch.ssh_user);
    if (err) throw new Error(err);
  }
  if (typeof patch.privkey === "string") {
    const err = validatePrivkey(patch.privkey);
    if (err) throw new Error(err);
  }

  const authMethod = patch.auth_method ?? existing.auth_method;

  // When switching away from privkey, wipe stored key material so it doesn't
  // linger in the DB (even though it's encrypted, fewer secrets at rest is
  // better — M2 from audit).
  const wipeSecrets = authMethod !== "privkey";

  let encPrivkey: string | null | undefined;
  let encPassphrase: string | null | undefined;

  if (wipeSecrets) {
    encPrivkey = null;
    encPassphrase = null;
  } else {
    encPrivkey =
      patch.privkey === undefined
        ? undefined
        : patch.privkey === null
          ? null
          : encryptString(patch.privkey);
    encPassphrase =
      patch.passphrase === undefined
        ? undefined
        : patch.passphrase === null
          ? null
          : encryptString(patch.passphrase);
  }

  const next = {
    name: patch.name ?? existing.name,
    address: patch.address ?? existing.address,
    port: patch.port ?? existing.port,
    ssh_user: patch.ssh_user ?? existing.ssh_user,
    auth_method: authMethod,
    capabilities: patch.capabilities ?? existing.capabilities,
    labels: patch.labels ?? existing.labels,
  };

  const now = Date.now();
  const applyUpdate = db.transaction(() => {
    // Always write the base fields.
    db.prepare(
      `UPDATE hosts SET name=?, address=?, port=?, ssh_user=?, auth_method=?,
       capabilities=?, labels=?, updated_at=? WHERE id=?`
    ).run(
      next.name,
      next.address,
      next.port,
      next.ssh_user,
      next.auth_method,
      JSON.stringify(next.capabilities),
      JSON.stringify(next.labels),
      now,
      id
    );
    if (encPrivkey !== undefined) {
      db.prepare("UPDATE hosts SET enc_privkey=? WHERE id=?").run(encPrivkey, id);
    }
    if (encPassphrase !== undefined) {
      db.prepare("UPDATE hosts SET enc_passphrase=? WHERE id=?").run(encPassphrase, id);
    }
  });
  applyUpdate();
  return getHost(id, db);
}

export function deleteHost(id: number, d?: Db): boolean {
  const db = d ?? getDb();
  const r = db.prepare("DELETE FROM hosts WHERE id = ?").run(id);
  return r.changes > 0;
}

export function unquarantineHost(id: number, d?: Db): void {
  const db = d ?? getDb();
  db.prepare(
    `UPDATE hosts SET status='unknown', consecutive_failures=0, updated_at=? WHERE id=?`
  ).run(Date.now(), id);
}

export interface ProbeResult {
  success: boolean;
  latency_ms: number | null;
  error: string | null;
  cpu_load_1m: number | null;
  mem_total_mb: number | null;
  mem_used_mb: number | null;
  disk_used_pct: number | null;
  gpu_info: Array<{ name: string; memory_total_mb?: number; memory_used_mb?: number; util_pct?: number }> | null;
}

export const QUARANTINE_THRESHOLD = 3;

export function recordProbe(hostId: number, r: ProbeResult, d?: Db): HostStatus {
  const db = d ?? getDb();
  const now = Date.now();

  const tx = db.transaction(() => {
    const host = getHost(hostId, db);
    if (!host) {
      // Host was deleted between probe dispatch and record — skip silently.
      return null as HostStatus | null;
    }

    db.prepare(
      `INSERT INTO host_probes
       (host_id, probed_at, latency_ms, success, error,
        cpu_load_1m, mem_total_mb, mem_used_mb, disk_used_pct, gpu_info)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      hostId,
      now,
      r.latency_ms,
      r.success ? 1 : 0,
      r.error,
      r.cpu_load_1m,
      r.mem_total_mb,
      r.mem_used_mb,
      r.disk_used_pct,
      r.gpu_info ? JSON.stringify(r.gpu_info) : null
    );

    let nextStatus: HostStatus = host.status;
    let nextFailures = host.consecutive_failures;

    if (r.success) {
      nextStatus = "online";
      nextFailures = 0;
    } else {
      nextFailures = host.consecutive_failures + 1;
      nextStatus = nextFailures >= QUARANTINE_THRESHOLD ? "quarantined" : "offline";
    }

    db.prepare(
      `UPDATE hosts SET status=?, consecutive_failures=?, last_probe_at=?,
       last_probe_error=?, last_latency_ms=?, updated_at=? WHERE id=?`
    ).run(nextStatus, nextFailures, now, r.error, r.latency_ms, now, hostId);

    return nextStatus;
  });

  const result = tx();
  return result ?? "unknown";
}

export interface ProbeSnapshot {
  probed_at: number;
  latency_ms: number | null;
  success: boolean;
  error: string | null;
  cpu_load_1m: number | null;
  mem_total_mb: number | null;
  mem_used_mb: number | null;
  disk_used_pct: number | null;
  gpu_info: unknown;
}

export function recentProbes(hostId: number, limit = 50, d?: Db): ProbeSnapshot[] {
  const db = d ?? getDb();
  const rows = db
    .prepare(
      `SELECT probed_at, latency_ms, success, error,
              cpu_load_1m, mem_total_mb, mem_used_mb, disk_used_pct, gpu_info
       FROM host_probes WHERE host_id = ? ORDER BY probed_at DESC LIMIT ?`
    )
    .all(hostId, limit) as Array<{
    probed_at: number;
    latency_ms: number | null;
    success: number;
    error: string | null;
    cpu_load_1m: number | null;
    mem_total_mb: number | null;
    mem_used_mb: number | null;
    disk_used_pct: number | null;
    gpu_info: string | null;
  }>;
  return rows.map((r) => ({
    probed_at: r.probed_at,
    latency_ms: r.latency_ms,
    success: r.success === 1,
    error: r.error,
    cpu_load_1m: r.cpu_load_1m,
    mem_total_mb: r.mem_total_mb,
    mem_used_mb: r.mem_used_mb,
    disk_used_pct: r.disk_used_pct,
    gpu_info: r.gpu_info ? JSON.parse(r.gpu_info) : null,
  }));
}
