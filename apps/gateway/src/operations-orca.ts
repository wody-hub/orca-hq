import { z } from "zod";
import {
  runOrca,
  operationArguments,
  parseOrcaOperation,
  parseOrcaOperationsReceipt,
  parseOrcaReceipt,
  assertSuccessfulReceipt,
  type OrcaOperation,
  type OrcaOperationsReceiptKind,
} from "@orca-hq/orca-adapter";

type Operation = Extract<OrcaOperation, { kind: OrcaOperationsReceiptKind }>;
export interface OperationsOrcaPort {
  execute(operation: Operation): Promise<unknown>;
}
/** Public process boundary: no ambient terminal/env authority and four bounded concurrent reads. */
export class OperationsOrca implements OperationsOrcaPort {
  private active = 0;
  private waiting: Array<() => void> = [];
  constructor(
    private readonly options: {
      executablePath: string;
      signal: AbortSignal;
      run?: typeof runOrca;
    },
  ) {}
  async execute(input: Operation): Promise<unknown> {
    const op = parseOrcaOperation(input);
    if (this.active >= 4) await new Promise<void>((r) => this.waiting.push(r));
    else this.active++;
    try {
      const control = [
        "operations_dispatch",
        "operations_reply",
        "operations_send",
        "operations_stop",
        "operations_retain",
        "operations_release",
      ].includes(op.kind);
      const raw = await (this.options.run ?? runOrca)(operationArguments(op), {
        executablePath: this.options.executablePath,
        signal: this.options.signal,
        timeoutMs: control ? 75000 : 10000,
        terminationGraceMs: 250,
        maxOutputBytes: 2097152,
        connectionTarget: { kind: "local" },
      });
      if (Buffer.byteLength(JSON.stringify(raw)) > 2097152)
        throw Error("output_overflow");
      const base = parseOrcaReceipt(raw);
      assertSuccessfulReceipt(base);
      const parsed = parseOrcaOperationsReceipt(input.kind, base);
      const result = z.record(z.unknown()).parse(parsed.result);
      const same = (a: unknown, b: unknown) => {
        if (a !== b) throw Error("receipt_identity_mismatch");
      };
      if ("dispatchId" in op && result.dispatchId !== undefined)
        same(result.dispatchId, op.dispatchId);
      if (op.kind === "operations_show_worker") {
        for (const key of ["dispatch", "worker", "projection"]) {
          const row = z.record(z.unknown()).parse(result[key]);
          same(key === "dispatch" ? row.id : row.dispatchId, op.dispatchId);
        }
      }
      if (op.kind === "operations_dispatch") {
        same(result.taskId, op.taskId);
        if (op.runId) same(result.runId, op.runId);
      }
      if (op.kind === "operations_reply") {
        const m = z.record(z.unknown()).parse(result.message);
        same(m.thread_id, op.messageId);
        if (result.question) {
          const q = z.record(z.unknown()).parse(result.question);
          same(q.message_id, op.messageId);
          same(q.answer_message_id, m.id);
        }
      }
      if (op.kind === "operations_send")
        same(
          z.record(z.unknown()).parse(result.message).to_handle,
          `dispatch:${op.dispatchId}`,
        );
      if ("retryRequestId" in op && result.mutation !== undefined)
        same(
          z.record(z.unknown()).parse(result.mutation).requestId,
          op.retryRequestId,
        );
      if (op.kind === "operations_worker_read" && result.source !== op.source)
        throw Error("source_changed");
      return parsed;
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
