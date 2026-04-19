import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client, type ConnectConfig } from "ssh2";
import type { Db } from "./db";
import { getDb } from "./db";
import type { HostRecord } from "./hosts";
import { getHostSecrets, type ProbeResult } from "./hosts";

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_EXEC_TIMEOUT_MS = 10_000;

// Finds the first default private key on the controller (~/.ssh/id_*).
async function findDefaultPrivateKey(): Promise<string | null> {
  const sshDir = path.join(os.homedir(), ".ssh");
  for (const name of ["id_ed25519", "id_rsa", "id_ecdsa"]) {
    try {
      const content = await fs.readFile(path.join(sshDir, name), "utf8");
      return content;
    } catch {
      continue;
    }
  }
  return null;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export class SshError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | "connect_timeout"
      | "auth_failed"
      | "host_unreachable"
      | "exec_timeout"
      | "no_creds"
      | "host_key_mismatch"
      | "other"
  ) {
    super(message);
    this.name = "SshError";
  }
}

// Strip secrets (PEM material, passphrases) from error text before we persist
// or return it over HTTP. Also trims length.
export function redactError(msg: string): string {
  if (!msg) return msg;
  // Strip anything that looks like a PEM body
  let out = msg.replace(
    /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g,
    "[REDACTED PEM]"
  );
  // Strip long base64-looking runs (≥40 chars) that might be key material
  out = out.replace(/[A-Za-z0-9+/=_-]{40,}/g, (m) =>
    m.length > 80 ? "[REDACTED]" : m
  );
  if (out.length > 512) out = out.slice(0, 512) + "…";
  return out;
}

// Compute a stable fingerprint for a host public key buffer (SHA-256 base64).
function hostKeyFingerprint(key: Buffer): string {
  return "SHA256:" + crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
}

export interface HostKeyDecision {
  accept: boolean;
  fingerprint: string;
  firstSeen: boolean;
  mismatch: boolean;
}

// TOFU host-key verifier. On first successful verify, we persist the
// fingerprint to hosts.known_host_key. Subsequent connects must match it or
// we refuse.
export function decideHostKey(
  stored: string | null,
  candidate: Buffer
): HostKeyDecision {
  const fp = hostKeyFingerprint(candidate);
  if (!stored) return { accept: true, fingerprint: fp, firstSeen: true, mismatch: false };
  const matches = crypto.timingSafeEqual(
    Buffer.from(stored),
    Buffer.from(fp.padEnd(stored.length, "\0").slice(0, stored.length))
  )
    ? stored === fp
    : false;
  return { accept: matches, fingerprint: fp, firstSeen: false, mismatch: !matches };
}

function pinHostKey(db: Db, hostId: number, fingerprint: string): void {
  db.prepare(
    "UPDATE hosts SET known_host_key = ?, updated_at = ? WHERE id = ? AND known_host_key IS NULL"
  ).run(fingerprint, Date.now(), hostId);
}

