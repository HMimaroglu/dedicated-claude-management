// Per-workflow in-memory mutex. Prevents two concurrent "advance" calls on
// the same workflow — crucial because each advance mutates DB state and runs
// SDK sessions. This is single-process only; a future multi-node deployment
// would need a DB-backed lease.

const inFlight = new Set<number>();

export function tryAcquire(workflow_id: number): boolean {
  if (inFlight.has(workflow_id)) return false;
  inFlight.add(workflow_id);
  return true;
}

export function release(workflow_id: number): void {
  inFlight.delete(workflow_id);
}

export function isInFlight(workflow_id: number): boolean {
  return inFlight.has(workflow_id);
}

// Test helper
export function _clearAllForTests(): void {
  inFlight.clear();
}
