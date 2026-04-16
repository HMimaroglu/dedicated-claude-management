import { describe, expect, it } from "vitest";
import { _buildClaudeArgsForTesting } from "../src/orchestrator/cli-adapter";

describe("cli-adapter argv construction", () => {
  it("includes --print + stream-json + the prompt last", () => {
    const args = _buildClaudeArgsForTesting({
      prompt: "hello",
      options: {},
    });
    expect(args[0]).toBe("--print");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args[args.length - 1]).toBe("hello");
  });

  it("threads model / system prompt / allowed tools / permission mode", () => {
    const args = _buildClaudeArgsForTesting({
      prompt: "do the thing",
      options: {
        model: "claude-sonnet-4-6",
        systemPrompt: "You are X",
        allowedTools: ["Read", "Glob"],
        permissionMode: "plan",
      },
    });
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-4-6");
    expect(args).toContain("--append-system-prompt");
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("You are X");
    expect(args).toContain("--allowed-tools");
    expect(args[args.indexOf("--allowed-tools") + 1]).toBe("Read,Glob");
    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("plan");
  });

  it("passes resume when supplied", () => {
    const args = _buildClaudeArgsForTesting({
      prompt: "continue",
      options: { resume: "sess-42" },
    });
    expect(args).toContain("--resume");
    expect(args[args.indexOf("--resume") + 1]).toBe("sess-42");
  });

  it("allowedTools: [] still emits the flag with an empty list", () => {
    const args = _buildClaudeArgsForTesting({
      prompt: "plan only",
      options: { allowedTools: [] },
    });
    expect(args).toContain("--allowed-tools");
    expect(args[args.indexOf("--allowed-tools") + 1]).toBe("");
  });

  it("omits --permission-mode when default", () => {
    const args = _buildClaudeArgsForTesting({
      prompt: "x",
      options: { permissionMode: "default" },
    });
    expect(args).not.toContain("--permission-mode");
  });
});
