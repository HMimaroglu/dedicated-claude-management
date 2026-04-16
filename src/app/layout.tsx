import "./globals.css";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "DCM",
  description: "Dedicated Claude Management",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  const wsPort = Number.parseInt(process.env.DCM_WS_PORT ?? "3461", 10);
  const wsHost = process.env.DCM_WS_PUBLIC_HOST ?? "";
  // Escape </script and <!-- so a stray operator-supplied hostname can't break
  // out of the inline <script>.
  const cfg = JSON.stringify({ wsPort, wsHost })
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
  return (
    <html lang="en">
      <body className="bg-zinc-950 text-zinc-100 min-h-screen antialiased">
        <script
          // Expose the WS port to the browser. Safe JSON — no user input.
          dangerouslySetInnerHTML={{ __html: `window.DCM_CONFIG=${cfg};` }}
        />
        {children}
      </body>
    </html>
  );
}
