import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  ApprovalConfirmationSchema,
  ApprovalRequestInputSchema,
  ApprovalRequestSchema,
  ApprovalValidationInputSchema,
  PersistedApprovalRequestSchema,
  type ApprovalDecision,
  type ApprovalPrincipal,
  type ApprovalRequest,
  type ApprovalRequestInput,
  type ApprovalStore,
  type ApprovalValidationInput
} from "./approval.js";
import { approvalOperationDigest, proposalDigest } from "./digest.js";
import { PrincipalBindingSchema } from "./identity.js";
import { classifyRisk } from "./policy.js";

const APPROVAL_WINDOW_MS = 15 * 60 * 1_000;
const SHA_256 = /^[a-f0-9]{64}$/;

function freeze<T>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function decision<T extends ApprovalDecision>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function phraseFor(operation: string, operationDigest: string): string {
  const normalizedOperation = operation.trim().replace(/[\s-]+/g, "_").toUpperCase();
  return `APPROVE ${normalizedOperation} ${operationDigest.slice(0, 12).toUpperCase()}`;
}

function digestPhrase(phrase: string): string {
  return createHash("sha256").update(phrase).digest("hex");
}

function timeOf(now: Date): number {
  const time = now.getTime();
  if (!Number.isFinite(time)) throw new TypeError("approval time must be a valid Date");
  return time;
}

function currentDigest(value: string | ApprovalValidationInput): string {
  if (typeof value === "string") {
    if (!SHA_256.test(value)) throw new TypeError("approval digest must be a SHA-256 hex digest");
    return value;
  }
  const input = ApprovalValidationInputSchema.parse(value);
  return approvalOperationDigest({
    proposalDigest: proposalDigest(input.proposal),
    operation: input.operation,
    commandDigest: input.commandDigest,
    diffSha256: input.diffSha256,
    targetEnvironment: input.targetEnvironment
  });
}

function operationDigestFor(input: ApprovalRequestInput | ApprovalValidationInput): string {
  return approvalOperationDigest({
    proposalDigest: proposalDigest(input.proposal),
    operation: input.operation,
    commandDigest: input.commandDigest,
    diffSha256: input.diffSha256,
    targetEnvironment: input.targetEnvironment
  });
}

