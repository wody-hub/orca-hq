import {
  type ControlStore,
  type WorktreeAcquireResult,
  type WorktreeHeartbeatResult,
  type WorktreeLease,
  type WorktreeReleaseResult
} from "@orca-hq/persistence";

export const WORKTREE_LEASE_DURATION_MS = 5 * 60 * 1_000;

export interface Clock {
  now(): Date;
}

export type WorktreeLeaseRequest = Omit<
  WorktreeLease,
  "acquiredAt" | "heartbeatAt" | "expiresAt"
>;

export interface WorktreeHeartbeatRequest {
  readonly lockKey: string;
  readonly dispatchId: string;
}

export interface WorktreeReleaseRequest {
  readonly lockKey: string;
  readonly dispatchId: string;
}

const systemClock: Clock = Object.freeze({
  now: () => new Date()
});

function authoritativeNow(clock: Clock): Date {
  const now = clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("clock must return a valid Date");
  }
  return new Date(now);
}

export class WorktreeLockService {
  constructor(
    private readonly store: ControlStore,
    private readonly clock: Clock = systemClock
  ) {}

  acquire(input: WorktreeLeaseRequest): WorktreeAcquireResult {
    const now = authoritativeNow(this.clock);
    const timestamp = now.toISOString();
    return this.store.acquireWorktreeLock({
      ...input,
      acquiredAt: timestamp,
      heartbeatAt: timestamp,
      expiresAt: new Date(now.getTime() + WORKTREE_LEASE_DURATION_MS).toISOString()
    });
  }

  heartbeat(input: WorktreeHeartbeatRequest): WorktreeHeartbeatResult {
    const now = authoritativeNow(this.clock);
    return this.store.heartbeatWorktreeLock({
      lockKey: input.lockKey,
      dispatchId: input.dispatchId,
      heartbeatAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + WORKTREE_LEASE_DURATION_MS).toISOString()
    });
  }

  release(input: WorktreeReleaseRequest): WorktreeReleaseResult {
    return this.store.releaseWorktreeLock({
      lockKey: input.lockKey,
      dispatchId: input.dispatchId,
      releasedAt: authoritativeNow(this.clock).toISOString()
    });
  }

  get(lockKey: string): WorktreeLease | undefined {
    return this.store.getWorktreeLock(lockKey);
  }
}

export type {
  WorktreeAcquireResult,
  WorktreeHeartbeatResult,
  WorktreeLease,
  WorktreeReleaseResult
} from "@orca-hq/persistence";
