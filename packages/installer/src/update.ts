import type {
  BackupCreateOptions,
  BackupOperations,
  BackupReceipt,
  BackupRestoreOptions
} from "./backup.js";

export interface GatewayUpdateStatus {
  readonly activeOrUncertainDispatches?: number;
  readonly nonterminalDispatches?: number;
  readonly uncertainDispatches?: number;
}

export interface UpdateContext {
  readonly targetRevision?: string;
  readonly gateway: Readonly<{
    status(): Promise<GatewayUpdateStatus>;
    stop(): Promise<void>;
    start(): Promise<void>;
  }>;
  readonly source: Readonly<{
    currentRevision(): Promise<string>;
    verifyRevision(revision: string): Promise<boolean>;
    installRevision(options: Readonly<{ revision: string; frozenLockfile: true }>): Promise<void>;
    restoreRevision(revision: string): Promise<void>;
  }>;
  readonly preflight: Readonly<{
    run(options: Readonly<{ readOnly: true }>): Promise<Readonly<{ ok: boolean }>>;
  }>;
  readonly backups: Pick<BackupOperations, "createOnlineBackup" | "restore">;
  readonly migrations: Readonly<{
    run(input: Readonly<{
      fromRevision: string;
      toRevision: string;
      backup: BackupReceipt;
    }>): Promise<void>;
  }>;
  readonly doctor: Readonly<{
    run(options: Readonly<{ format: "json" }>): Promise<Readonly<{ ok: boolean }>>;
  }>;
}

export interface UpdateResult {
  readonly previousRevision: string;
  readonly revision: string;
  readonly backup: BackupReceipt;
}

export class UpdateBlockedError extends Error {
  readonly code: "active_work" | "revision_mismatch" | "preflight_failed";

  constructor(code: UpdateBlockedError["code"]) {
    super(code === "active_work"
      ? "Update refused because active or uncertain work exists."
      : code === "revision_mismatch"
        ? "The requested update revision could not be verified."
        : "The read-only update preflight failed.");
    this.name = "UpdateBlockedError";
    this.code = code;
  }
}

export class UpdateFailedError extends Error {
  readonly code = "update_failed" as const;
  readonly backup: BackupReceipt;
  readonly rollbackComplete: boolean;

  constructor(backup: BackupReceipt, rollbackComplete: boolean) {
    super(rollbackComplete
      ? "Update failed and the previous revision was restored."
      : "Update failed and rollback requires operator review.");
    this.name = "UpdateFailedError";
    this.backup = backup;
    this.rollbackComplete = rollbackComplete;
  }
}

const backupOptions: BackupCreateOptions = Object.freeze({ includeConfig: true, includeSecrets: false });
const restoreOptions: BackupRestoreOptions = Object.freeze({ includeConfig: true, includeSecrets: false });

function activeOrUncertain(status: GatewayUpdateStatus): number | undefined {
  if (Number.isSafeInteger(status.activeOrUncertainDispatches)
    && status.activeOrUncertainDispatches! >= 0) {
    return status.activeOrUncertainDispatches;
  }
  if (Number.isSafeInteger(status.nonterminalDispatches)
    && status.nonterminalDispatches! >= 0
    && Number.isSafeInteger(status.uncertainDispatches ?? 0)
    && (status.uncertainDispatches ?? 0) >= 0) {
    return status.nonterminalDispatches! + (status.uncertainDispatches ?? 0);
  }
  return undefined;
}

async function assertNoActiveWork(context: Pick<UpdateContext, "gateway">): Promise<void> {
  const count = activeOrUncertain(await context.gateway.status());
  // An unparseable status is itself uncertain and must fail closed.
  if (count === undefined || count > 0) throw new UpdateBlockedError("active_work");
}

/** Low-level update gate matching the stop-then-backup maintenance contract. */
export async function prepareUpdate(
  context: Pick<UpdateContext, "gateway" | "backups">
): Promise<BackupReceipt> {
  await assertNoActiveWork(context);
  await context.gateway.stop();
  return context.backups.createOnlineBackup(backupOptions);
}

async function rollback(
  context: UpdateContext,
  previousRevision: string,
  backup: BackupReceipt
): Promise<boolean> {
  let complete = true;
  const attempt = async (operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch {
      complete = false;
    }
  };
  await attempt(async () => context.gateway.stop());
  await attempt(async () => context.source.restoreRevision(previousRevision));
  await attempt(async () => context.backups.restore(backup, restoreOptions));
  await attempt(async () => context.gateway.start());
  return complete;
}

/** Runs a fail-closed source update and restores the prior durable state on post-backup failure. */
export function createUpdate(context: UpdateContext): Readonly<{
  run(options?: Readonly<{ revision?: string }>): Promise<UpdateResult>;
}> {
  return Object.freeze({
    async run(options = {}): Promise<UpdateResult> {
      await assertNoActiveWork(context);
      const revision = options.revision ?? context.targetRevision;
      if (revision === undefined || revision.length === 0) throw new UpdateBlockedError("revision_mismatch");

      const previousRevision = await context.source.currentRevision();
      const verified = await context.source.verifyRevision(revision);
      if (verified !== true) throw new UpdateBlockedError("revision_mismatch");
      await context.source.installRevision({ revision, frozenLockfile: true });
      const preflight = await context.preflight.run({ readOnly: true });
      if (preflight?.ok !== true) throw new UpdateBlockedError("preflight_failed");

      const backup = await context.backups.createOnlineBackup(backupOptions);
      // Recheck after the online backup and immediately before entering maintenance.
      await assertNoActiveWork(context);
      await context.gateway.stop();
      try {
        await context.migrations.run({ fromRevision: previousRevision, toRevision: revision, backup });
        await context.gateway.start();
        const diagnosis = await context.doctor.run({ format: "json" });
        if (!diagnosis.ok) throw new Error("doctor_failed");
        return Object.freeze({ previousRevision, revision, backup });
      } catch {
        throw new UpdateFailedError(backup, await rollback(context, previousRevision, backup));
      }
    }
  });
}
