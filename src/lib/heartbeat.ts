import { listHosts, recordProbe } from "./hosts";
// Dynamic ssh import: keeps ssh2 (+ cpu-features native .node) out of the
// top-level module graph so Next.js dev doesn't try to bundle it.

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_CONCURRENCY = 16;
const INTERVAL_MS = (() => {
  const raw = process.env.DCM_HEARTBEAT_INTERVAL_MS;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 2000 ? n : DEFAULT_INTERVAL_MS;
})();
const CONCURRENCY = (() => {
  const raw = process.env.DCM_HEARTBEAT_CONCURRENCY;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 1 && n <= 256 ? n : DEFAULT_CONCURRENCY;
})();

// Guard against HMR double-start in dev (and against anyone importing this
// module more than once via different cache paths).
const GLOBAL_KEY = "__dcm_heartbeat_singleton__";
type Singleton = { timer: NodeJS.Timeout | null; inflight: boolean };
const g = globalThis as unknown as Record<string, Singleton>;
function state(): Singleton {
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { timer: null, inflight: false };
  return g[GLOBAL_KEY]!;
}

export function isHeartbeatRunning(): boolean {
  return state().timer !== null;
}

async function runBatched<T, R>(
  items: T[],
  limit: number,
  worker: (t: T) => Promise<R>
): Promise<void> {
  let i = 0;
  const runners: Promise<void>[] = [];
  const n = Math.min(limit, items.length);
  for (let k = 0; k < n; k++) {
    runners.push(
      (async () => {
        while (true) {
          const idx = i++;
          if (idx >= items.length) return;
          try {
            await worker(items[idx]!);
          } catch (e) {
            console.error("[heartbeat] worker error:", e);
          }
        }
      })()
    );
  }
  await Promise.all(runners);
}

export async function runHeartbeatOnce(): Promise<void> {
  const s = state();
  if (s.inflight) return;
  s.inflight = true;
  try {
    const hosts = listHosts();
    const active = hosts.filter((h) => h.status !== "quarantined");
    if (active.length === 0) return;
    // Lazy-load ssh.ts so the native addon is only touched when we actually
    // have a remote host to probe.
    const { probeHost } = await import("./ssh");
    await runBatched(active, CONCURRENCY, async (h) => {
      const result = await probeHost(h);
      try {
        recordProbe(h.id, result);
      } catch (e) {
        console.error(`[heartbeat] record failed for host=${h.id}:`, e);
      }
    });
  } finally {
    s.inflight = false;
  }
}

export function startHeartbeat(): void {
  const s = state();
  if (s.timer) return;
  s.timer = setInterval(() => {
    void runHeartbeatOnce();
  }, INTERVAL_MS);
  // Kick off immediately so fresh hosts reflect status fast.
  void runHeartbeatOnce();
}

export function stopHeartbeat(): void {
  const s = state();
  if (s.timer) {
    clearInterval(s.timer);
    s.timer = null;
  }
}

export const HEARTBEAT_INTERVAL_MS = INTERVAL_MS;
export const HEARTBEAT_CONCURRENCY = CONCURRENCY;
