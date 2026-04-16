import { readFileSync } from "node:fs";
import path from "node:path";

export type Role = "sd1" | "sd2" | "r1" | "r2" | "d1" | "d2" | "a1" | "a2" | "a3";

export const ALL_ROLES: Role[] = ["sd1", "sd2", "r1", "r2", "d1", "d2", "a1", "a2", "a3"];

export function roleCategory(role: Role): "sys-design" | "research" | "dev" | "auditor" {
  if (role === "sd1" || role === "sd2") return "sys-design";
  if (role === "r1" || role === "r2") return "research";
  if (role === "d1" || role === "d2") return "dev";
  return "auditor";
}

function roleFilename(role: Role): string {
  return `${roleCategory(role)}.md`;
}

export function roleIdentity(role: Role): string {
  // "A" or "B" for two-agent categories, "1"/"2"/"3" for auditors.
  if (role === "sd1" || role === "r1" || role === "d1") return "A";
  if (role === "sd2" || role === "r2" || role === "d2") return "B";
  if (role === "a1") return "1";
  if (role === "a2") return "2";
  return "3";
}

export function peerIdentity(role: Role): string {
  if (role === "sd1" || role === "r1" || role === "d1") return "B";
  if (role === "sd2" || role === "r2" || role === "d2") return "A";
  return "—"; // auditors don't have a single peer
}

export interface SystemPromptContext {
  role: Role;
}

const ROLES_DIR = path.join(process.cwd(), "src", "orchestrator", "roles");

function readRoleFile(name: string): string {
  return readFileSync(path.join(ROLES_DIR, name), "utf8");
}

let _sharedProtocolCache: string | null = null;
function loadSharedProtocol(): string {
  if (_sharedProtocolCache === null) {
    _sharedProtocolCache = readRoleFile(path.join("_shared", "phase-protocol.md"));
  }
  return _sharedProtocolCache;
}

const roleCache = new Map<string, string>();
function loadRoleTemplate(role: Role): string {
  const file = roleFilename(role);
  let cached = roleCache.get(file);
  if (cached !== undefined) return cached;
  cached = readRoleFile(file);
  roleCache.set(file, cached);
  return cached;
}

// Produces the final systemPrompt string for an SDK session. Substitutes
// {{identity}} and {{peer_identity}} placeholders and prepends the shared
// protocol.
export function buildSystemPrompt(ctx: SystemPromptContext): string {
  const tpl = loadRoleTemplate(ctx.role);
  const id = roleIdentity(ctx.role);
  const peer = peerIdentity(ctx.role);
  const rendered = tpl.replace(/\{\{identity\}\}/g, id).replace(/\{\{peer_identity\}\}/g, peer);
  return `${loadSharedProtocol()}\n\n---\n\n${rendered}`;
}

// Test hook: clear caches so tests can swap role files if needed.
export function _resetRolesCache(): void {
  _sharedProtocolCache = null;
  roleCache.clear();
}
