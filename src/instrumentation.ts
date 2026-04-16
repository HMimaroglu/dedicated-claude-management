// Next.js calls this once per server process on startup.
// We use it to launch the background heartbeat loop and the terminal WS server.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.DCM_DISABLE_HEARTBEAT !== "true") {
    const { startHeartbeat } = await import("./lib/heartbeat");
    startHeartbeat();
  }
  if (process.env.DCM_DISABLE_WS !== "true") {
    const { startWsServer } = await import("./lib/ws-server");
    startWsServer();
  }
  if (process.env.DCM_DISABLE_INSTANCE_WATCHER !== "true") {
    const { startInstanceWatcher } = await import("./lib/instance-watcher");
    startInstanceWatcher();
  }
}
