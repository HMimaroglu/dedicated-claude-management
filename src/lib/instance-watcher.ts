import { getDb } from "./db";
import {
  listInstances,
  refreshInstanceStatus,
  spawnInstance,
  setInstanceStatus,
  type InstanceRecord,
} from "./instances";

// Exponential backoff, clamped between 2 s and 5 min. restart_count is the
// authoritative counter; we translate it into a next_restart_at timestamp.
function backoffMs(restartCount: number): number {
  const base = 2000 * Math.pow(2, Math.max(0, restartCount - 1));
  return Math.min(base, 5 * 60_000);
}

const RESTART_WINDOW_MS = 30 * 60_000; // 30 min rolling window
const MAX_RESTARTS_IN_WINDOW = 10;

const DEFAULT_INTERVAL_MS = 5000;
const INTERVAL_MS = (() => {
  const raw = process.env.DCM_INSTANCE_WATCHER_INTERVAL_MS;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 1000 ? n : DEFAULT_INTERVAL_MS;
})();

const GLOBAL_KEY = "__dcm_instance_watcher__";
type Singleton = { timer: NodeJS.Timeout | null; inflight: boolean };
const g = globalThis as unknown as Record<string, Singleton>;
function state(): Singleton {
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { timer: null, inflight: false };
  return g[GLOBAL_KEY]!;
}

export function shouldAttemptRestart(inst: InstanceRecord, now: number): boolean {
  if (!inst.auto_restart) return false;
  if (inst.status !== "crashed") return false;
  if (inst.next_restart_at && now < inst.next_restart_at) return false;
  // Rate limit: if we've restarted >= MAX in the last WINDOW, give up.
  if (
    inst.last_restart_at &&
    now - inst.last_restart_at < RESTART_WINDOW_MS &&
    inst.restart_count >= MAX_RESTARTS_IN_WINDOW
  ) {
    return false;
  }
  return true;
}

export async function runInstanceWatcherOnce(): Promise<void> {
  const s = state();
  if (s.inflight) return;
  s.inflight = true;
  try {
    const now = Date.now();
    const instances = listInstances();
    // Refresh statuses first (detect crashes).
    await Promise.all(
      instances
        .filter((i) => i.status === "running" || i.status === "starting")
        .map((i) =>
          refreshInstanceStatus(i.id).catch((e) =>
            console.error(`[watcher] refresh failed id=${i.id}:`, e)
          )
        )
    );

    // Then attempt restarts for newly crashed instances.
    const db = getDb();
    const crashed = listInstances().filter((i) => i.status === "crashed");
    for (const inst of crashed) {
      if (!shouldAttemptRestart(inst, now)) {
        if (
          inst.auto_restart &&
          inst.last_restart_at &&
          now - inst.last_restart_at < RESTART_WINDOW_MS &&
          inst.restart_count >= MAX_RESTARTS_IN_WINDOW
        ) {
          // Give up — too many recent restarts. Move to error to stop looping.
          setInstanceStatus(
            inst.id,
            "error",
            { spawn_error: `auto-restart gave up after ${inst.restart_count} attempts` },
            db
          );
        }
        continue;
      }
      const nextCount = inst.restart_count + 1;
      db.prepare(
        `UPDATE instances SET restart_count = ?, last_restart_at = ?, next_restart_at = ?, updated_at = ? WHERE id = ?`
      ).run(nextCount, now, now + backoffMs(nextCount), now, inst.id);
      try {
        const result = await spawnInstance(inst.id);
        if (!result.success) {
          console.warn(`[watcher] restart failed id=${inst.id}: ${result.error}`);
        }
      } catch (e) {
        console.error(`[watcher] restart threw id=${inst.id}:`, e);
      }
    }

    // Reset restart_count for instances that have been stable past the window.
    db.prepare(
      `UPDATE instances SET restart_count = 0, next_restart_at = NULL
       WHERE status = 'running' AND last_restart_at IS NOT NULL AND ? - last_restart_at > ?`
    ).run(now, RESTART_WINDOW_MS);
  } finally {
    s.inflight = false;
  }
}

export function startInstanceWatcher(): void {
  const s = state();
  if (s.timer) return;
  s.timer = setInterval(() => {
    void runInstanceWatcherOnce();
  }, INTERVAL_MS);
  // Kick one off immediately for fresh state.
  void runInstanceWatcherOnce();
}

export function stopInstanceWatcher(): void {
  const s = state();
  if (s.timer) {
    clearInterval(s.timer);
    s.timer = null;
  }
}

export const INSTANCE_WATCHER_INTERVAL_MS = INTERVAL_MS;
export const INSTANCE_WATCHER_MAX_RESTARTS = MAX_RESTARTS_IN_WINDOW;
export const INSTANCE_WATCHER_WINDOW_MS = RESTART_WINDOW_MS;
export { backoffMs };
