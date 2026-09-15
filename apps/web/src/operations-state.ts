import type { HqQuestion, HqQuestionPage, OperationsApi, OperationsMutationReceipt } from "./api.js";

export type MutationRegistryEntry = Readonly<{
  requestId: string;
  state: "reserved" | "pending" | "settled";
  receipt?: OperationsMutationReceipt;
}>;

export function mutationIdentity(action: string, targetId: string): string {
  return JSON.stringify([action, targetId]);
}

/** Session-scoped ambiguity fence. Unknown and in-flight entries are never evicted. */
export class OperationsMutationRegistry {
  private readonly entries = new Map<string, MutationRegistryEntry>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly limit = 128) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get = (key: string): MutationRegistryEntry | undefined => this.entries.get(key);

  reserve(key: string): MutationRegistryEntry | undefined {
    const existing = this.entries.get(key);
    if (existing) return existing;
    if (this.entries.size >= this.limit) {
      for (const [candidate, entry] of this.entries) {
        if (entry.receipt && entry.receipt.state !== "unknown") {
          this.entries.delete(candidate);
          break;
        }
      }
    }
    if (this.entries.size >= this.limit) return undefined;
    const entry = { requestId: `request_${crypto.randomUUID()}`, state: "reserved" as const };
    this.entries.set(key, entry);
    this.emit();
    return entry;
  }

  pending(key: string): MutationRegistryEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry || entry.receipt) return entry;
    const next = { ...entry, state: "pending" as const };
    this.entries.set(key, next);
    this.emit();
    return next;
  }

  settle(key: string, receipt: OperationsMutationReceipt): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    const safeReceipt = receipt.requestId === entry.requestId ? receipt : {
      requestId: entry.requestId,
      action: receipt.action,
      targetId: receipt.targetId,
      state: "unknown" as const,
      observedAt: new Date().toISOString(),
      detail: "receipt_identity_mismatch",
    };
    this.entries.set(key, { requestId: entry.requestId, state: "settled", receipt: safeReceipt });
    this.emit();
  }

  clearResolved(key: string): void {
    const entry = this.entries.get(key);
    if (!entry || entry.state === "pending" || entry.receipt?.state === "unknown") return;
    this.entries.delete(key);
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export interface HqQuestionSnapshot extends HqQuestionPage {
  coverage: { complete: boolean; requests: number; reason?: "bounded_scan" | "compacted_or_changed" };
}

const MAX_QUESTION_REQUESTS = 10;

async function scanQuestions(api: OperationsApi, signal: AbortSignal, budget: number) {
  let cursor = "0", compacted = false, requests = 0, complete = false;
  const questions = new Map<string, HqQuestion>();
  while (requests < budget) {
    signal.throwIfAborted();
    const page = await api.hqQuestions(cursor, signal);
    requests++;
    compacted ||= page.compacted;
    for (const question of page.questions)
      questions.set(`${question.requestId}:${question.messageId ?? ""}`, question);
    if (page.cursor === cursor) { complete = true; break; }
    cursor = page.cursor;
  }
  return { cursor, compacted, requests, complete, questions: [...questions.values()] };
}

/** Two stable bounded passes make the second pass a current-state reconciliation, not an append-only history. */
export async function loadCurrentHqQuestions(api: OperationsApi, signal: AbortSignal): Promise<HqQuestionSnapshot> {
  const first = await scanQuestions(api, signal, MAX_QUESTION_REQUESTS / 2);
  if (!first.complete) return { source: "hq", questions: first.questions, cursor: first.cursor, compacted: first.compacted, coverage: { complete: false, requests: first.requests, reason: "bounded_scan" } };
  const second = await scanQuestions(api, signal, MAX_QUESTION_REQUESTS - first.requests);
  const complete = second.complete && second.cursor === first.cursor && !first.compacted && !second.compacted;
  return {
    source: "hq",
    questions: second.questions,
    cursor: second.cursor,
    compacted: first.compacted || second.compacted,
    coverage: {
      complete,
      requests: first.requests + second.requests,
      ...(complete ? {} : { reason: second.complete ? "compacted_or_changed" as const : "bounded_scan" as const }),
    },
  };
}
