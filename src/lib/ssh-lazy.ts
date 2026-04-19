// Lazy-loads ./ssh so call sites don't need direct imports.
// The dynamic import() ensures ssh2's native addon is only loaded at runtime
// on the server, not traced into client bundles. The Turbopack dev-mode
// warning about cpu-features.node is cosmetic and doesn't affect production.

let cached: typeof import("./ssh") | null = null;

export async function getSsh(): Promise<typeof import("./ssh")> {
  if (cached) return cached;
  cached = await import("./ssh");
  return cached;
}