export async function openSession(
  host: HostRecord,
  opts?: { connectTimeoutMs?: number; db?: Db }
): Promise<Client> {
  const secrets = getHostSecrets(host.id);
  if (!secrets) throw new SshError(`host ${host.id} not found`, "other");

  const readyTimeout = opts?.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const db = opts?.db ?? getDb();
  let sawFingerprint: string | null = null;

  const cfg: ConnectConfig = {
    host: host.address,
    port: host.port,
    username: host.ssh_user,
    readyTimeout,
    hostVerifier: (keyHash: Buffer | string) => {
      // ssh2 passes the raw key bytes here.
      const buf = typeof keyHash === "string" ? Buffer.from(keyHash) : keyHash;
      const decision = decideHostKey(host.known_host_key, buf);
      sawFingerprint = decision.fingerprint;
      if (decision.mismatch) {
        // Connection will be aborted.
        return false;
      }
      return true;
    },
  };

  if (host.auth_method === "privkey") {
    if (!secrets.privkey) throw new SshError("privkey not set for host", "no_creds");
    cfg.privateKey = secrets.privkey;
    if (secrets.passphrase) cfg.passphrase = secrets.passphrase;
  } else if (host.auth_method === "agent") {
    const sock = process.env.SSH_AUTH_SOCK;
    if (sock) {
      cfg.agent = sock;
    } else {
      // No SSH agent — fall back to default key files on the controller.
      const keyFile = await findDefaultPrivateKey();
      if (!keyFile) throw new SshError("SSH_AUTH_SOCK not set and no default key found (~/.ssh/id_*)", "no_creds");
      cfg.privateKey = keyFile;
    }
  }

  return new Promise<Client>((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    const onError = (err: Error & { level?: string }) => {
      if (settled) return;
      settled = true;
      conn.removeAllListeners();
      try {
        conn.end();
      } catch {
        // ignore
      }
      const raw = err.message || String(err);
      const msg = redactError(raw);
      // If we saw a fingerprint but verification failed, distinguish the case.
      if (sawFingerprint && host.known_host_key && sawFingerprint !== host.known_host_key) {
        reject(
          new SshError(
            `host key mismatch (stored ${host.known_host_key}, got ${sawFingerprint})`,
            "host_key_mismatch"
          )
        );
        return;
      }
      if (err.level === "client-timeout") {
        reject(new SshError(`timeout: ${msg}`, "connect_timeout"));
      } else if (err.level === "client-authentication") {
        reject(new SshError(`auth failed: ${msg}`, "auth_failed"));
      } else if (/ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|ETIMEDOUT/.test(raw)) {
        reject(new SshError(msg, "host_unreachable"));
      } else {
        reject(new SshError(msg, "other"));
      }
    };
    conn.once("error", onError);
    conn.once("ready", () => {
      if (settled) return;
      settled = true;
      conn.removeListener("error", onError);
      // pin the fingerprint on first successful connect
      if (sawFingerprint && !host.known_host_key) {
        try {
          pinHostKey(db, host.id, sawFingerprint);
        } catch {
          // don't block session over audit failure
        }
      }
      // re-attach a generic error handler so later errors are caught silently
      conn.on("error", () => {
        // we don't want the unhandled-error crash; probeHost cleans up via finally
      });
      resolve(conn);
    });
    conn.connect(cfg);
  });
}

export async function execOnce(
  conn: Client,
  command: string,
  opts?: { timeoutMs?: number }
): Promise<ExecResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  return new Promise<ExecResult>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new SshError(`exec timeout after ${timeoutMs}ms`, "exec_timeout"));
    }, timeoutMs);

    conn.exec(command, (err, stream) => {
      if (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new SshError(redactError(err.message), "other"));
        return;
      }
      let stdout = "";
      let stderr = "";
      let code: number | null = null;
      stream.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      stream.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      stream.on("close", (c: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        code = c;
        resolve({ stdout, stderr, code });
      });
    });
  });
}

export function parseLoadAvg(uptimeOutput: string): number | null {
  const m = uptimeOutput.match(/load average[s]?:\s*([\d.]+)/i);
  if (!m || !m[1]) return null;
  const v = parseFloat(m[1]);
  return Number.isFinite(v) ? v : null;
}

export interface MemInfo {
  total_mb: number;
  used_mb: number;
}

export function parseLinuxFree(freeOutput: string): MemInfo | null {
  const lines = freeOutput.split(/\r?\n/);
  for (const line of lines) {
    if (/^Mem:/i.test(line)) {
      const parts = line.trim().split(/\s+/);
      const total = parseInt(parts[1] ?? "", 10);
      const used = parseInt(parts[2] ?? "", 10);
      if (Number.isFinite(total) && Number.isFinite(used)) return { total_mb: total, used_mb: used };
    }
  }
  return null;
}

export function parseDarwinMem(memOutput: string): MemInfo | null {
  const memsizeMatch = memOutput.match(/MEMSIZE:(\d+)/);
  if (!memsizeMatch || !memsizeMatch[1]) return null;
  const totalBytes = parseInt(memsizeMatch[1], 10);
  if (!Number.isFinite(totalBytes)) return null;

  const pageSizeMatch = memOutput.match(/page size of (\d+) bytes/);
  const pageSize = pageSizeMatch && pageSizeMatch[1] ? parseInt(pageSizeMatch[1], 10) : 4096;

  const freeMatch = memOutput.match(/Pages free:\s+(\d+)/);
  const specMatch = memOutput.match(/Pages speculative:\s+(\d+)/);
  const freePages =
    (freeMatch && freeMatch[1] ? parseInt(freeMatch[1], 10) : 0) +
    (specMatch && specMatch[1] ? parseInt(specMatch[1], 10) : 0);

  const totalMb = Math.round(totalBytes / (1024 * 1024));
  const freeMb = Math.round((freePages * pageSize) / (1024 * 1024));
  return { total_mb: totalMb, used_mb: Math.max(0, totalMb - freeMb) };
}

