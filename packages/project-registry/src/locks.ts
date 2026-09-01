import {
  type ControlStore,
  type WorktreeAcquireResult,
  type WorktreeHeartbeat,
  type WorktreeHeartbeatResult,
  type WorktreeLease,
  type WorktreeRelease,
  type WorktreeReleaseResult
} from "@orca-hq/persistence";

export class WorktreeLockService {
  constructor(private readonly store: ControlStore) {}

  acquire(lease: WorktreeLease): WorktreeAcquireResult {
    return this.store.acquireWorktreeLock(lease);
  }

  heartbeat(input: WorktreeHeartbeat): WorktreeHeartbeatResult {
    return this.store.heartbeatWorktreeLock(input);
  }

  release(input: WorktreeRelease): WorktreeReleaseResult {
    return this.store.releaseWorktreeLock(input);
  }

  get(lockKey: string): WorktreeLease | undefined {
    return this.store.getWorktreeLock(lockKey);
  }
}

export type {
  WorktreeAcquireResult,
  WorktreeHeartbeat,
  WorktreeHeartbeatResult,
  WorktreeLease,
  WorktreeRelease,
  WorktreeReleaseResult
} from "@orca-hq/persistence";
