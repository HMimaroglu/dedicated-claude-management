import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type Db = Database.Database;

export function createDb(dbPath: string): Db {
  if (dbPath !== ":memory:") {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const d = new Database(dbPath);
  d.pragma("journal_mode = WAL");
  d.pragma("foreign_keys = ON");
  d.pragma("synchronous = NORMAL");
  migrate(d);
  return d;
}

let _db: Db | null = null;

export function getDb(): Db {
  if (_db) return _db;
  const dbPath = process.env.DCM_DB_PATH ?? path.join(process.cwd(), "data", "app.db");
  _db = createDb(dbPath);
  return _db;
}

export function _resetForTests(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

function migrate(d: Db) {
  const userVersion = (d.pragma("user_version", { simple: true }) as number) ?? 0;

  d.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      ip TEXT,
      user_agent TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS login_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL,
      username TEXT,
      succeeded INTEGER NOT NULL,
      attempted_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(ip, attempted_at);

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event TEXT NOT NULL,
      actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      ip TEXT,
      details TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

    CREATE TABLE IF NOT EXISTS hosts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      address TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 22,
      ssh_user TEXT NOT NULL,
      auth_method TEXT NOT NULL CHECK (auth_method IN ('privkey', 'agent')),
      enc_privkey TEXT,
      enc_passphrase TEXT,
      known_host_key TEXT,
      capabilities TEXT NOT NULL DEFAULT '{}',
      labels TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'unknown'
        CHECK (status IN ('unknown','online','offline','quarantined','error')),
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_probe_at INTEGER,
      last_probe_error TEXT,
      last_latency_ms INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hosts_status ON hosts(status);

    CREATE TABLE IF NOT EXISTS host_probes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
      probed_at INTEGER NOT NULL,
      latency_ms INTEGER,
      success INTEGER NOT NULL,
      error TEXT,
      cpu_load_1m REAL,
      mem_total_mb INTEGER,
      mem_used_mb INTEGER,
      disk_used_pct INTEGER,
      gpu_info TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_host_probes_host_time
      ON host_probes(host_id, probed_at DESC);

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      source_type TEXT NOT NULL CHECK (source_type IN ('git','local')),
      git_url TEXT,
      git_branch TEXT,
      host_id INTEGER REFERENCES hosts(id) ON DELETE SET NULL,
      path_on_host TEXT NOT NULL,
      clone_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (clone_status IN ('pending','cloning','ready','error','skipped')),
      clone_error TEXT,
      last_cloned_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_projects_host ON projects(host_id);
    CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(clone_status);

    CREATE TABLE IF NOT EXISTS instances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
      host_id INTEGER NOT NULL REFERENCES hosts(id) ON DELETE RESTRICT,
      tmux_session TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'starting'
        CHECK (status IN ('starting','running','paused','stopped','crashed','error')),
      pid INTEGER,
      spawn_error TEXT,
      requirements TEXT NOT NULL DEFAULT '{}',
      auto_restart INTEGER NOT NULL DEFAULT 1,
      restart_count INTEGER NOT NULL DEFAULT 0,
      last_restart_at INTEGER,
      next_restart_at INTEGER,
      spawned_at INTEGER,
      stopped_at INTEGER,
      last_check_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_instances_host ON instances(host_id);
    CREATE INDEX IF NOT EXISTS idx_instances_status ON instances(status);
    CREATE INDEX IF NOT EXISTS idx_instances_project ON instances(project_id);

    CREATE TABLE IF NOT EXISTS terminal_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT NOT NULL UNIQUE,
      instance_id INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_terminal_tickets_token ON terminal_tickets(token_hash);
    CREATE INDEX IF NOT EXISTS idx_terminal_tickets_expires ON terminal_tickets(expires_at);
  `);

  // Schema version history:
  //   0 = initial (Phases 1-5)
  //   1 = Phase 6: add instances.auto_restart, last_restart_at, next_restart_at
  const TARGET_VERSION = 1;
  if (userVersion < 1) {
    const existingCols = d
      .prepare("PRAGMA table_info(instances)")
      .all() as Array<{ name: string }>;
    const names = new Set(existingCols.map((c) => c.name));
    if (!names.has("auto_restart")) {
      d.exec("ALTER TABLE instances ADD COLUMN auto_restart INTEGER NOT NULL DEFAULT 1");
    }
    if (!names.has("last_restart_at")) {
      d.exec("ALTER TABLE instances ADD COLUMN last_restart_at INTEGER");
    }
    if (!names.has("next_restart_at")) {
      d.exec("ALTER TABLE instances ADD COLUMN next_restart_at INTEGER");
    }
  }
  if (userVersion < TARGET_VERSION) {
    d.pragma(`user_version = ${TARGET_VERSION}`);
  }
}

export function hasAnyUser(d: Db = getDb()): boolean {
  const row = d.prepare("SELECT 1 FROM users LIMIT 1").get();
  return row !== undefined;
}
