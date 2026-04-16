import { WebSocketServer, type WebSocket } from "ws";
import { redeemTerminalTicket } from "./terminal-tickets";
import { getInstance } from "./instances";
import { getHost } from "./hosts";
import { openSession, SshError } from "./ssh";
import { shQuote } from "./projects";

const PORT = (() => {
  const raw = process.env.DCM_WS_PORT;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : 3461;
})();
// Loopback-only by default. If the webapp is exposed on a LAN, the operator
// needs to intentionally open this.
const HOST = process.env.DCM_WS_HOST ?? "127.0.0.1";
// When the WS server is NOT loopback-only, require the operator to explicitly
// acknowledge — the ticket alone is thin for LAN exposure.
const INSECURE_LAN_ACK = process.env.DCM_WS_ALLOW_INSECURE_LAN === "true";
const IS_LOOPBACK = HOST === "127.0.0.1" || HOST === "::1" || HOST === "localhost";

// Origins allowed on WS upgrade. If DCM_APP_ORIGIN is set, only exact matches
// pass; otherwise we allow common loopback origins so dev works out of the box.
const ALLOWED_ORIGINS = (() => {
  const explicit = process.env.DCM_APP_ORIGIN;
  if (explicit) return new Set(explicit.split(",").map((s) => s.trim()).filter(Boolean));
  return null;
})();

