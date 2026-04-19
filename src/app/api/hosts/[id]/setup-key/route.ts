import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/api-auth";
import { getHost } from "@/lib/hosts";
import { audit } from "@/lib/audit";
import { getRequestIp } from "@/lib/request-ip";
import { execLocal } from "@/lib/local-exec";
import { shQuote } from "@/lib/projects";

export const runtime = "nodejs";

const BodySchema = z.object({
  password: z.string().min(1, "Password required"),
});

// Uses sshpass + ssh-copy-id to push the controller's SSH public key to the
// remote host. The password is used once and never stored.
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

  // Check sshpass is available
  const hasSshpass = await execLocal("command -v sshpass", { timeoutMs: 3_000 });
  if (hasSshpass.code !== 0) {
    return NextResponse.json(
      { error: "sshpass is not installed on the controller. Install it first (apt install sshpass / brew install sshpass)." },
      { status: 500 }
    );
  }

  // Run ssh-copy-id via sshpass. The password is passed via SSHPASS env var
  // (never appears in argv/ps output). StrictHostKeyChecking=accept-new so
  // first connection to a new host doesn't prompt.
  const cmd = `sshpass -e ssh-copy-id -o StrictHostKeyChecking=accept-new -p ${host.port} ${shQuote(`${host.ssh_user}@${host.address}`)}`;
  const result = await execLocal(cmd, {
    timeoutMs: 30_000,
    env: { ...process.env, SSHPASS: parsed.data.password },
  });

  if (result.code !== 0) {
    const err = (result.stderr || result.stdout || "ssh-copy-id failed").slice(0, 500);
    return NextResponse.json({ error: err }, { status: 422 });
  }

  audit({
    event: "host.updated",
    actorUserId: auth.user.id,
    ip: getRequestIp(req),
    details: { host_id: hostId, action: "ssh-copy-id" },
  });

  return NextResponse.json({ ok: true, output: result.stdout.slice(0, 500) });
}
