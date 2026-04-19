import { NextResponse } from "next/server";
import { z } from "zod";
import { Client } from "ssh2";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireAuth } from "@/lib/api-auth";
import { getHost } from "@/lib/hosts";
import { audit } from "@/lib/audit";
import { getRequestIp } from "@/lib/request-ip";

export const runtime = "nodejs";

const BodySchema = z.object({
  password: z.string().min(1, "Password required"),
});

// Reads the controller's default public key (~/.ssh/id_*.pub).
async function readLocalPubKey(): Promise<string> {
  const sshDir = path.join(os.homedir(), ".ssh");
  for (const name of ["id_ed25519.pub", "id_rsa.pub", "id_ecdsa.pub"]) {
    try {
      const content = await fs.readFile(path.join(sshDir, name), "utf8");
      return content.trim();
    } catch {
      continue;
    }
  }
  throw new Error("No SSH public key found (~/.ssh/id_*.pub). Generate one with: ssh-keygen");
}

// Connects to the remote host with password auth via ssh2, reads the local
// public key, and appends it to ~/.ssh/authorized_keys. This is what
// ssh-copy-id does, without needing sshpass installed.
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const hostId = parseInt(id, 10);
  if (!Number.isFinite(hostId) || hostId <= 0) {
    return NextResponse.json({ error: "Bad id" }, { status: 400 });
  }
  const host = getHost(hostId);
  if (!host) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Bad input" }, { status: 400 });
  }

  // Read local public key
  let pubKey: string;
  try {
    pubKey = await readLocalPubKey();
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }

  // Connect with password auth and push the key
  const result = await new Promise<{ ok: boolean; error?: string; output?: string }>((resolve) => {
    const conn = new Client();
    const timeout = setTimeout(() => {
      conn.end();
      resolve({ ok: false, error: "Connection timed out (15s)" });
    }, 15_000);

    conn.on("ready", () => {
      // mkdir -p ~/.ssh, set perms, append key if not already present
      const cmd =
        `mkdir -p ~/.ssh && chmod 700 ~/.ssh && ` +
        `touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && ` +
        `grep -qF '${pubKey.replace(/'/g, "'\\''")}' ~/.ssh/authorized_keys 2>/dev/null || ` +
        `echo '${pubKey.replace(/'/g, "'\\''")}' >> ~/.ssh/authorized_keys`;

      conn.exec(cmd, (err, stream) => {
        if (err) {
          clearTimeout(timeout);
          conn.end();
          resolve({ ok: false, error: err.message });
          return;
        }
        let stdout = "";
        let stderr = "";
        stream.on("data", (d: Buffer) => { stdout += d.toString(); });
        stream.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
        stream.on("close", (code: number) => {
          clearTimeout(timeout);
          conn.end();
          if (code === 0) {
            resolve({ ok: true, output: "Key added to authorized_keys" });
          } else {
            resolve({ ok: false, error: (stderr || stdout || `exit code ${code}`).slice(0, 500) });
          }
        });
      });
    });

    conn.on("error", (err) => {
      clearTimeout(timeout);
      const msg = err.message || String(err);
      if (/authentication/i.test(msg)) {
        resolve({ ok: false, error: "Authentication failed — check password" });
      } else {
        resolve({ ok: false, error: msg.slice(0, 500) });
      }
    });

    conn.connect({
      host: host.address,
      port: host.port,
      username: host.ssh_user,
      password: parsed.data.password,
      readyTimeout: 10_000,
    });
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 422 });
  }

  audit({
    event: "host.updated",
    actorUserId: auth.user.id,
    ip: getRequestIp(req),
    details: { host_id: hostId, action: "push-ssh-key" },
  });

  return NextResponse.json({ ok: true, output: result.output });
}
