export type WorktreeLease = Readonly<{
  lockKey: string;
  commandId: string;
  taskId: string;
  projectKey: string;
  worktreePath: string;
  branch: string;
  dispatchId: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}>;

export type WorktreeAcquireResult =
  | Readonly<{ kind: "acquired"; lease: WorktreeLease }>
  | Readonly<{ kind: "conflict"; lease: WorktreeLease }>
  | Readonly<{
      kind: "review_required";
      reason: "expired_lease_requires_reconciliation";
      lease: WorktreeLease;
    }>;

export type WorktreeHeartbeatResult =
  | Readonly<{ kind: "heartbeated"; lease: WorktreeLease }>
  | Readonly<{ kind: "conflict"; lease: WorktreeLease }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{
      kind: "review_required";
      reason: "expired_lease_requires_reconciliation" | "non_monotonic_heartbeat";
      lease: WorktreeLease;
    }>;

export type WorktreeReleaseResult =
  | Readonly<{ kind: "released" }>
  | Readonly<{ kind: "conflict"; lease: WorktreeLease }>
  | Readonly<{ kind: "not_found" }>;

export interface WorktreeLockStore {
  acquireWorktreeLock(lease: WorktreeLease): WorktreeAcquireResult;
  heartbeatWorktreeLock(input: Readonly<{
    lockKey: string;
    dispatchId: string;
    heartbeatAt: string;
    expiresAt: string;
  }>): WorktreeHeartbeatResult;
  releaseWorktreeLock(input: Readonly<{
    lockKey: string;
    dispatchId: string;
    releasedAt: string;
  }>): WorktreeReleaseResult;
  getWorktreeLock(lockKey: string): WorktreeLease | undefined;
}

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
    private readonly store: WorktreeLockStore,
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
