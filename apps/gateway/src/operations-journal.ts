import { createHash } from "node:crypto";
import { z } from "zod";
import {
  OperationsMutationReceiptSchema,
  type OperationsMutationReceipt,
} from "@orca-hq/core";
import type { openDatabase } from "@orca-hq/persistence";

type Database = ReturnType<typeof openDatabase>;
type Intent = {
  requestId: string;
  action: string;
  targetId: string;
  input: unknown;
};
type Result = Pick<OperationsMutationReceipt, "state" | "detail">;
const Identity = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_.:/-]+$/);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
/** One owner per managed DB; durable intent precedes every effect, including authorization reads. */
export class OperationsJournal {
  private serial: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly db: Database,
    private readonly now = () => new Date(),
  ) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS operations_mutation_receipts(request_id TEXT PRIMARY KEY,action TEXT NOT NULL,target_id TEXT NOT NULL,input_digest TEXT NOT NULL,state TEXT NOT NULL,detail TEXT,observed_at TEXT NOT NULL)`,
    );
    db.prepare(
      "UPDATE operations_mutation_receipts SET state='unknown',detail='interrupted' WHERE state='prepared'",
    ).run();
  }
  execute(
    intent: Intent,
    effect: () => Promise<Result>,
  ): Promise<OperationsMutationReceipt> {
    Identity.parse(intent.requestId);
    Identity.parse(intent.action);
    Identity.parse(intent.targetId);
    const digest = createHash("sha256")
      .update(canonical(intent.input))
      .digest("hex");
    const operation = this.serial.then(async () => {
      const row = this.db
        .prepare(
          "SELECT * FROM operations_mutation_receipts WHERE request_id=?",
        )
        .get(intent.requestId) as
        | {
            action: string;
            target_id: string;
            input_digest: string;
            state: string;
            detail: string | null;
            observed_at: string;
          }
        | undefined;
      const receipt = (state: string, observedAt: string, detail?: string) =>
        OperationsMutationReceiptSchema.parse({
          requestId: intent.requestId,
          action: intent.action,
          targetId: intent.targetId,
          state,
          observedAt,
          ...(detail ? { detail } : {}),
        });
      if (row) {
        if (
          row.action !== intent.action ||
          row.target_id !== intent.targetId ||
          row.input_digest !== digest
        )
          throw Error("idempotency_conflict");
        return receipt(
          row.state === "prepared" ? "unknown" : row.state,
          row.observed_at,
          row.detail ?? undefined,
        );
      }
      this.db
        .prepare(
          "INSERT INTO operations_mutation_receipts VALUES(?,?,?,?,'prepared',NULL,?)",
        )
        .run(
          intent.requestId,
          intent.action,
          intent.targetId,
          digest,
          this.now().toISOString(),
        );
      let result: OperationsMutationReceipt;
      try {
        const outcome = await effect();
        // Audit details are machine codes only: never bodies, command output, or exception text.
        result = receipt(
          outcome.state,
          this.now().toISOString(),
          outcome.detail && /^[a-z0-9_:-]{1,128}$/.test(outcome.detail)
            ? outcome.detail
            : undefined,
        );
      } catch {
        result = receipt(
          "unknown",
          this.now().toISOString(),
          "effect_unverifiable",
        );
      }
      this.db
        .prepare(
          "UPDATE operations_mutation_receipts SET state=?,detail=?,observed_at=? WHERE request_id=?",
        )
        .run(
          result.state,
          result.detail ?? null,
          result.observedAt,
          intent.requestId,
        );
      return result;
    });
    this.serial = operation.catch(() => {});
    return operation;
  }
  async idle(): Promise<void> {
    await this.serial;
  }
}