export function parseDiskUsedPct(dfOutput: string): number | null {
  const lines = dfOutput.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/\s(\d{1,3})%\s+\/$/);
    if (m && m[1]) {
      const v = parseInt(m[1], 10);
      if (Number.isFinite(v)) return v;
    }
  }
  return null;
}

export function parseNvidiaSmi(csv: string): ProbeResult["gpu_info"] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const gpus: NonNullable<ProbeResult["gpu_info"]> = [];
  for (const line of lines) {
    const parts = line.split(",").map((s) => s.trim());
    if (parts.length < 4) continue;
    const name = parts[0] ?? "gpu";
    const totalMem = parseInt(parts[1] ?? "", 10);
    const usedMem = parseInt(parts[2] ?? "", 10);
    const util = parseInt(parts[3] ?? "", 10);
    gpus.push({
      name,
      memory_total_mb: Number.isFinite(totalMem) ? totalMem : undefined,
      memory_used_mb: Number.isFinite(usedMem) ? usedMem : undefined,
      util_pct: Number.isFinite(util) ? util : undefined,
    });
  }
  return gpus.length > 0 ? gpus : null;
}

export async function runRemoteProbe(conn: Client): Promise<Omit<ProbeResult, "success" | "latency_ms" | "error">> {
  const uname = await execOnce(conn, "uname -s");
  const kernel = uname.stdout.trim().toLowerCase();

  const uptime = await execOnce(conn, "uptime");
  const cpu_load_1m = parseLoadAvg(uptime.stdout);

  let mem_total_mb: number | null = null;
  let mem_used_mb: number | null = null;

  if (kernel === "darwin") {
    const mem = await execOnce(
      conn,
      'printf "MEMSIZE:$(sysctl -n hw.memsize)\n"; vm_stat'
    );
    const parsed = parseDarwinMem(mem.stdout);
    if (parsed) {
      mem_total_mb = parsed.total_mb;
      mem_used_mb = parsed.used_mb;
    }
  } else {
    const mem = await execOnce(conn, "free -m");
    const parsed = parseLinuxFree(mem.stdout);
    if (parsed) {
      mem_total_mb = parsed.total_mb;
      mem_used_mb = parsed.used_mb;
    }
  }

  const disk = await execOnce(conn, "df -P /");
  const disk_used_pct = parseDiskUsedPct(disk.stdout);

  let gpu_info: ProbeResult["gpu_info"] = null;
  const nvidia = await execOnce(
    conn,
    "command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=name,memory.total,memory.used,utilization.gpu --format=csv,noheader,nounits || true"
  );
  if (nvidia.stdout.trim().length > 0) gpu_info = parseNvidiaSmi(nvidia.stdout);

  return { cpu_load_1m, mem_total_mb, mem_used_mb, disk_used_pct, gpu_info };
}

export async function probeHost(host: HostRecord): Promise<ProbeResult> {
  const start = Date.now();
  let conn: Client | null = null;
  try {
    conn = await openSession(host);
    const probe = await runRemoteProbe(conn);
    const latency_ms = Date.now() - start;
    return { success: true, latency_ms, error: null, ...probe };
  } catch (e) {
    const err = e instanceof Error ? redactError(e.message) : String(e);
    return {
      success: false,
      latency_ms: Date.now() - start,
      error: err,
      cpu_load_1m: null,
      mem_total_mb: null,
      mem_used_mb: null,
      disk_used_pct: null,
      gpu_info: null,
    };
  } finally {
    if (conn) {
      try {
        conn.end();
      } catch {
        // ignore close errors
      }
    }
  }
}
