import path from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import type { Db } from "./db";
import { getDb } from "./db";
import { getProject } from "./projects";
import type { Role } from "@/orchestrator/roles";

export type WorkflowState =
  | "idea_intake"
  | "decomposition"
  | "awaiting_human_gate"
  | "aspect_research"
  | "aspect_research_review"
  | "aspect_impl"
  | "aspect_audit"
  | "aspect_push"
  | "aspect_signoff"
  | "final_review"
  | "complete"
  | "paused"
  | "error";

export type AspectState =
  | "pending"
  | "research"
  | "review"
  | "impl"
  | "audit"
  | "push"
  | "signoff"
  | "complete"
  | "error";

export interface WorkflowRecord {
  id: number;
  project_id: number;
  name: string;
  idea: string;
  state: WorkflowState;
  current_aspect_ord: number | null;
  plan_md: string | null;
  workspace_path: string;
  require_human_gate: boolean;
  budget_usd: number;
  spent_usd: number;
  max_iterations_per_aspect: number;
  consensus_round: number;
  model: string;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  paused_at: number | null;
}

export interface AspectRecord {
  id: number;
  workflow_id: number;
  ord: number;
  title: string;
  description: string;
  depends_on: number[];
  acceptance_criteria: string | null;
  state: AspectState;
  research_md: string | null;
  loop_count: number;
  created_at: number;
  updated_at: number;
}

export interface WorkflowAgentRecord {
  id: number;
  workflow_id: number;
  role: Role;
  sdk_session_id: string | null;
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  last_text: string | null;
  created_at: number;
  updated_at: number;
}

export interface WorkflowEventRecord {
  id: number;
  workflow_id: number;
  aspect_ord: number | null;
  phase: string;
  actor_role: string | null;
  kind: string;
  payload: unknown;
  created_at: number;
}

export const DEFAULT_BUDGET_USD = 10.0;
export const MAX_BUDGET_USD = 1000.0;
export const DEFAULT_MAX_ITERATIONS_PER_ASPECT = 10;
export const MAX_ITERATIONS_CEILING = 50;
export const DEFAULT_MODEL = "claude-sonnet-4-6";
export const ALLOWED_MODELS = [
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-haiku-4-5-20251001",
];

export interface WorkflowCreateInput {
  project_id: number;
  name: string;
  idea: string;
  require_human_gate?: boolean;
  budget_usd?: number;
  max_iterations_per_aspect?: number;
  model?: string;
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_. -]{0,63}$/;

export function validateWorkflowName(n: unknown): string | null {
  if (typeof n !== "string" || !NAME_RE.test(n)) {
    return "Name must be 1-64 chars, alphanumeric first, then [a-z0-9_.- space]";
  }
  return null;
}

export function validateIdea(s: unknown): string | null {
  if (typeof s !== "string") return "Idea required";
  if (s.length < 10) return "Idea is too short (min 10 chars)";
  if (s.length > 10_000) return "Idea is too long (max 10000 chars)";
  return null;
}

export function validateBudget(n: unknown): string | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return "Budget must be a number";
  if (n <= 0) return "Budget must be positive";
  if (n > MAX_BUDGET_USD) return `Budget cannot exceed $${MAX_BUDGET_USD}`;
  return null;
}

export function workflowsRootDir(): string {
  return process.env.DCM_WORKFLOWS_DIR ?? path.join(process.cwd(), "data", "workflows");
}

function rowToWorkflow(r: Record<string, unknown>): WorkflowRecord {
  return {
    id: r.id as number,
    project_id: r.project_id as number,
    name: r.name as string,
    idea: r.idea as string,
    state: r.state as WorkflowState,
    current_aspect_ord: (r.current_aspect_ord as number | null) ?? null,
    plan_md: (r.plan_md as string | null) ?? null,
    workspace_path: r.workspace_path as string,
    require_human_gate: r.require_human_gate === 1,
    budget_usd: r.budget_usd as number,
    spent_usd: r.spent_usd as number,
    max_iterations_per_aspect: r.max_iterations_per_aspect as number,
    consensus_round: (r.consensus_round as number | null) ?? 0,
    model: r.model as string,
    last_error: (r.last_error as string | null) ?? null,
    created_at: r.created_at as number,
    updated_at: r.updated_at as number,
    completed_at: (r.completed_at as number | null) ?? null,
    paused_at: (r.paused_at as number | null) ?? null,
  };
}

