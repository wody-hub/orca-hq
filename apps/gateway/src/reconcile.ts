export type ReconcileDispatch = Readonly<{
  dispatchId: string;
  /** Durable Orca receipt used to recover this exact Dispatch identity. */
  receipt: unknown;
}>;

export type OrcaDispatchInspection = Readonly<
  | { kind: "running" | "active" | "resumable"; receipt?: unknown }
  | { kind: "completed" | "worker_done" | "released" | "stopped"; receipt?: unknown }
  | { kind: "unknown" | "missing" | "inconsistent"; receipt?: unknown }
>;

export type ReconcileResult = Readonly<
  | { dispatchId: string; state: "resumable"; receipt?: unknown }
  | { dispatchId: string; state: "completed"; receipt?: unknown }
  | { dispatchId: string; state: "review_required" }
>;

export type ReconcileReport = readonly ReconcileResult[];

export interface ReconcilePorts {
  readonly store: Readonly<{
    recoverOutboxClaims(): Promise<void> | void;
    listNonterminalDispatches(): Promise<readonly ReconcileDispatch[]> | readonly ReconcileDispatch[];
  }>;
  readonly channels: Readonly<{
    resumeCursors(): Promise<void> | void;
  }>;
  readonly orca: Readonly<{
    inspectMany?: ((receipts: readonly unknown[]) => Promise<readonly OrcaDispatchInspection[]>) | undefined;
    inspectDispatch?: ((receipt: unknown) => Promise<OrcaDispatchInspection>) | undefined;
    /** Included to make the prohibited broad action explicit. Reconciliation never calls it. */
    releaseWorker?: ((dispatchId: string) => Promise<unknown>) | undefined;
  }>;
  readonly locks?: Readonly<{
    reviewExpired(report: ReconcileReport): Promise<void> | void;
  }> | undefined;
  readonly outbox?: Readonly<{
    drain(): Promise<void> | void;
  }> | undefined;
}

function classify(
  dispatch: ReconcileDispatch,
  inspection: OrcaDispatchInspection | undefined
): ReconcileResult {
  if (
    inspection?.kind === "running"
    || inspection?.kind === "active"
    || inspection?.kind === "resumable"
  ) {
    return Object.freeze({
      dispatchId: dispatch.dispatchId,
      state: "resumable" as const,
      ...(inspection.receipt === undefined ? {} : { receipt: inspection.receipt })
    });
  }
  if (
    inspection?.kind === "completed"
    || inspection?.kind === "worker_done"
    || inspection?.kind === "released"
    || inspection?.kind === "stopped"
  ) {
    return Object.freeze({
      dispatchId: dispatch.dispatchId,
      state: "completed" as const,
      ...(inspection.receipt === undefined ? {} : { receipt: inspection.receipt })
    });
  }
  return Object.freeze({ dispatchId: dispatch.dispatchId, state: "review_required" as const });
}

async function inspect(
  ports: ReconcilePorts,
  dispatches: readonly ReconcileDispatch[]
): Promise<readonly (OrcaDispatchInspection | undefined)[]> {
  try {
    if (ports.orca.inspectMany !== undefined) {
      const inspections = await ports.orca.inspectMany(dispatches.map(({ receipt }) => receipt));
      return dispatches.map((_, index) => inspections[index]);
    }
    if (ports.orca.inspectDispatch !== undefined) {
      return await Promise.all(dispatches.map(async ({ receipt }) => {
        try {
          return await ports.orca.inspectDispatch?.(receipt);
        } catch {
          return undefined;
        }
      }));
    }
  } catch {
    // A batch inspection failure makes every affected identity uncertain. It
    // never grants authority to close, delete, stop, or release anything.
  }
  return dispatches.map(() => undefined);
}

/** Performs local recovery before classifying each exact durable Orca receipt. */
export async function reconcileStartup(ports: ReconcilePorts): Promise<ReconcileReport> {
  await ports.store.recoverOutboxClaims();
  await ports.channels.resumeCursors();
  const dispatches = await ports.store.listNonterminalDispatches();
  const inspections = await inspect(ports, dispatches);
  const report = Object.freeze(dispatches.map((dispatch, index) =>
    classify(dispatch, inspections[index])
  ));
  await ports.locks?.reviewExpired(report);
  await ports.outbox?.drain();
  return report;
}

export function createStartupReconciler(ports: ReconcilePorts): Readonly<{
  run(): Promise<ReconcileReport>;
}> {
  return Object.freeze({ run: () => reconcileStartup(ports) });
}
