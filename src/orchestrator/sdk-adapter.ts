// Adapter around the "run one turn of a Claude agent" primitive.
// Implementation: drives the local `claude` CLI (`claude --print
// --output-format stream-json`) so auth uses the operator's existing
// Claude Code sign-in — no ANTHROPIC_API_KEY required.
//
// Tests replace this with a fixture stream via setSdkQueryForTesting.
// File name retained from when this wrapped the Agent SDK; the public
// surface (SdkQueryFn, getSdkQuery, setSdkQueryForTesting) is what every
// caller consumes.

import { claudeCliQuery, type CliQueryOptions, type StreamMessage } from "./cli-adapter";

export type SdkQueryFn = (args: CliQueryOptions) => AsyncIterable<StreamMessage>;

const defaultImpl: SdkQueryFn = (args) => claudeCliQuery(args);

let _queryImpl: SdkQueryFn = defaultImpl;

export function getSdkQuery(): SdkQueryFn {
  return _queryImpl;
}

// Test hook — pass null to restore the CLI-backed implementation.
export function setSdkQueryForTesting(fn: SdkQueryFn | null): void {
  _queryImpl = fn ?? defaultImpl;
}