function rowToAspect(r: Record<string, unknown>): AspectRecord {
  return {
    id: r.id as number,
    workflow_id: r.workflow_id as number,
    ord: r.ord as number,
    title: r.title as string,
    description: r.description as string,
    depends_on: JSON.parse((r.depends_on as string) || "[]") as number[],
    acceptance_criteria: (r.acceptance_criteria as string | null) ?? null,
    state: r.state as AspectState,
    research_md: (r.research_md as string | null) ?? null,
    loop_count: r.loop_count as number,
    created_at: r.created_at as number,
    updated_at: r.updated_at as number,
  };
}

export function createWorkflow(input: WorkflowCreateInput, d?: Db): WorkflowRecord {
  const db = d ?? getDb();

  const errs: string[] = [];
  const nerr = validateWorkflowName(input.name);
  if (nerr) errs.push(nerr);
  const ierr = validateIdea(input.idea);
  if (ierr) errs.push(ierr);
  const budget = input.budget_usd ?? DEFAULT_BUDGET_USD;
  const berr = validateBudget(budget);
  if (berr) errs.push(berr);
  const maxIter = input.max_iterations_per_aspect ?? DEFAULT_MAX_ITERATIONS_PER_ASPECT;
  if (!Number.isInteger(maxIter) || maxIter < 1 || maxIter > MAX_ITERATIONS_CEILING) {
    errs.push(`max_iterations_per_aspect must be 1-${MAX_ITERATIONS_CEILING}`);
  }
  const model = input.model ?? DEFAULT_MODEL;
  if (!ALLOWED_MODELS.includes(model)) {
    errs.push(`model must be one of: ${ALLOWED_MODELS.join(", ")}`);
  }
  if (!Number.isInteger(input.project_id) || input.project_id <= 0) {
    errs.push("project_id required");
  }
  if (errs.length) throw new Error(errs.join("; "));

  const project = getProject(input.project_id, db);
  if (!project) throw new Error("project not found");

  const now = Date.now();

  // workspace_path is assigned post-insert using the generated id so each
  // workflow has a deterministic directory under DCM_WORKFLOWS_DIR.
  const placeholder = `pending-${now}-${Math.random().toString(36).slice(2, 8)}`;
  const r = db
    .prepare(
      `INSERT INTO workflows (
        project_id, name, idea, state, workspace_path,
        require_human_gate, budget_usd, spent_usd,
        max_iterations_per_aspect, model, created_at, updated_at
      ) VALUES (?, ?, ?, 'idea_intake', ?, ?, ?, 0, ?, ?, ?, ?)`
    )
    .run(
      input.project_id,
      input.name,
      input.idea,
      placeholder,
      input.require_human_gate === false ? 0 : 1,
      budget,
      maxIter,
      model,
      now,
      now
    );
  const id = Number(r.lastInsertRowid);
  const finalWorkspace = path.join(workflowsRootDir(), `wf-${id}`);
  db.prepare("UPDATE workflows SET workspace_path = ? WHERE id = ?").run(finalWorkspace, id);

  // Create the workspace directory with 0700 perms so artifacts aren't readable
  // by other users on the host. Only swallow EEXIST — any other failure
  // (EACCES, ENOSPC, EROFS) must propagate so we don't leave an orphaned DB
  // row pointing at a non-existent directory.
  try {
    mkdirSync(finalWorkspace, { recursive: true, mode: 0o700 });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "EEXIST") {
      // Roll back the DB row so we don't leak an unusable workflow.
      try {
        db.prepare("DELETE FROM workflows WHERE id = ?").run(id);
      } catch {
        // best-effort rollback
      }
      throw new Error(`failed to create workflow workspace ${finalWorkspace}: ${err.message}`);
    }
  }

  return getWorkflow(id, db)!;
}

