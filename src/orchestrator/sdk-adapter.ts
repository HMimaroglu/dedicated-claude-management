// Thin adapter around @anthropic-ai/claude-agent-sdk `query()`. The real
// implementation is swapped out for a mock in tests via setSdkQueryForTesting.
// Only this file imports the SDK; everything else consumes the narrow
// `runAgent` function in session.ts.

import { query as realQuery } from "@anthropic-ai/claude-agent-sdk";

export type SdkQueryFn = typeof realQuery;

let _queryImpl: SdkQueryFn = realQuery;

export function getSdkQuery(): SdkQueryFn {
  return _queryImpl;
}

// Test hook — pass null to restore the real SDK.
export function setSdkQueryForTesting(fn: SdkQueryFn | null): void {
  _queryImpl = fn ?? realQuery;
}
