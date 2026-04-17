// Workaround for a recurring node-pty packaging issue: on some npm/macOS
// combos the `spawn-helper` binary ships without the execute bit, which
// makes pty.spawn() fail at posix_spawnp. Restores +x on every prebuild so
// fresh installs don't break the terminal. Safe no-op if files are missing.
import { chmodSync, statSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const prebuildsDir = path.resolve(here, "..", "node_modules", "node-pty", "prebuilds");
if (!existsSync(prebuildsDir)) process.exit(0);

for (const entry of readdirSync(prebuildsDir)) {
  const helper = path.join(prebuildsDir, entry, "spawn-helper");
  if (!existsSync(helper)) continue;
  try {
    const s = statSync(helper);
    if ((s.mode & 0o111) === 0) {
      chmodSync(helper, 0o755);
      console.log(`[fix-node-pty-perms] +x ${path.relative(process.cwd(), helper)}`);
    }
  } catch (e) {
    console.warn(`[fix-node-pty-perms] skip ${helper}:`, e.message);
  }
}
