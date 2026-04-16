# Dedicated Claude Management (DCM)

A self-hosted webui for spawning and managing multiple **Claude Code** instances
(via `claude remote-control --dangerously-skip-permissions`) across one or
more machines over SSH. Each instance runs inside a persistent tmux session;
you get a live terminal in the browser through xterm.js.

Single admin account, server-side sessions, SQLite for state, AES-256-GCM at
rest for SSH private keys.

## Requirements

- Node.js 20+ (tested on 25)
- `tmux` installed on every host you want to run instances on (not required
  on the machine running DCM itself, only on the target hosts)
- `claude` CLI installed on the target hosts
- SSH access (key-based) from the controller to each host

## Install & run

```bash
npm install
npm run build
npm start
```

First boot creates `./data/app.db` and `./data/keys/master.key` (0600). Point
your browser at `http://localhost:3000`, create the admin account, then add
hosts and projects.

### Scripts

| | |
|--|--|
| `npm run dev` | Next.js dev server |
| `npm run build` | Production build |
| `npm start` | Run the built server (starts heartbeat + WS + instance watcher) |
| `npm test` | Vitest unit tests |
| `npm run typecheck` | TypeScript strict typecheck |

## How it works

1. **Hosts** — you register each machine (address, ssh_user, private key
   pasted into the form). DCM encrypts the key with a 32-byte master key
   that lives in `DCM_KEYS_DIR/master.key` (gitignored). Every 15 s a
   background loop SSHes into each host to record CPU load, free memory,
   disk %, and GPU info. 3 consecutive failures → quarantine.
2. **Projects** — either a git URL (DCM clones it onto the host at the
   specified path) or a local path (already present on the host). Cloning
   uses `git clone --depth=1 -- <url> <path>` with all values shell-quoted.
3. **Instances** — `POST /api/instances` spawns a tmux session on the
   project's host and runs `claude remote-control --dangerously-skip-permissions`
   inside it. The tmux pane PID is captured so pause/resume can send
   SIGSTOP/SIGCONT directly to the claude process.
4. **Live terminal** — xterm.js in the browser connects to a dedicated
   WebSocket server (loopback-only by default, port 3461). The browser
   obtains a single-use 30-second ticket from the authenticated API,
   passes it in the WS URL, and the server bridges WS ↔ SSH PTY running
   `tmux attach`.
5. **Auto-restart** — a background watcher polls instance status via
   `tmux has-session`. Instances that crash with `auto_restart=true`
   get respawned with exponential backoff (2s doubling, capped at 5 min,
   max 10 restarts per 30-min window).
6. **Scheduler** — `POST /api/scheduler/pick` ranks hosts against a
   requirements blob (gpu, min_cores, min_ram_mb, tags) using a weighted
   score of free CPU / memory / GPU from the last probe.

## Configuration

All configuration is via environment variables. See `.env.example` for the
full list. Copy it to `.env.local` and edit as needed.

Key toggles:

| Env var | Default | Notes |
|--|--|--|
| `DCM_DB_PATH` | `./data/app.db` | SQLite file |
| `DCM_KEYS_DIR` | `./data/keys` | Holds `master.key`, **gitignored** |
| `DCM_SECURE_COOKIES` | `true` in prod | Set `false` only when serving HTTP on a trusted LAN |
| `DCM_TRUST_PROXY` | `false` | Set `true` only when behind a reverse proxy that overwrites `X-Forwarded-For` |
| `DCM_WS_HOST` | `127.0.0.1` | WS terminal server bind address |
| `DCM_WS_PORT` | `3461` | WS terminal server port |
| `DCM_WS_ALLOW_INSECURE_LAN` | `false` | Required to bind WS server off-loopback |
| `DCM_APP_ORIGIN` | unset | Comma-separated allowed Origins for WS upgrade (defaults to localhost) |
| `DCM_HEARTBEAT_INTERVAL_MS` | `15000` | Host probe interval |
| `DCM_HEARTBEAT_CONCURRENCY` | `16` | Max parallel probes per cycle |
| `DCM_INSTANCE_WATCHER_INTERVAL_MS` | `5000` | Instance-watcher interval |

## Security notes (important)

- **Blast radius.** Every spawned instance runs
  `claude remote-control --dangerously-skip-permissions` — it can execute
  any shell command on the host as the SSH user. Treat DCM like you would
  an SSH jump host: restrict access, don't expose it publicly.
- **Secrets at rest.** SSH private keys and passphrases are AES-256-GCM
  encrypted with a 32-byte master key at `DCM_KEYS_DIR/master.key`. Back up
  the key file separately from the DB; the DB alone is useless without it.
  `.gitignore` covers both.
- **Admin password.** argon2id, m=64 MiB, t=3. Server-side session tokens
  (256-bit, SHA-256 hashed at rest, SameSite=Strict, Secure-by-default in
  production, 12 h TTL). Per-IP + per-username login rate limit.
- **Host key verification.** TOFU — the first fingerprint we see is pinned
  to `hosts.known_host_key`; subsequent connects must match or are
  rejected. No blind trust after first connect.
- **Webui auth for every mutating endpoint.** Origin header check + session
  cookie. Terminal WebSocket auth is a single-use 30-second ticket issued
  by the authenticated API; the WS server additionally checks the Origin
  header on upgrade and refuses to bind off-loopback without an explicit
  opt-in env var.
- **Credential redaction.** Anything resembling a PEM body or
  `user:password@` URL is stripped from error strings before being written
  to the DB or rendered in the UI.

## File layout

```
src/
  app/            Next.js App Router — pages + API routes
  lib/            Core libraries
    auth.ts       argon2 + session tokens
    crypto.ts     AES-256-GCM + master key mgmt
    db.ts         SQLite init + migrations
    hosts.ts      Host CRUD, probe recording
    ssh.ts        ssh2 client wrapper, TOFU host-key pin, probe parsers
    heartbeat.ts  Background host-probe loop
    projects.ts   Project CRUD, safe git clone
    instances.ts  tmux-session lifecycle (spawn/kill/pause/resume)
    instance-watcher.ts  Auto-restart loop with exp backoff
    terminal-tickets.ts  Single-use 30s tickets for WS upgrade
    ws-server.ts  Dedicated WebSocket server bridging SSH PTY ↔ xterm.js
    scheduler.ts  Rank hosts against requirements
    dashboard-metrics.ts  Aggregate view for dashboard
  instrumentation.ts  Boots heartbeat, WS server, and instance watcher
tests/             Vitest unit tests (140+)
```

## License

None attached. If you're looking at this repo, ask the author.
