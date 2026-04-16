import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { anthropicAuthStatus } from "../src/lib/anthropic-auth";

const keys = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

function clear() {
  for (const k of keys) delete process.env[k];
}

let backup: Record<string, string | undefined>;

beforeEach(() => {
  backup = {};
  for (const k of keys) backup[k] = process.env[k];
  clear();
});
afterEach(() => {
  clear();
  for (const k of keys) if (backup[k] !== undefined) process.env[k] = backup[k]!;
});

describe("anthropicAuthStatus", () => {
  it("reports none when nothing is set", () => {
    expect(anthropicAuthStatus()).toEqual({ configured: false, provider: "none" });
  });
  it("reports anthropic when API key is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-x";
    expect(anthropicAuthStatus()).toEqual({ configured: true, provider: "anthropic" });
  });
  it("reports bedrock when flag set", () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    expect(anthropicAuthStatus().provider).toBe("bedrock");
  });
  it("bedrock flag takes precedence over api key", () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    process.env.ANTHROPIC_API_KEY = "sk-ant-x";
    expect(anthropicAuthStatus().provider).toBe("bedrock");
  });
  it("empty ANTHROPIC_API_KEY is treated as unset", () => {
    process.env.ANTHROPIC_API_KEY = "";
    expect(anthropicAuthStatus().configured).toBe(false);
  });
});
