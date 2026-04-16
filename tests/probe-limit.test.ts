import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetProbeCooldown,
  checkProbeCooldown,
  PROBE_COOLDOWN_MS,
} from "../src/lib/probe-limit";

describe("probe cooldown", () => {
  beforeEach(() => _resetProbeCooldown());

  it("allows first call, blocks immediate repeat", () => {
    expect(checkProbeCooldown(1, 1000).allowed).toBe(true);
    const r = checkProbeCooldown(1, 1500);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBeGreaterThan(0);
  });

  it("allows after cooldown elapsed", () => {
    expect(checkProbeCooldown(1, 1000).allowed).toBe(true);
    expect(checkProbeCooldown(1, 1000 + PROBE_COOLDOWN_MS + 1).allowed).toBe(true);
  });

  it("is per-host", () => {
    expect(checkProbeCooldown(1, 1000).allowed).toBe(true);
    expect(checkProbeCooldown(2, 1001).allowed).toBe(true);
  });
});
