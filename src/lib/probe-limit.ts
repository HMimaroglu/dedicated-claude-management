// Simple per-host cooldown to prevent an authenticated user from hammering
// /api/hosts/:id/probe. In-memory is fine: a restart resets it, and worst-case
// an attacker still pays the TCP+SSH handshake cost on the target.

const COOLDOWN_MS = 2000;
const last = new Map<number, number>();

export interface ProbeCooldownResult {
  allowed: boolean;
  retryAfterMs: number;
}

export function checkProbeCooldown(hostId: number, now = Date.now()): ProbeCooldownResult {
  const t = last.get(hostId);
  if (t && now - t < COOLDOWN_MS) {
    return { allowed: false, retryAfterMs: COOLDOWN_MS - (now - t) };
  }
  last.set(hostId, now);
  return { allowed: true, retryAfterMs: 0 };
}

export function _resetProbeCooldown(): void {
  last.clear();
}

export const PROBE_COOLDOWN_MS = COOLDOWN_MS;
