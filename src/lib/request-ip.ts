// Honor X-Forwarded-For / X-Real-IP only when DCM_TRUST_PROXY=true. Otherwise an
// attacker can spoof these headers and trivially bypass per-IP rate limits. Set
// the env var only when fronted by a reverse proxy that overwrites (not appends)
// these headers.
const TRUST_PROXY = process.env.DCM_TRUST_PROXY === "true";

export function getRequestIp(req: Request): string {
  if (TRUST_PROXY) {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) {
      const first = xff.split(",")[0]?.trim();
      if (first) return first;
    }
    const xri = req.headers.get("x-real-ip");
    if (xri) return xri;
  }
  // Without a trusted proxy, Next.js Request does not expose the socket peer.
  // Fall back to a constant so all unauth'd requests share a rate-limit bucket.
  return "direct";
}
