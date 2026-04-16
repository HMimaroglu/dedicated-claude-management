import type { Db } from "./db";
import { getDb } from "./db";
import { execOnce, openSession, SshError } from "./ssh";
import { getHost } from "./hosts";

export type SourceType = "git" | "local";
export type CloneStatus = "pending" | "cloning" | "ready" | "error" | "skipped";

export interface ProjectRecord {
  id: number;
  name: string;
  description: string | null;
  source_type: SourceType;
  git_url: string | null;
  git_branch: string | null;
  host_id: number | null;
  path_on_host: string;
  clone_status: CloneStatus;
  clone_error: string | null;
  last_cloned_at: number | null;
  multi_agent_enabled: boolean;
  created_at: number;
  updated_at: number;
}

export interface ProjectCreateInput {
  name: string;
  description?: string;
  source_type: SourceType;
  git_url?: string;
  git_branch?: string;
  // null or undefined means "the controller itself" (local). A specific
  // host_id refers to a remote host registered in the hosts table.
  host_id?: number | null;
  path_on_host: string;
}

export interface ProjectUpdateInput {
  name?: string;
  description?: string | null;
  git_url?: string;
  git_branch?: string;
  path_on_host?: string;
}

interface ProjectRow extends Omit<ProjectRecord, "multi_agent_enabled"> {
  multi_agent_enabled: number | null;
}

