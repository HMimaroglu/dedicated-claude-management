// Lazy-loads ./ssh at runtime so Turbopack's static analysis can't trace into
// ssh2 → cpu-features → .node and trigger the "not supported in browser" error.
// Every call site that needs ssh should use this instead of import("./ssh").

let cached: typeof import("./ssh") | null = null;

export async function getSsh(): Promise<typeof import("./ssh")> {
  if (cached) return cached;
  const mod = "./ss" + "h";
  cached = await (Function("m", "return import(m)")(mod) as Promise<typeof import("./ssh")>);
  return cached;
}
