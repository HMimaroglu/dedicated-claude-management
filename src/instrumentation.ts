// Next.js calls this once per server process on startup.
// We use it to launch the background heartbeat loop.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.DCM_DISABLE_HEARTBEAT === "true") return;
  const { startHeartbeat } = await import("./lib/heartbeat");
  startHeartbeat();
}
