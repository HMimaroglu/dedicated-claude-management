import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Db } from "./db";
import { getDb } from "./db";
import { listHosts } from "./hosts";
import { listInstances } from "./instances";
import { getProject } from "./projects";

function expandHome(p: string): string {
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function buildHostsSection(db: Db): string {
  const hosts = listHosts(db);
  if (hosts.length === 0) return "";
  const lines = hosts.map((h) => {
    const caps: string[] = [];
    if (h.capabilities.cores) caps.push(`${h.capabilities.cores} cores`);
    if (h.capabilities.ram_mb) caps.push(`${Math.round(h.capabilities.ram_mb / 1024)} GB RAM`);
    if (h.capabilities.storage_gb) caps.push(`${h.capabilities.storage_gb} GB storage`);
    if (h.capabilities.gpu) caps.push(`GPU: ${h.capabilities.gpu}`);
    return [
      `### ${h.name}`,
      `- **SSH**: \`${h.ssh_user}@${h.address}:${h.port}\``,
      `- **Status**: ${h.status}`,
      caps.length ? `- **Specs**: ${caps.join(", ")}` : null,
    ].filter(Boolean).join("\n");
  });
  return [
    "## Available Compute Hosts",
    "",
    "You have SSH access to these machines. Use them freely for builds, tests, or any compute-intensive work.",
    "",
    ...lines,
  ].join("\n");
}

// Writes .dcm/system-prompt.md into the project directory. This file is
// referenced via --append-system-prompt-file at spawn time and also updated
// live when hosts change so Claude can re-read it.
export async function writeSystemPromptFile(
  projectPath: string,
  db: Db,
  opts?: { includeWorkflow?: boolean }
): Promise<string> {
  const expanded = expandHome(projectPath);
  const dcmDir = path.join(expanded, ".dcm");
  await fs.mkdir(dcmDir, { recursive: true });

  const sections: string[] = [];
  const hostSection = buildHostsSection(db);
  if (hostSection) sections.push(hostSection);
  if (opts?.includeWorkflow) {
    sections.push(WORKFLOW_PROMPT);
  }
  sections.push(`\n_DCM system prompt — updated ${new Date().toISOString()}_`);

  const content = sections.join("\n\n");
  const filePath = path.join(dcmDir, "system-prompt.md");
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

// Updates .dcm/system-prompt.md in ALL active local instance project dirs.
// Called when hosts are added/updated/deleted so running instances see changes.
export async function updateHostFiles(d?: Db): Promise<void> {
  const db = d ?? getDb();
  const instances = listInstances(db);
  const active = instances.filter((i) =>
    (i.status === "running" || i.status === "starting") && i.host_id === null
  );

  const seen = new Set<string>();
  for (const inst of active) {
    const project = getProject(inst.project_id, db);
    if (!project) continue;
    const projectPath = expandHome(project.path_on_host);
    if (seen.has(projectPath)) continue;
    seen.add(projectPath);

    try {
      // Preserve workflow flag if it was originally set — we just update the
      // hosts section. Read existing file to check.
      const existing = await fs.readFile(
        path.join(projectPath, ".dcm", "system-prompt.md"), "utf8"
      ).catch(() => "");
      const hadWorkflow = existing.includes("## Development Workflow");
      await writeSystemPromptFile(projectPath, db, { includeWorkflow: hadWorkflow });
    } catch {
      // skip
    }
  }
}

const WORKFLOW_PROMPT = `## Development Workflow

Follow this phased workflow for every task.

### Phase 1: System Design & Decomposition
Before writing any code:
1. Analyze the requirements thoroughly
2. Break the task into discrete, testable subtasks
3. Identify architectural decisions, trade-offs, and dependencies
4. Define the interfaces between components
5. Write a brief plan (what files to create/modify, in what order)
Do NOT skip this phase.

### Phase 2: Research
Before implementing:
1. Read all relevant existing code — understand what's already there
2. Check for existing patterns, utilities, or abstractions you should reuse
3. Identify potential conflicts with existing code
4. Note any edge cases from the existing codebase

### Phase 3: Implementation
1. Follow existing code style and conventions exactly
2. Implement one subtask at a time, in dependency order
3. Keep changes minimal — don't refactor unrelated code
4. Write tests alongside implementation, not after
5. Each change should be independently correct

### Phase 4: Audit & Review
After implementation:
1. Re-read every file you changed — look for bugs, edge cases, security issues
2. Run all tests and fix any failures
3. Check for: SQL injection, command injection, XSS, path traversal, auth bypass
4. Verify error handling — what happens when things fail?
5. Ensure no secrets, credentials, or PII in source code

### Security Rules
- Always use parameterized queries for SQL
- Always shell-quote user-supplied values
- Validate all input at system boundaries
- Never store passwords in plaintext
- Never commit secrets or API keys

### Code Quality Rules
- Don't add features beyond what was asked
- Don't add speculative abstractions
- Prefer editing existing files over creating new ones
- Three similar lines > one premature abstraction`;
