import { describe, expect, it } from "vitest";
import {
  ALL_ROLES,
  buildSystemPrompt,
  peerIdentity,
  roleCategory,
  roleIdentity,
} from "../src/orchestrator/roles";

describe("role identity mapping", () => {
  it("categorises every role", () => {
    expect(roleCategory("sd1")).toBe("sys-design");
    expect(roleCategory("sd2")).toBe("sys-design");
    expect(roleCategory("r1")).toBe("research");
    expect(roleCategory("r2")).toBe("research");
    expect(roleCategory("d1")).toBe("dev");
    expect(roleCategory("d2")).toBe("dev");
    expect(roleCategory("a1")).toBe("auditor");
    expect(roleCategory("a2")).toBe("auditor");
    expect(roleCategory("a3")).toBe("auditor");
  });

  it("identity strings A/B/1/2/3", () => {
    expect(roleIdentity("sd1")).toBe("A");
    expect(roleIdentity("sd2")).toBe("B");
    expect(roleIdentity("a1")).toBe("1");
    expect(roleIdentity("a3")).toBe("3");
  });

  it("peer identity", () => {
    expect(peerIdentity("sd1")).toBe("B");
    expect(peerIdentity("sd2")).toBe("A");
    expect(peerIdentity("a1")).toBe("—");
  });

  it("ALL_ROLES has 9 entries, all unique", () => {
    expect(ALL_ROLES).toHaveLength(9);
    expect(new Set(ALL_ROLES).size).toBe(9);
  });
});

describe("buildSystemPrompt", () => {
  it("embeds identity substitutions and the shared protocol", () => {
    const prompt = buildSystemPrompt({ role: "sd1" });
    expect(prompt).toContain("System Design Agent A");
    expect(prompt).toContain("System Design Agent B");
    expect(prompt).toContain("Phase protocol");
    expect(prompt).not.toContain("{{identity}}");
    expect(prompt).not.toContain("{{peer_identity}}");
  });

  it("research agent prompt mentions modes", () => {
    const prompt = buildSystemPrompt({ role: "r2" });
    expect(prompt).toContain("Research Agent B");
    expect(prompt).toContain("INDEPENDENT");
    expect(prompt).toContain("CROSS_EXAM");
  });

  it("auditor prompt has JSON output contract", () => {
    const prompt = buildSystemPrompt({ role: "a1" });
    expect(prompt).toContain("any-fail rule");
    expect(prompt).toContain("json");
    expect(prompt).toContain("verdict");
  });

  it("dev prompt restricts scope", () => {
    const prompt = buildSystemPrompt({ role: "d1" });
    expect(prompt).toContain("Development Agent A");
    expect(prompt).toContain("aspect workspace");
  });
});