function sameValue(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

export class ApprovalService {
  constructor(private readonly store: ApprovalStore) {}

  request(inputValue: ApprovalRequestInput): ApprovalRequest {
    const input = ApprovalRequestInputSchema.parse(inputValue);
    if (input.proposal.riskLevel !== "L2" && input.proposal.riskLevel !== "L3") {
      throw new TypeError("only L2 and L3 operations require approval");
    }
    if (classifyRisk(input.operation) !== input.proposal.riskLevel) {
      throw new TypeError("approval request risk does not match its operation");
    }
    const computedProposalDigest = proposalDigest(input.proposal);
    const digest = operationDigestFor(input);
    const operationPhrase = input.proposal.riskLevel === "L3" ? phraseFor(input.operation, digest) : undefined;
    const request = freeze(ApprovalRequestSchema.parse({
      ...input,
      proposalDigest: computedProposalDigest,
      digest,
      riskLevel: input.proposal.riskLevel,
      ...(operationPhrase === undefined ? {} : {
        operationPhrase,
        typedPhraseDigest: digestPhrase(operationPhrase)
      })
    }));
    const { operationPhrase: _operationPhrase, ...persistedRequest } = request;
    this.store.persistApprovalRequest(PersistedApprovalRequestSchema.parse(persistedRequest));
    return request;
  }

  confirm(
    requestValue: ApprovalRequest,
    actor: ApprovalPrincipal,
    now: Date,
    phrase?: string
  ): ApprovalDecision {
    const request = ApprovalRequestSchema.parse(requestValue);
    const principal = PrincipalBindingSchema.parse(actor);
    const persisted = this.store.findApproval(request.approvalId);
    if (persisted === undefined) return this.denied(request.approvalId, "not_found");
    const persistedRequest = ApprovalRequestSchema.parse({
      ...persisted.request,
      ...(persisted.request.riskLevel === "L3" ? {
        operationPhrase: phraseFor(persisted.request.operation, persisted.request.digest)
      } : {})
    });
    const expectedProposalDigest = proposalDigest(request.proposal);
    const expectedDigest = operationDigestFor(request);
    if (
      request.proposalDigest !== expectedProposalDigest
      || request.digest !== expectedDigest
      || classifyRisk(request.operation) !== request.riskLevel
      || request.proposal.riskLevel !== request.riskLevel
    ) {
      this.audit(request.approvalId, "approval.tamper_rejected", "request_digest_mismatch");
      throw new TypeError("approval request digest does not match its immutable operation");
    }
    if (
      request.riskLevel === "L3"
      && (
        request.operationPhrase !== phraseFor(request.operation, expectedDigest)
        || request.typedPhraseDigest !== digestPhrase(phraseFor(request.operation, expectedDigest))
      )
    ) {
      this.audit(request.approvalId, "approval.tamper_rejected", "request_phrase_mismatch");
      throw new TypeError("approval request phrase does not match its immutable operation");
    }
    if (!sameValue(request, persistedRequest)) {
      this.audit(request.approvalId, "approval.tamper_rejected", "request_digest_mismatch");
      throw new TypeError("approval request digest does not match its immutable operation");
    }
    if (persisted.state !== "pending") {
      if (persisted.state === "invalidated") return decision({ kind: "changed" });
      if (persisted.state === "expired") return decision({ kind: "expired" });
      return this.denied(request.approvalId, "replayed");
    }
    const actorRoles = principal.roles;
    const approvedAt = new Date(timeOf(now)).toISOString();
    if (request.channel === "telegram" || !request.allowedChannels.includes(request.channel)) {
      return this.denied(request.approvalId, "channel_not_allowed");
    }
    const canApprove = request.riskLevel === "L3"
      ? actorRoles.includes("owner")
      : actorRoles.some((role) => role === "owner" || role === "operator");
    if (!canApprove) return this.denied(request.approvalId, "role");
    if (
      request.riskLevel === "L3"
      && (request.typedPhraseDigest === undefined || digestPhrase(phrase ?? "") !== request.typedPhraseDigest)
    ) {
      return this.denied(request.approvalId, "phrase_mismatch");
    }

    const expiresAt = new Date(timeOf(now) + APPROVAL_WINDOW_MS).toISOString();
    const confirmed = this.store.confirmApproval(ApprovalConfirmationSchema.parse({
      approvalId: request.approvalId,
      proposalDigest: request.proposalDigest,
      operationDigest: request.digest,
      principalId: principal.principalId,
      channel: request.channel,
      approvedAt,
      expiresAt,
      ...(request.riskLevel === "L3" ? { typedPhraseDigest: request.typedPhraseDigest } : {}),
      executionProposalId: request.proposal.proposalId
    }));
    return decision({ kind: "approved", id: confirmed.approvalId });
  }

  validate(
    approvalId: string,
    current: string | ApprovalValidationInput,
    now: Date
  ): ApprovalDecision {
    const approval = this.store.findApproval(approvalId);
    if (approval === undefined) return this.denied(approvalId, "not_found");
    if (approval.state === "pending") return this.denied(approvalId, "pending");
    if (approval.state === "consumed") return this.denied(approvalId, "replayed");
    if (approval.state === "invalidated") return decision({ kind: "changed" });
    if (approval.state === "expired") return decision({ kind: "expired" });
    if (approval.approval === undefined) return this.denied(approvalId, "not_found");

    if (approval.approval.operationDigest !== currentDigest(current)) {
      if (this.store.invalidateApproval(approvalId, "digest_changed")) return decision({ kind: "changed" });
      return this.decisionForCurrentState(approvalId);
    }

    const approvedAt = new Date(approval.approval.approvedAt).getTime();
    const expiresAt = new Date(approval.approval.expiresAt).getTime();
    const currentTime = timeOf(now);
    if (
      !Number.isFinite(approvedAt)
      || !Number.isFinite(expiresAt)
      || expiresAt - approvedAt !== APPROVAL_WINDOW_MS
      || currentTime < approvedAt
      || currentTime >= expiresAt
    ) {
      if (this.store.expireApproval(approvalId)) return decision({ kind: "expired" });
      return this.decisionForCurrentState(approvalId);
    }
    if (!this.store.consumeApproval(approvalId)) return this.decisionForCurrentState(approvalId);
    return decision({ kind: "approved" });
  }

  invalidate(approvalId: string): ApprovalDecision {
    const approval = this.store.findApproval(approvalId);
    if (approval === undefined) return this.denied(approvalId, "not_found");
    if (approval.state === "invalidated") return decision({ kind: "changed" });
    if (approval.state === "expired") return decision({ kind: "expired" });
    if (this.store.invalidateApproval(approvalId, "manual")) return decision({ kind: "changed" });
    this.audit(approvalId, "approval.invalidation_rejected", approval.state === "consumed" ? "consumed" : "not_active");
    return this.decisionForCurrentState(approvalId);
  }

  private denied(approvalId: string, reason: "channel_not_allowed" | "role" | "phrase_mismatch" | "not_found" | "replayed" | "pending"): ApprovalDecision {
    this.audit(approvalId, "approval.denied", reason);
    return decision({ kind: "denied", reason });
  }

  private decisionForCurrentState(approvalId: string): ApprovalDecision {
    const current = this.store.findApproval(approvalId);
    if (current === undefined || current.state === "pending") return this.denied(approvalId, "not_found");
    if (current.state === "invalidated") return decision({ kind: "changed" });
    if (current.state === "expired") return decision({ kind: "expired" });
    return this.denied(approvalId, "replayed");
  }

  private audit(
    approvalId: string,
    eventType: "approval.denied" | "approval.tamper_rejected" | "approval.invalidation_rejected",
    reason: string
  ): void {
    this.store.recordApprovalAudit(approvalId, eventType, reason);
  }
}
