import type { Role } from "./roles";
import { roleCategory } from "./roles";

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "dontAsk"
  | "bypassPermissions"
  | "plan";

export interface RoleRuntimeConfig {
  allowedTools: string[];
  permissionMode: PermissionMode;
  // If true, calls to this role are constrained to producing text + no tools.
  // Used as an extra post-check on top of `allowedTools: []`.
  textOnly: boolean;
}

// Returns the per-role tool/permission configuration. Roles are sized tightly:
//   - sys-design: text only (no filesystem, no web) — we do not want architects
//     mutating code or browsing side channels.
//   - research: read-only local + web access for gathering sources.
//   - dev: read/write/bash, scoped to the workflow workspace via a hook.
//   - auditor: read-only — auditors never fix, they report.
export function roleConfig(role: Role): RoleRuntimeConfig {
  const cat = roleCategory(role);
  if (cat === "sys-design") {
    return { allowedTools: [], permissionMode: "plan", textOnly: true };
  }
  if (cat === "research") {
    return {
      allowedTools: ["Read", "Glob", "Grep", "WebSearch", "WebFetch"],
      permissionMode: "dontAsk",
      textOnly: false,
    };
  }
  if (cat === "auditor") {
    return {
      allowedTools: ["Read", "Glob", "Grep"],
      permissionMode: "dontAsk",
      textOnly: false,
    };
  }
  // Dev agents: no Bash for MVP. The Write/Edit hook constrains the filesystem
  // to the workspace, but a whitelisted Bash can still read/exfiltrate/rm
  // anything the DCM process user can reach — we do not run in a sandbox.
  // Rule of thumb: if a Bash command is needed (e.g., running tests), we add
  // it later behind an explicit per-command allow-list or an isolated
  // container. Today, dev operates on files only.
  return {
    allowedTools: ["Read", "Write", "Edit", "Glob", "Grep"],
    permissionMode: "acceptEdits",
    textOnly: false,
  };
}
