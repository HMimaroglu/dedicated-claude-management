import { listWorkflows } from "@/lib/workflows";
import { advanceWorkflow } from "./orchestrator";
import { canAdvance } from "./orchestrator";
import { release, tryAcquire } from "./workflow-lock";

const DEFAULT_INTERVAL_MS = 10_000;
const INTERVAL_MS = (() => {
  const raw = process.env.DCM_WORKFLOW_WATCHER_INTERVAL_MS;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 1000 ? n : DEFAULT_INTERVAL_MS;
})();

const GLOBAL_KEY = "__dcm_workflow_watcher__";
type Singleton = { timer: NodeJS.Timeout | null };
const g = globalThis as unknown as Record<string, Singleton>;
function state(): Singleton {
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { timer: null };
  return g[GLOBAL_KEY]!;
}

export async function runWorkflowTickOnce(): Promise<void> {
  const workflows = listWorkflows().filter(canAdvance);
  for (const wf of workflows) {
    if (!tryAcquire(wf.id)) continue;
    // Fire-and-forget — one workflow advancing should not block the next.
    void advanceWorkflow(wf.id)
      .catch((e) => {
        console.error(`[workflow-watcher] advance failed id=${wf.id}:`, e);
      })
      .finally(() => release(wf.id));
  }
}

export function startWorkflowWatcher(): void {
  const s = state();
  if (s.timer) return;
  s.timer = setInterval(() => {
    void runWorkflowTickOnce();
  }, INTERVAL_MS);
  // Kick off immediately so newly-started workflows respond quickly.
  void runWorkflowTickOnce();
}

export function stopWorkflowWatcher(): void {
  const s = state();
  if (s.timer) {
    clearInterval(s.timer);
    s.timer = null;
  }
}

export const WORKFLOW_WATCHER_INTERVAL_MS = INTERVAL_MS;
