"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Small client component that periodically triggers a Next.js server
// re-render. Put it on any server-rendered page that needs live-updating
// values (CPU load, memory, workflow state, …). Pauses when the tab is
// hidden so we don't burn work nobody's looking at.
export default function AutoRefresh({ intervalMs = 3000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const tick = (): void => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      router.refresh();
    };
    const t = setInterval(tick, intervalMs);
    return () => clearInterval(t);
  }, [router, intervalMs]);
  return null;
}
