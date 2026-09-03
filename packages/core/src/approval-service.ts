import { createHash } from "node:crypto";

import {
  ApprovalConfirmationSchema,
  ApprovalRequestInputSchema,
  ApprovalRequestSchema,
  ApprovalValidationInputSchema,
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

function phraseFor(operationDigest: string): string {
  return `APPROVE ${operationDigest.toUpperCase()}`;
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
    const operationPhrase = input.proposal.riskLevel === "L3" ? phraseFor(digest) : undefined;
    return freeze(ApprovalRequestSchema.parse({
      ...input,
      proposalDigest: computedProposalDigest,
      digest,
      riskLevel: input.proposal.riskLevel,
      ...(operationPhrase === undefined ? {} : {
        operationPhrase,
        typedPhraseDigest: digestPhrase(operationPhrase)
      })
    }));
  }

  confirm(
    requestValue: ApprovalRequest,
    actor: ApprovalPrincipal,
    now: Date,
    phrase?: string
  ): ApprovalDecision {
    const request = ApprovalRequestSchema.parse(requestValue);
    const principal = PrincipalBindingSchema.parse(actor);
    const expectedProposalDigest = proposalDigest(request.proposal);
    const expectedDigest = operationDigestFor(request);
    if (
      request.proposalDigest !== expectedProposalDigest
      || request.digest !== expectedDigest
      || classifyRisk(request.operation) !== request.riskLevel
      || request.proposal.riskLevel !== request.riskLevel
    ) {
      throw new TypeError("approval request digest does not match its immutable operation");
    }
    if (
      request.riskLevel === "L3"
      && (
        request.operationPhrase !== phraseFor(expectedDigest)
        || request.typedPhraseDigest !== digestPhrase(phraseFor(expectedDigest))
      )
    ) {
      throw new TypeError("approval request phrase does not match its immutable operation");
    }
    const actorRoles = principal.roles;
    const approvedAt = new Date(timeOf(now)).toISOString();
    if (request.channel === "telegram" || !request.allowedChannels.includes(request.channel)) {
      return decision({ kind: "denied", reason: "channel_not_allowed" });
    }
    const canApprove = request.riskLevel === "L3"
      ? actorRoles.includes("owner")
      : actorRoles.some((role) => role === "owner" || role === "operator");
    if (!canApprove) return decision({ kind: "denied", reason: "role" });
    if (
      request.riskLevel === "L3"
      && (request.typedPhraseDigest === undefined || digestPhrase(phrase ?? "") !== request.typedPhraseDigest)
    ) {
      return decision({ kind: "denied", reason: "phrase_mismatch" });
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
    if (approval === undefined) return decision({ kind: "denied", reason: "not_found" });
    if (approval.state === "consumed") return decision({ kind: "denied", reason: "replayed" });
    if (approval.state === "invalidated") return decision({ kind: "changed" });

    if (approval.approval.operationDigest !== currentDigest(current)) {
      this.store.invalidateApproval(approvalId, "digest_changed");
      return decision({ kind: "changed" });
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
      return decision({ kind: "expired" });
    }
    if (!this.store.consumeApproval(approvalId)) return decision({ kind: "denied", reason: "replayed" });
    return decision({ kind: "approved" });
  }

  invalidate(approvalId: string): ApprovalDecision {
    const approval = this.store.findApproval(approvalId);
    if (approval === undefined) return decision({ kind: "denied", reason: "not_found" });
    if (approval.state === "invalidated") return decision({ kind: "changed" });
    this.store.invalidateApproval(approvalId, "manual");
    return decision({ kind: "changed" });
  }
}
