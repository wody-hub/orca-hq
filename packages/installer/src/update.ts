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

export type UpdateFailureStage =
  | "install_revision"
  | "preflight"
  | "second_active_work_check"
  | "stop_gateway"
  | "backup"
  | "migration"
  | "start_gateway"
  | "doctor";

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
  readonly backup?: BackupReceipt;
  readonly rollbackComplete: boolean;
  readonly stage: UpdateFailureStage;
  override readonly cause: unknown;

  constructor(input: Readonly<{
    backup?: BackupReceipt;
    rollbackComplete: boolean;
    stage: UpdateFailureStage;
    cause: unknown;
  }>) {
    super(input.rollbackComplete
      ? "Update failed and the previous revision was restored."
      : "Update failed and rollback requires operator review.", { cause: input.cause });
    this.name = "UpdateFailedError";
    if (input.backup !== undefined) this.backup = input.backup;
    this.rollbackComplete = input.rollbackComplete;
    this.stage = input.stage;
    this.cause = input.cause;
  }
}

const backupOptions: BackupCreateOptions = Object.freeze({ includeConfig: true, includeSecrets: false });
const restoreOptions: BackupRestoreOptions = Object.freeze({ includeConfig: true, includeSecrets: false });

function activeOrUncertain(status: GatewayUpdateStatus): number | undefined {
  const aggregate = status.activeOrUncertainDispatches;
  const componentCount = Number.isSafeInteger(status.nonterminalDispatches)
    && status.nonterminalDispatches! >= 0
    && Number.isSafeInteger(status.uncertainDispatches ?? 0)
    && (status.uncertainDispatches ?? 0) >= 0
    ? status.nonterminalDispatches! + (status.uncertainDispatches ?? 0)
    : undefined;
  if (aggregate !== undefined) {
    if (!Number.isSafeInteger(aggregate) || aggregate < 0) return undefined;
    if ((status.nonterminalDispatches !== undefined || status.uncertainDispatches !== undefined)
      && componentCount !== aggregate) return undefined;
    return aggregate;
  }
  return componentCount;
}

export async function assertNoActiveWork(context: Readonly<{
  gateway: Readonly<{ status(): Promise<GatewayUpdateStatus> }>;
}>): Promise<void> {
  let status: GatewayUpdateStatus;
  try {
    status = await context.gateway.status();
  } catch {
    throw new UpdateBlockedError("active_work");
  }
  const count = activeOrUncertain(status);
  // An unparseable status is itself uncertain and must fail closed.
  if (count === undefined || count > 0) throw new UpdateBlockedError("active_work");
}

/** Low-level update gate matching the stop-then-backup maintenance contract. */
export async function prepareUpdate(
  context: Pick<UpdateContext, "gateway" | "backups">
): Promise<BackupReceipt> {
  return prepareUpdateWithStage(context, () => undefined);
}

async function prepareUpdateWithStage(
  context: Pick<UpdateContext, "gateway" | "backups">,
  setStage: (stage: "second_active_work_check" | "stop_gateway" | "backup") => void
): Promise<BackupReceipt> {
  setStage("second_active_work_check");
  await assertNoActiveWork(context);
  setStage("stop_gateway");
  await context.gateway.stop();
  setStage("backup");
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

async function rollbackProgram(
  context: UpdateContext,
  previousRevision: string,
  restartGateway: boolean
): Promise<boolean> {
  let complete = true;
  try {
    await context.source.restoreRevision(previousRevision);
  } catch {
    complete = false;
  }
  if (restartGateway) {
    try {
      await context.gateway.start();
    } catch {
      complete = false;
    }
  }
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
      let stage: UpdateFailureStage = "install_revision";
      let backup: BackupReceipt | undefined;
      let gatewayStopped = false;
      try {
        await context.source.installRevision({ revision, frozenLockfile: true });
        stage = "preflight";
        const preflight = await context.preflight.run({ readOnly: true });
        if (preflight?.ok !== true) throw new UpdateBlockedError("preflight_failed");

        backup = await prepareUpdateWithStage(context, (nextStage) => {
          stage = nextStage;
          if (nextStage === "backup") gatewayStopped = true;
        });
        stage = "migration";
        await context.migrations.run({ fromRevision: previousRevision, toRevision: revision, backup });
        stage = "start_gateway";
        await context.gateway.start();
        gatewayStopped = false;
        stage = "doctor";
        const diagnosis = await context.doctor.run({ format: "json" });
        if (diagnosis?.ok !== true) throw new Error("doctor_failed");
        return Object.freeze({ previousRevision, revision, backup });
      } catch (cause) {
        const rollbackComplete = backup === undefined
          ? await rollbackProgram(context, previousRevision, gatewayStopped)
          : await rollback(context, previousRevision, backup);
        throw new UpdateFailedError({
          ...(backup === undefined ? {} : { backup }),
          rollbackComplete,
          stage,
          cause
        });
      }
    }
  });
}
