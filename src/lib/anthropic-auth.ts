// Centralises detection of the Anthropic API credential the Claude Agent SDK
// needs. The SDK itself reads ANTHROPIC_API_KEY directly; this module just
// reports whether the env is configured and (optionally in future) supports
// Bedrock/Vertex overrides.

export interface AnthropicAuthStatus {
  configured: boolean;
  provider: "anthropic" | "bedrock" | "vertex" | "foundry" | "none";
}

export function anthropicAuthStatus(): AnthropicAuthStatus {
  if (process.env.CLAUDE_CODE_USE_BEDROCK === "1") return { configured: true, provider: "bedrock" };
  if (process.env.CLAUDE_CODE_USE_VERTEX === "1") return { configured: true, provider: "vertex" };
  if (process.env.CLAUDE_CODE_USE_FOUNDRY === "1") return { configured: true, provider: "foundry" };
  if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.length > 0) {
    return { configured: true, provider: "anthropic" };
  }
  return { configured: false, provider: "none" };
}

// Do NOT log or surface the key itself. Only expose its presence.