function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return false;
  if (ALLOWED_ORIGINS) return ALLOWED_ORIGINS.has(origin);
  try {
    const u = new URL(origin);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1") {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

const GLOBAL_KEY = "__dcm_ws_server__";
type Singleton = { wss: WebSocketServer | null };
const g = globalThis as unknown as Record<string, Singleton>;
function state(): Singleton {
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { wss: null };
  return g[GLOBAL_KEY]!;
}

interface ClientToServer {
  type: "input" | "resize";
  data?: string;
  cols?: number;
  rows?: number;
}

export function startWsServer(): WebSocketServer {
  const s = state();
  if (s.wss) return s.wss;

  if (!IS_LOOPBACK && !INSECURE_LAN_ACK) {
    throw new Error(
      `[ws] refusing to bind to ${HOST} without DCM_WS_ALLOW_INSECURE_LAN=true. ` +
        `LAN exposure reduces terminal auth to a single 30s ticket; prefer a tunnel ` +
        `(ssh -L, Tailscale, etc.) or set the env var if you accept the risk.`
    );
  }

  const wss = new WebSocketServer({
    port: PORT,
    host: HOST,
    verifyClient: (info, cb) => {
      const origin = info.origin || info.req.headers.origin || undefined;
      if (!isOriginAllowed(origin)) {
        cb(false, 403, "bad origin");
        return;
      }
      cb(true);
    },
  });
  wss.on("connection", (ws, req) => handleConnection(ws, req.url ?? ""));
  wss.on("listening", () => {
    console.log(`[ws] listening on ws://${HOST}:${PORT}`);
  });
  wss.on("error", (e) => {
    console.error("[ws] server error:", e);
  });
  s.wss = wss;
  return wss;
}

export function stopWsServer(): void {
  const s = state();
  if (s.wss) {
    s.wss.close();
    s.wss = null;
  }
}

async function handleConnection(ws: WebSocket, rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl, `http://${HOST}`);
  } catch {
    ws.close(1008, "bad url");
    return;
  }
  const ticket = url.searchParams.get("ticket");
  if (!ticket) {
    ws.close(1008, "ticket required");
    return;
  }
  const redeemed = redeemTerminalTicket(ticket);
  if (!redeemed) {
    ws.close(1008, "invalid ticket");
    return;
  }
  const instance = getInstance(redeemed.instanceId);
  if (!instance) {
    ws.close(1011, "instance gone");
    return;
  }
  // Local instances (host_id=null) use the controller's own tmux. In that
  // case we'd need a PTY bridge (node-pty) which isn't wired yet. Close with
  // a clear message; the operator can `tmux attach -t dcm-<id>` from a local
  // shell on the controller in the meantime.
  if (instance.host_id === null) {
    safeSendText(
      ws,
      `\r\n[dcm] live terminal for local/controller instances is not yet wired. Use 'tmux attach -t ${instance.tmux_session}' from a shell on the controller.\r\n`
    );
    ws.close(1011, "local terminal not supported");
    return;
  }
  const host = getHost(instance.host_id);
  if (!host) {
    ws.close(1011, "host gone");
    return;
  }

  let sshConn;
  try {
    sshConn = await openSession(host);
  } catch (e) {
    const msg = e instanceof SshError || e instanceof Error ? e.message : String(e);
    safeSendText(ws, `\r\n[dcm] SSH failed: ${msg}\r\n`);
    ws.close(1011, "ssh failed");
    return;
  }

  const closed = { flag: false };
  const cleanup = () => {
    if (closed.flag) return;
    closed.flag = true;
    try {
      sshConn.end();
    } catch {
      // ignore
    }
  };

  sshConn.shell(
    { term: "xterm-256color", cols: 120, rows: 30 },
    (err, stream) => {
      if (err) {
        safeSendText(ws, `\r\n[dcm] shell failed: ${err.message}\r\n`);
        cleanup();
        ws.close(1011, "shell failed");
        return;
      }
      // Send bytes from SSH → browser (raw binary). Pause/resume the stream
      // when the WS is backpressured so a runaway `yes` inside tmux can't
      // exhaust Node memory.
      const BACKPRESSURE_LIMIT = 1 << 20; // 1 MiB buffered
      const forward = (d: Buffer) => {
        if (ws.readyState !== ws.OPEN) return;
        ws.send(d, { binary: true });
        if (ws.bufferedAmount > BACKPRESSURE_LIMIT) {
          stream.pause();
          const flush = () => {
            if (ws.bufferedAmount < BACKPRESSURE_LIMIT / 2) stream.resume();
            else setTimeout(flush, 25);
          };
          flush();
        }
      };
      stream.on("data", forward);
      stream.stderr.on("data", forward);
      stream.on("close", () => {
        cleanup();
        try {
          ws.close(1000, "stream closed");
        } catch {
          // ignore
        }
      });

      // Attach to the instance's tmux session. Single-quote wrap; session name
      // is DCM-generated safe.
      stream.write(`exec tmux attach -t ${shQuote(instance.tmux_session)}\n`);

      // Server → SSH: parse JSON frames from the client.
      ws.on("message", (msg, isBinary) => {
        if (closed.flag) return;
        if (isBinary) {
          // Treat raw bytes as input.
          stream.write(msg as Buffer);
          return;
        }
        const text = typeof msg === "string" ? msg : (msg as Buffer).toString("utf8");
        let parsed: ClientToServer | null = null;
        try {
          parsed = JSON.parse(text) as ClientToServer;
        } catch {
          // Fall back to raw write.
          stream.write(text);
          return;
        }
        if (parsed.type === "input" && typeof parsed.data === "string") {
          stream.write(parsed.data);
        } else if (
          parsed.type === "resize" &&
          Number.isInteger(parsed.cols) &&
          Number.isInteger(parsed.rows) &&
          (parsed.cols as number) > 0 &&
          (parsed.rows as number) > 0 &&
          (parsed.cols as number) < 1000 &&
          (parsed.rows as number) < 1000
        ) {
          stream.setWindow(parsed.rows as number, parsed.cols as number, 0, 0);
        }
      });
      ws.on("close", cleanup);
      ws.on("error", cleanup);
    }
  );
}

function safeSendText(ws: WebSocket, text: string): void {
  try {
    if (ws.readyState === ws.OPEN) ws.send(text);
  } catch {
    // ignore
  }
}

export const WS_PORT = PORT;
export const WS_HOST = HOST;
