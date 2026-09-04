export type ReconcileDispatch = Readonly<{
  dispatchId: string;
  /** Safe durable identifier retained in diagnostics without provider payloads. */
  receiptId: string;
  /** Durable Orca receipt used to recover this exact Dispatch identity. */
  receipt: unknown;
}>;

export type OrcaDispatchInspection = Readonly<
  | { kind: "running" | "active" | "resumable"; receipt?: unknown }
  | { kind: "completed" | "worker_done" | "released" | "stopped"; receipt?: unknown }
  | { kind: "unknown" | "missing" | "inconsistent"; receipt?: unknown }
>;

export type ReconcileResult = Readonly<
  | { dispatchId: string; state: "resumable"; receiptId: string }
  | { dispatchId: string; state: "completed"; receiptId: string }
  | { dispatchId: string; state: "review_required"; receiptId: string }
>;

export type ReconcileReport = readonly ReconcileResult[];

type InspectManyPort = Readonly<{
  inspectMany(receipts: readonly unknown[]): Promise<readonly OrcaDispatchInspection[]>;
  inspectDispatch?: never;
}>;

type InspectDispatchPort = Readonly<{
  inspectDispatch(receipt: unknown): Promise<OrcaDispatchInspection>;
  inspectMany?: never;
}>;

export type ReconcileAuditEvent = Readonly<
  | { kind: "inspection_failed" | "inspection_missing"; dispatchId: string; receiptId: string }
  | { kind: "classified"; dispatchId: string; receiptId: string; state: ReconcileResult["state"] }
>;

export interface ReconcilePorts {
  readonly store: Readonly<{
    recoverOutboxClaims(): Promise<void> | void;
    listNonterminalDispatches(): Promise<readonly ReconcileDispatch[]> | readonly ReconcileDispatch[];
  }>;
  readonly channels: Readonly<{
    resumeCursors(): Promise<void> | void;
  }>;
  /** At least one exact inspection strategy is required by construction. */
  readonly orca: InspectManyPort | InspectDispatchPort;
  readonly locks: Readonly<{
    reviewExpired(report: ReconcileReport): Promise<void> | void;
  }>;
  readonly outbox: Readonly<{
    drain(): Promise<void> | void;
  }>;
  readonly audit: Readonly<{
    record(event: ReconcileAuditEvent): Promise<void> | void;
  }>;
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
      receiptId: dispatch.receiptId
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
      receiptId: dispatch.receiptId
    });
  }
  return Object.freeze({
    dispatchId: dispatch.dispatchId,
    state: "review_required" as const,
    receiptId: dispatch.receiptId
  });
}

async function inspect(
  ports: ReconcilePorts,
  dispatches: readonly ReconcileDispatch[]
): Promise<readonly (OrcaDispatchInspection | undefined)[]> {
  if (ports.orca.inspectMany !== undefined) {
    try {
      const inspections = await ports.orca.inspectMany(dispatches.map(({ receipt }) => receipt));
      for (let index = inspections.length; index < dispatches.length; index += 1) {
        const dispatch = dispatches[index];
        if (dispatch !== undefined) {
          await ports.audit.record({
            kind: "inspection_missing",
            dispatchId: dispatch.dispatchId,
            receiptId: dispatch.receiptId
          });
        }
      }
      return dispatches.map((_, index) => inspections[index]);
    } catch {
      for (const dispatch of dispatches) {
        await ports.audit.record({
          kind: "inspection_failed",
          dispatchId: dispatch.dispatchId,
          receiptId: dispatch.receiptId
        });
      }
      return dispatches.map(() => undefined);
    }
  }
  const inspectDispatch = ports.orca.inspectDispatch;
  return await Promise.all(dispatches.map(async (dispatch) => {
    try {
      return await inspectDispatch(dispatch.receipt);
    } catch {
      await ports.audit.record({
        kind: "inspection_failed",
        dispatchId: dispatch.dispatchId,
        receiptId: dispatch.receiptId
      });
      return undefined;
    }
  }));
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
  for (const result of report) {
    await ports.audit.record({
      kind: "classified",
      dispatchId: result.dispatchId,
      receiptId: result.receiptId,
      state: result.state
    });
  }
  await ports.locks.reviewExpired(report);
  await ports.outbox.drain();
  return report;
}

export function createStartupReconciler(ports: ReconcilePorts): Readonly<{
  run(): Promise<ReconcileReport>;
}> {
  return Object.freeze({ run: () => reconcileStartup(ports) });
}
