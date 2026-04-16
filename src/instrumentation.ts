// Next.js calls this once per server process on startup.
// We use it to launch the background heartbeat loop, the terminal WS server,
// the instance watcher, and the workflow watcher — and to install a clean
// shutdown so Ctrl+C actually quits. Without the signal handlers, each
// setInterval + the WS server hold the event loop open and ^C does nothing.

let registered = false;

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (registered) return;
  registered = true;

  const stopFns: Array<() => void | Promise<void>> = [];

  if (process.env.DCM_DISABLE_HEARTBEAT !== "true") {
    const { startHeartbeat, stopHeartbeat } = await import("./lib/heartbeat");
    startHeartbeat();
    stopFns.push(stopHeartbeat);
  }
  if (process.env.DCM_DISABLE_WS !== "true") {
    const { startWsServer, stopWsServer } = await import("./lib/ws-server");
    startWsServer();
    stopFns.push(stopWsServer);
  }
  if (process.env.DCM_DISABLE_INSTANCE_WATCHER !== "true") {
    const { startInstanceWatcher, stopInstanceWatcher } = await import("./lib/instance-watcher");
    startInstanceWatcher();
    stopFns.push(stopInstanceWatcher);
  }
  if (process.env.DCM_DISABLE_WORKFLOW_WATCHER !== "true") {
    const { startWorkflowWatcher, stopWorkflowWatcher } = await import(
      "./orchestrator/workflow-watcher"
    );
    startWorkflowWatcher();
    stopFns.push(stopWorkflowWatcher);
  }

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      // Second Ctrl+C: stop being polite, just exit.
      process.exit(130);
    }
    shuttingDown = true;
    console.log(`\n[dcm] ${signal} received, shutting down…`);
    // Hard deadline so a stuck shutdown doesn't leave the terminal hung.
    const deadline = setTimeout(() => {
      console.warn("[dcm] shutdown stalled after 3s, forcing exit");
      process.exit(1);
    }, 3_000);
    deadline.unref();
    for (const fn of stopFns) {
      try {
        await fn();
      } catch (e) {
        console.warn("[dcm] shutdown step failed:", e);
      }
    }
    clearTimeout(deadline);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
