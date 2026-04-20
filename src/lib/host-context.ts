import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Db } from "./db";
import { getDb } from "./db";
import { listHosts } from "./hosts";
import { listInstances } from "./instances";
import { getProject } from "./projects";

// Writes a .dcm/hosts.md file into each active instance's project directory
// so running Claude instances can read the latest available hosts. Called
// whenever hosts are added, updated, scanned, or deleted.

function expandHome(p: string): string {
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function buildHostsMd(db: Db): string {
  const hosts = listHosts(db);
  if (hosts.length === 0) {
    return "# Available Compute Hosts\n\nNo remote hosts registered.\n";
  }
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
    "# Available Compute Hosts",
    "",
    "You have SSH access to these machines. Use them for builds, tests, or compute-intensive work.",
    "",
    ...lines,
    "",
    `_Updated: ${new Date().toISOString()}_`,
    "",
  ].join("\n");
}

export async function updateHostFiles(d?: Db): Promise<void> {
  const db = d ?? getDb();
  const content = buildHostsMd(db);
  const instances = listInstances(db);
  const active = instances.filter((i) => i.status === "running" || i.status === "starting");

  // Deduplicate project paths so we don't write the same file twice.
  const seen = new Set<string>();
  for (const inst of active) {
    if (inst.host_id !== null) continue; // only local instances
    const project = getProject(inst.project_id, db);
    if (!project) continue;
    const projectPath = expandHome(project.path_on_host);
    if (seen.has(projectPath)) continue;
    seen.add(projectPath);

    try {
      const dcmDir = path.join(projectPath, ".dcm");
      await fs.mkdir(dcmDir, { recursive: true });
      await fs.writeFile(path.join(dcmDir, "hosts.md"), content, "utf8");
    } catch {
      // Project dir may not exist or be read-only — skip silently.
    }
  }
}