// Best-effort removal of the workflow's workspace directory. Safe no-op if
// the path doesn't exist. Guards against accidental recursive deletion of
// anything outside the configured workflows root.
export function removeWorkflowWorkspace(wf: WorkflowRecord): void {
  const root = path.resolve(workflowsRootDir());
  const target = path.resolve(wf.workspace_path);
  if (!target.startsWith(root + path.sep) && target !== root) {
    // Refuse — workspace_path points outside the configured root. This would
    // only happen if DCM_WORKFLOWS_DIR changed after the row was created,
    // which we intentionally don't follow.
    return;
  }
  // Never delete the root itself
  if (target === root) return;
  try {
    rmSync(target, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

export function getWorkflow(id: number, d?: Db): WorkflowRecord | null {
  const db = d ?? getDb();
  const row = db.prepare("SELECT * FROM workflows WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToWorkflow(row) : null;
}

export function listWorkflows(d?: Db): WorkflowRecord[] {
  const db = d ?? getDb();
  const rows = db.prepare("SELECT * FROM workflows ORDER BY created_at DESC").all() as Array<
    Record<string, unknown>
  >;
  return rows.map(rowToWorkflow);
}

export function listAspects(workflow_id: number, d?: Db): AspectRecord[] {
  const db = d ?? getDb();
  const rows = db
    .prepare("SELECT * FROM aspects WHERE workflow_id = ? ORDER BY ord")
    .all(workflow_id) as Array<Record<string, unknown>>;
  return rows.map(rowToAspect);
}

export function deleteWorkflow(id: number, d?: Db): boolean {
  const db = d ?? getDb();
  const r = db.prepare("DELETE FROM workflows WHERE id = ?").run(id);
  return r.changes > 0;
}

// Applies a structured state transition. Returns true if the UPDATE wrote a
// row; false if the workflow was in a different state than expected (optimistic
// concurrency).
export function transitionWorkflow(opts: {
  id: number;
  from: WorkflowState | null; // null = unconditional
  to: WorkflowState;
  current_aspect_ord?: number | null;
  plan_md?: string | null;
  paused_at?: number | null;
  completed_at?: number | null;
  last_error?: string | null;
  consensus_round?: number;
  db?: Db;
}): boolean {
  const db = opts.db ?? getDb();
  const now = Date.now();
  const sets: string[] = ["state = ?", "updated_at = ?"];
  const args: unknown[] = [opts.to, now];
  if (opts.current_aspect_ord !== undefined) {
    sets.push("current_aspect_ord = ?");
    args.push(opts.current_aspect_ord);
  }
  if (opts.plan_md !== undefined) {
    sets.push("plan_md = ?");
    args.push(opts.plan_md);
  }
  if (opts.paused_at !== undefined) {
    sets.push("paused_at = ?");
    args.push(opts.paused_at);
  }
  if (opts.completed_at !== undefined) {
    sets.push("completed_at = ?");
    args.push(opts.completed_at);
  }
  if (opts.last_error !== undefined) {
    sets.push("last_error = ?");
    args.push(opts.last_error);
  }
  if (opts.consensus_round !== undefined) {
    sets.push("consensus_round = ?");
    args.push(opts.consensus_round);
  }
  let sql = `UPDATE workflows SET ${sets.join(", ")} WHERE id = ?`;
  args.push(opts.id);
  if (opts.from !== null) {
    sql += " AND state = ?";
    args.push(opts.from);
  }
  const r = db.prepare(sql).run(...(args as unknown[] as readonly unknown[]));
  return r.changes > 0;
}

// Agents can produce very long responses; cap stored text to 100 KB to prevent
// O(N²) bloat across rounds (we interpolate peer's last_text back into the
// next task prompt) and to bound worst-case DB growth.
export const AGENT_LAST_TEXT_MAX_CHARS = 100_000;

export function setAgentLastText(
  workflow_id: number,
  role: Role,
  text: string,
  sdk_session_id?: string | null,
  d?: Db
): void {
  const db = d ?? getDb();
  const now = Date.now();
  let stored = text;
  if (stored.length > AGENT_LAST_TEXT_MAX_CHARS) {
    const head = stored.slice(0, AGENT_LAST_TEXT_MAX_CHARS - 2_000);
    const tail = stored.slice(stored.length - 2_000);
    stored = `${head}\n\n[...truncated by DCM: original was ${text.length} chars...]\n\n${tail}`;
  }
  db.prepare(
    `INSERT INTO workflow_agents (workflow_id, role, sdk_session_id, last_text, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(workflow_id, role) DO UPDATE SET
       last_text = excluded.last_text,
       sdk_session_id = COALESCE(excluded.sdk_session_id, workflow_agents.sdk_session_id),
       updated_at = excluded.updated_at`
  ).run(workflow_id, role, sdk_session_id ?? null, stored, now, now);
}

// Used when re-starting a workflow from paused; clears all agent sessions so
// the next advance starts with fresh prompts rather than stale last_text.
export function clearAgentLastText(workflow_id: number, d?: Db): void {
  const db = d ?? getDb();
  db.prepare(
    `UPDATE workflow_agents SET last_text = NULL, sdk_session_id = NULL, updated_at = ? WHERE workflow_id = ?`
  ).run(Date.now(), workflow_id);
}

export function getAgent(workflow_id: number, role: Role, d?: Db): WorkflowAgentRecord | null {
  const db = d ?? getDb();
  const row = db
    .prepare("SELECT * FROM workflow_agents WHERE workflow_id = ? AND role = ?")
    .get(workflow_id, role) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: row.id as number,
    workflow_id: row.workflow_id as number,
    role: row.role as Role,
    sdk_session_id: (row.sdk_session_id as string | null) ?? null,
    total_cost_usd: (row.total_cost_usd as number) ?? 0,
    total_input_tokens: (row.total_input_tokens as number) ?? 0,
    total_output_tokens: (row.total_output_tokens as number) ?? 0,
    last_text: (row.last_text as string | null) ?? null,
    created_at: row.created_at as number,
    updated_at: row.updated_at as number,
  };
}

export function insertAspects(
  workflow_id: number,
  aspects: Array<{
    ord: number;
    title: string;
    description: string;
    depends_on: number[];
    acceptance_criteria?: string | null;
  }>,
  d?: Db
): void {
  const db = d ?? getDb();
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO aspects (workflow_id, ord, title, description, depends_on, acceptance_criteria,
                          state, loop_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`
  );
  const tx = db.transaction(() => {
    for (const a of aspects) {
      stmt.run(
        workflow_id,
        a.ord,
        a.title,
        a.description,
        JSON.stringify(a.depends_on ?? []),
        a.acceptance_criteria ?? null,
        now,
        now
      );
    }
  });
  tx();
}

export function setProjectMultiAgent(projectId: number, enabled: boolean, d?: Db): boolean {
  const db = d ?? getDb();
  const r = db
    .prepare("UPDATE projects SET multi_agent_enabled = ?, updated_at = ? WHERE id = ?")
    .run(enabled ? 1 : 0, Date.now(), projectId);
  return r.changes > 0;
}

export function isProjectMultiAgentEnabled(projectId: number, d?: Db): boolean {
  const db = d ?? getDb();
  const row = db.prepare("SELECT multi_agent_enabled FROM projects WHERE id = ?").get(projectId) as
    | { multi_agent_enabled: number }
    | undefined;
  return row?.multi_agent_enabled === 1;
}

export function recentWorkflowEvents(
  workflow_id: number,
  limit = 100,
  d?: Db
): WorkflowEventRecord[] {
  const db = d ?? getDb();
  const rows = db
    .prepare(
      `SELECT * FROM workflow_events WHERE workflow_id = ? ORDER BY created_at DESC LIMIT ?`
    )
    .all(workflow_id, limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as number,
    workflow_id: r.workflow_id as number,
    aspect_ord: (r.aspect_ord as number | null) ?? null,
    phase: r.phase as string,
    actor_role: (r.actor_role as string | null) ?? null,
    kind: r.kind as string,
    payload: r.payload ? JSON.parse(r.payload as string) : null,
    created_at: r.created_at as number,
  }));
}

export function recordWorkflowEvent(opts: {
  workflow_id: number;
  aspect_ord?: number | null;
  phase: string;
  actor_role?: string | null;
  kind: string;
  payload?: unknown;
  db?: Db;
}): void {
  const db = opts.db ?? getDb();
  db.prepare(
    `INSERT INTO workflow_events (workflow_id, aspect_ord, phase, actor_role, kind, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.workflow_id,
    opts.aspect_ord ?? null,
    opts.phase,
    opts.actor_role ?? null,
    opts.kind,
    opts.payload === undefined ? null : JSON.stringify(opts.payload),
    Date.now()
  );
}
