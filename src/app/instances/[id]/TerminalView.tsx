"use client";
import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import type { InstanceRecord } from "@/lib/instances";

export default function TerminalView({ instance }: { instance: InstanceRecord }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"idle" | "connecting" | "connected" | "closed" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    (async () => {
      setStatus("connecting");
      setError(null);
      // Fetch ticket
      const ticketRes = await fetch(`/api/instances/${instance.id}/terminal-ticket`, {
        method: "POST",
      });
      if (!ticketRes.ok) {
        const j = (await ticketRes.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "ticket failed");
        setStatus("error");
        return;
      }
      const { token } = (await ticketRes.json()) as { token: string };

      // xterm.js is client-only.
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (cancelled) return;

      const term = new Terminal({
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 13,
        theme: { background: "#09090b", foreground: "#e4e4e7" },
        cursorBlink: true,
        convertEol: true,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(containerRef.current!);
      try {
        fit.fit();
      } catch {
        // layout not ready yet, ignore
      }

      const wsUrl = buildWsUrl(token);
      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        setStatus("connected");
        try {
          fit.fit();
        } catch {
          // ignore
        }
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      };
      ws.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) {
          term.write(new Uint8Array(ev.data));
        } else if (typeof ev.data === "string") {
          term.write(ev.data);
        }
      };
      ws.onerror = () => {
        setStatus("error");
        setError("WebSocket error (WS server running? DCM_WS_PORT reachable?)");
      };
      ws.onclose = () => setStatus("closed");

      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data }));
        }
      });

      const onResize = () => {
        try {
          fit.fit();
        } catch {
          return;
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }
      };
      window.addEventListener("resize", onResize);

      cleanup = () => {
        window.removeEventListener("resize", onResize);
        try {
          ws.close();
        } catch {
          // ignore
        }
        term.dispose();
      };
    })();

    return () => {
      cancelled = true;
      if (cleanup) cleanup();
    };
  }, [instance.id]);

  return (
    <div className="bg-zinc-950 border border-zinc-800 rounded-md overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800 text-xs">
        <span className="text-zinc-500">tmux attach → {instance.tmux_session}</span>
        <span className="text-zinc-400">
          {status}
          {error ? ` — ${error}` : ""}
        </span>
      </div>
      <div ref={containerRef} className="h-96" />
    </div>
  );
}

function buildWsUrl(token: string): string {
  const wsPort = window.DCM_CONFIG?.wsPort ?? 3461;
  const wsHost = window.DCM_CONFIG?.wsHost ?? window.location.hostname;
  // We force the current window protocol family (ws for http, wss for https)
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${proto}//${wsHost}:${wsPort}`);
  url.searchParams.set("ticket", token);
  return url.toString();
}

declare global {
  interface Window {
    DCM_CONFIG?: { wsPort?: number; wsHost?: string };
  }
}