function rowToProject(r: ProjectRow): ProjectRecord {
  return {
    ...r,
    multi_agent_enabled: r.multi_agent_enabled === 1,
  };
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const BRANCH_RE = /^[a-zA-Z0-9][a-zA-Z0-9/._-]{0,127}$/;
// Allowed URL schemes. `file://` and `git://` (unauthenticated) are excluded —
// only over-the-wire secure forms. The body character set forbids shell
// metachars. We still single-quote all values before passing to the remote
// shell for defense in depth.
const URL_PATH = String.raw`[A-Za-z0-9._\-~:/?=&%+#]+`;
const HOST_RE = String.raw`[A-Za-z0-9][A-Za-z0-9.\-]*`;
// Optional `user@` userinfo (no password — enforced separately).
const USERINFO = String.raw`(?:[A-Za-z0-9._\-]+@)?`;
const GIT_URL_RE = new RegExp(
  `^(?:https://${USERINFO}${HOST_RE}(?::\\d+)?/${URL_PATH}` +
    `|ssh://${USERINFO}${HOST_RE}(?::\\d+)?/${URL_PATH}` +
    `|git@${HOST_RE}:[A-Za-z0-9._/\\-]+(?:\\.git)?)$`
);

export function validateProjectName(n: unknown): string | null {
  if (typeof n !== "string" || !NAME_RE.test(n)) {
    return "Name must be 1-64 chars, alphanumeric first, then [a-z0-9_.-]";
  }
  return null;
}

export function validateGitUrl(u: unknown): string | null {
  if (typeof u !== "string" || !GIT_URL_RE.test(u)) {
    return "Git URL must be https://, ssh://, or git@host:path form (no credentials in URL)";
  }
  // Reject URLs that embed a password (user:pass@host). A bare `user@host`
  // is fine for ssh:// (where the user is usually `git`); passwords are not.
  if (/^[a-z]+:\/\/[^/]*:[^/]*@/.test(u)) {
    return "Git URL must not embed a password (use SSH keys or a credential helper)";
  }
  return null;
}

// Redact any credentials that may appear in git output or a stored URL before
// we persist it or render it.
export function redactGitCredentials(s: string): string {
  if (!s) return s;
  // scheme://user:pass@host -> scheme://host
  return s.replace(/([a-z]+:\/\/)[^\s'"/@]+@/gi, "$1");
}

export function validateBranch(b: unknown): string | null {
  if (typeof b !== "string" || !BRANCH_RE.test(b)) {
    return "Branch name contains invalid characters";
  }
  return null;
}

export function validatePath(p: unknown): string | null {
  if (typeof p !== "string") return "Path required";
  if (p.length < 1 || p.length > 1024) return "Path length out of range";
  if (!p.startsWith("/") && !p.startsWith("~/")) {
    return "Path must be absolute (start with / or ~/)";
  }
  if (/\0/.test(p)) return "Path contains null byte";
  if (/[;&|`$<>*?'"\\]/.test(p)) return "Path contains disallowed characters";
  if (/(^|\/)\.\.(\/|$)/.test(p)) return "Path must not contain '..' components";
  // Require a non-trivial target — '/' or '~/' alone means git would try to
  // clone straight into the filesystem root / home, which is almost always
  // a mistake.
  const stripped = p.replace(/\/+$/, "");
  const segments = stripped.startsWith("~/")
    ? stripped.slice(2).split("/")
    : stripped.slice(1).split("/");
  if (segments.length < 1 || segments[0] === "") {
    return "Path must target a specific directory under / or ~/";
  }
  return null;
}

// Single-quote shell wrapper. Combined with strict validators above, enforces
// defense in depth against argument injection when we SSH exec.
export function shQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function createProject(input: ProjectCreateInput, d?: Db): ProjectRecord {
  const db = d ?? getDb();

  const errs: string[] = [];
  const nerr = validateProjectName(input.name);
  if (nerr) errs.push(nerr);
  const perr = validatePath(input.path_on_host);
  if (perr) errs.push(perr);
  if (input.description && input.description.length > 500) errs.push("Description too long");
  if (input.source_type === "git") {
    const uerr = validateGitUrl(input.git_url);
    if (uerr) errs.push(uerr);
    if (input.git_branch) {
      const berr = validateBranch(input.git_branch);
      if (berr) errs.push(berr);
    }
  }
  // host_id is optional: null/undefined means "local/controller".
  const hostId =
    input.host_id === null || input.host_id === undefined ? null : input.host_id;
  if (hostId !== null) {
    if (!Number.isInteger(hostId) || hostId <= 0) errs.push("host_id must be a positive integer or null");
  }
  if (errs.length) throw new Error(errs.join("; "));

  if (hostId !== null && !getHost(hostId, db)) throw new Error("host not found");

  const now = Date.now();
  const status: CloneStatus = input.source_type === "local" ? "skipped" : "pending";
  const r = db
    .prepare(
      `INSERT INTO projects (
        name, description, source_type, git_url, git_branch,
        host_id, path_on_host, clone_status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.name,
      input.description ?? null,
      input.source_type,
      input.source_type === "git" ? (input.git_url ?? null) : null,
      input.source_type === "git" ? (input.git_branch ?? null) : null,
      hostId,
      input.path_on_host,
      status,
      now,
      now
    );
  return getProject(Number(r.lastInsertRowid), db)!;
}

export function listProjects(d?: Db): ProjectRecord[] {
  const db = d ?? getDb();
  const rows = db.prepare("SELECT * FROM projects ORDER BY name").all() as ProjectRow[];
  return rows.map(rowToProject);
}

export function getProject(id: number, d?: Db): ProjectRecord | null {
  const db = d ?? getDb();
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  return row ? rowToProject(row) : null;
}

export function updateProject(id: number, patch: ProjectUpdateInput, d?: Db): ProjectRecord | null {
  const db = d ?? getDb();
  const existing = getProject(id, db);
  if (!existing) return null;

  if (patch.name !== undefined) {
    const err = validateProjectName(patch.name);
    if (err) throw new Error(err);
  }
  if (patch.path_on_host !== undefined) {
    const err = validatePath(patch.path_on_host);
    if (err) throw new Error(err);
  }
  if (patch.git_url !== undefined) {
    if (existing.source_type !== "git") throw new Error("git_url only valid for git projects");
    const err = validateGitUrl(patch.git_url);
    if (err) throw new Error(err);
  }
  if (patch.git_branch !== undefined) {
    if (existing.source_type !== "git") throw new Error("git_branch only valid for git projects");
    const err = validateBranch(patch.git_branch);
    if (err) throw new Error(err);
  }
  if (patch.description !== undefined && patch.description !== null) {
    if (patch.description.length > 500) throw new Error("Description too long");
  }

  const now = Date.now();
  db.prepare(
    `UPDATE projects SET
      name=?, description=?, git_url=?, git_branch=?, path_on_host=?, updated_at=?
      WHERE id=?`
  ).run(
    patch.name ?? existing.name,
    patch.description === undefined ? existing.description : patch.description,
    existing.source_type === "git" ? (patch.git_url ?? existing.git_url) : null,
    existing.source_type === "git" ? (patch.git_branch ?? existing.git_branch) : null,
    patch.path_on_host ?? existing.path_on_host,
    now,
    id
  );
  return getProject(id, db);
}

export function deleteProject(id: number, d?: Db): boolean {
  const db = d ?? getDb();
  const r = db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  return r.changes > 0;
}

function setCloneStatus(id: number, status: CloneStatus, error: string | null, d?: Db): void {
  const db = d ?? getDb();
  const now = Date.now();
  db.prepare(
    `UPDATE projects SET clone_status=?, clone_error=?, last_cloned_at=?, updated_at=? WHERE id=?`
  ).run(status, error ? redactGitCredentials(error) : null, status === "ready" ? now : null, now, id);
}

// Atomic "start clone" guard — returns true only if we flipped the status to
// 'cloning' from something else. Serializes concurrent POSTs.
export function tryClaimCloning(id: number, d?: Db): boolean {
  const db = d ?? getDb();
  const now = Date.now();
  const r = db
    .prepare(
      "UPDATE projects SET clone_status='cloning', updated_at=? WHERE id=? AND clone_status<>'cloning'"
    )
    .run(now, id);
  return r.changes > 0;
}

export interface CloneResult {
  success: boolean;
  stdout: string;
  stderr: string;
  error: string | null;
}

// Runs git clone on the host's side of the SSH session. Uses shQuote for all
// user-supplied values, and `--` to stop option parsing before the URL.
export async function cloneProject(projectId: number, d?: Db): Promise<CloneResult> {
  const db = d ?? getDb();
  const p = getProject(projectId, db);
  if (!p) throw new Error("project not found");
  if (p.source_type !== "git") throw new Error("only git projects can be cloned");
  if (!p.git_url) throw new Error("project missing git_url");

  if (!tryClaimCloning(projectId, db)) {
    throw new Error("another clone is in progress");
  }

  const branchFlag = p.git_branch ? `--branch ${shQuote(p.git_branch)}` : "";
  const gitCmd =
    `mkdir -p -- ${shQuote(dirname(p.path_on_host))} && ` +
    `GIT_TERMINAL_PROMPT=0 git clone --depth=1 ${branchFlag} -- ` +
    `${shQuote(p.git_url)} ${shQuote(p.path_on_host)}`;

  // Local clone (host_id is null → runs on the controller itself).
  if (p.host_id === null) {
    const { execLocal } = await import("./local-exec");
    try {
      const res = await execLocal(gitCmd, { timeoutMs: 60_000 });
      const ok = res.code === 0;
      const error = ok ? null : (res.stderr || res.stdout || `exit ${res.code}`).slice(0, 512);
      setCloneStatus(projectId, ok ? "ready" : "error", error, db);
      return { success: ok, stdout: res.stdout, stderr: res.stderr, error };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setCloneStatus(projectId, "error", msg.slice(0, 512), db);
      return { success: false, stdout: "", stderr: "", error: msg };
    }
  }

  // Remote clone over SSH.
  const host = getHost(p.host_id, db);
  if (!host) throw new Error("host not found");

  let conn;
  try {
    conn = await openSession(host);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setCloneStatus(projectId, "error", `ssh failed: ${msg}`, db);
    return { success: false, stdout: "", stderr: "", error: `ssh failed: ${msg}` };
  }

  try {
    const res = await execOnce(conn, gitCmd, { timeoutMs: 60_000 });
    const ok = res.code === 0;
    const error = ok ? null : (res.stderr || res.stdout || `exit ${res.code}`).slice(0, 512);
    setCloneStatus(projectId, ok ? "ready" : "error", error, db);
    return { success: ok, stdout: res.stdout, stderr: res.stderr, error };
  } catch (e) {
    const msg =
      e instanceof SshError ? e.message : e instanceof Error ? e.message : String(e);
    setCloneStatus(projectId, "error", msg.slice(0, 512), db);
    return { success: false, stdout: "", stderr: "", error: msg };
  } finally {
    try {
      conn.end();
    } catch {
      // ignore
    }
  }
}

// Pure helper for dirname (avoids importing node:path in the clone command
// construction path, and lets it work predictably with ~/ prefixes).
export function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  if (i <= 0) return p.startsWith("~/") ? "~" : "/";
  return p.slice(0, i);
}
