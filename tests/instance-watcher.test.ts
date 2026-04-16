import { describe, expect, it } from "vitest";
import {
  backoffMs,
  INSTANCE_WATCHER_MAX_RESTARTS,
  INSTANCE_WATCHER_WINDOW_MS,
  shouldAttemptRestart,
} from "../src/lib/instance-watcher";
import type { InstanceRecord } from "../src/lib/instances";

function inst(over: Partial<InstanceRecord>): InstanceRecord {
  return {
    id: 1,
    name: "n",
    project_id: 1,
    host_id: 1,
    tmux_session: "dcm-1",
    status: "crashed",
    pid: null,
    spawn_error: null,
    requirements: {},
    auto_restart: true,
    restart_count: 0,
    last_restart_at: null,
    next_restart_at: null,
    spawned_at: null,
    stopped_at: null,
    last_check_at: null,
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

describe("backoffMs", () => {
  it("doubles each restart, clamped to 5 min", () => {
    expect(backoffMs(1)).toBe(2000);
    expect(backoffMs(2)).toBe(4000);
    expect(backoffMs(3)).toBe(8000);
    expect(backoffMs(10)).toBe(5 * 60_000);
  });
});

describe("shouldAttemptRestart", () => {
  const now = 1_000_000;

  it("no when auto_restart is disabled", () => {
    expect(shouldAttemptRestart(inst({ auto_restart: false }), now)).toBe(false);
  });

  it("no when status is not crashed", () => {
    expect(shouldAttemptRestart(inst({ status: "running" }), now)).toBe(false);
    expect(shouldAttemptRestart(inst({ status: "stopped" }), now)).toBe(false);
    expect(shouldAttemptRestart(inst({ status: "paused" }), now)).toBe(false);
  });

  it("no when within backoff window", () => {
    expect(shouldAttemptRestart(inst({ next_restart_at: now + 1000 }), now)).toBe(false);
  });

  it("yes when backoff elapsed", () => {
    expect(shouldAttemptRestart(inst({ next_restart_at: now - 100 }), now)).toBe(true);
  });

  it("no when restart rate limit exceeded in window", () => {
    const i = inst({
      restart_count: INSTANCE_WATCHER_MAX_RESTARTS,
      last_restart_at: now - INSTANCE_WATCHER_WINDOW_MS / 2,
    });
    expect(shouldAttemptRestart(i, now)).toBe(false);
  });

  it("yes after window elapsed even with many prior restarts", () => {
    const i = inst({
      restart_count: INSTANCE_WATCHER_MAX_RESTARTS + 5,
      last_restart_at: now - INSTANCE_WATCHER_WINDOW_MS - 1000,
    });
    expect(shouldAttemptRestart(i, now)).toBe(true);
  });
});
