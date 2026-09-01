import { z } from "zod";

import { ApprovalRecordSchema, type ApprovalRecord } from "./approval.js";
import { ChannelSchema, type Channel } from "./command.js";
import {
  approvalOperationDigest,
  proposalDigest
} from "./digest.js";
import {
  PrincipalBindingSchema,
  type PrincipalBinding
} from "./identity.js";
import {
  ExecutionProposalSchema,
  RiskLevelSchema,
  type ExecutionProposal,
  type RiskLevel
} from "./proposal.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const NowSchema = z.union([z.string().datetime(), z.date()]);

const AuthorizationContextSchema = z.object({
  channel: ChannelSchema,
  principal: PrincipalBindingSchema,
  projectAllowedOperations: z.array(RiskLevelSchema),
  operation: z.string().min(1),
  commandDigest: Sha256Schema,
  diffSha256: Sha256Schema.optional(),
  targetEnvironment: z.string().min(1).optional(),
  expectedTypedPhraseDigest: Sha256Schema.optional(),
  now: NowSchema,
  approval: z.unknown().optional()
}).strict();

export interface AuthorizationContext {
  readonly channel: Channel;
  readonly principal: PrincipalBinding;
  readonly projectAllowedOperations: readonly RiskLevel[];
  readonly operation: string;
  readonly commandDigest: string;
  readonly diffSha256?: string | undefined;
  readonly targetEnvironment?: string | undefined;
  readonly expectedTypedPhraseDigest?: string | undefined;
  readonly now: string | Date;
  readonly approval?: ApprovalRecord | undefined;
}

export type PolicyDecision =
  | Readonly<{ kind: "auto"; approvalId?: string }>
  | Readonly<{
      kind: "approval_required";
      reason: "missing" | "changed" | "expired" | "invalid";
    }>
  | Readonly<{
      kind: "rejected";
      reason:
        | "invalid_context"
        | "invalid_proposal"
        | "project_operation_not_allowed"
        | "risk_mismatch"
        | "role_not_allowed"
        | "channel_not_allowed";
    }>;

const riskByOperation = Object.freeze({
  inspect_status: "L0",
  edit_isolated_worktree: "L1",
  test_isolated_worktree: "L1",
  commit_changes: "L2",
  push_branch: "L2",
  create_pull_request: "L2",
  deploy_production: "L3",
  delete_data: "L3",
  read_secret: "L3"
} satisfies Readonly<Record<string, RiskLevel>>);

const FIFTEEN_MINUTES_MS = 15 * 60 * 1_000;

function decision<T extends PolicyDecision>(value: T): Readonly<T> {
  return Object.freeze(value);
}

export function classifyRisk(operation: string): RiskLevel {
  return riskByOperation[operation as keyof typeof riskByOperation] ?? "L3";
}

function canRequest(riskLevel: RiskLevel, principal: PrincipalBinding): boolean {
  if (riskLevel === "L0") return principal.roles.length > 0;
  return principal.roles.some((role) => role === "owner" || role === "operator");
}

function canApprove(riskLevel: RiskLevel, principal: PrincipalBinding): boolean {
  if (riskLevel === "L2") {
    return principal.roles.some((role) => role === "owner" || role === "operator");
  }
  if (riskLevel === "L3") return principal.roles.includes("owner");
  return true;
}

function approvalStatus(
  proposal: ExecutionProposal,
  context: AuthorizationContext,
  approvalInput: unknown
): "valid" | "missing" | "changed" | "expired" | "invalid" {
  if (approvalInput === undefined) return "missing";
  const parsed = ApprovalRecordSchema.safeParse(approvalInput);
  if (!parsed.success) return "invalid";
  const approval = parsed.data;
  const expectedProposalDigest = proposalDigest(proposal);
  const expectedOperationDigest = approvalOperationDigest({
    proposalDigest: expectedProposalDigest,
    operation: context.operation,
    commandDigest: context.commandDigest,
    diffSha256: context.diffSha256,
    targetEnvironment: context.targetEnvironment
  });

  if (
    approval.proposalDigest !== expectedProposalDigest
    || approval.operationDigest !== expectedOperationDigest
    || approval.principalId !== context.principal.principalId
    || approval.channel !== context.channel
  ) {
    return "changed";
  }

  if (
    proposal.riskLevel === "L3"
    && (
      context.expectedTypedPhraseDigest === undefined
      || approval.typedPhraseDigest !== context.expectedTypedPhraseDigest
    )
  ) {
    return "invalid";
  }

  const approvedAt = new Date(approval.approvedAt).getTime();
  const expiresAt = new Date(approval.expiresAt).getTime();
  const now = context.now instanceof Date
    ? context.now.getTime()
    : new Date(context.now).getTime();
  if (
    expiresAt - approvedAt !== FIFTEEN_MINUTES_MS
    || now < approvedAt
    || now >= expiresAt
  ) {
    return "expired";
  }
  return "valid";
}

export function authorizeProposal(
  proposalInput: ExecutionProposal,
  contextInput: AuthorizationContext
): PolicyDecision {
  const parsedProposal = ExecutionProposalSchema.safeParse(proposalInput);
  if (!parsedProposal.success) {
    return decision({ kind: "rejected", reason: "invalid_proposal" });
  }
  const parsedContext = AuthorizationContextSchema.safeParse(contextInput);
  if (!parsedContext.success) {
    return decision({ kind: "rejected", reason: "invalid_context" });
  }

  const proposal = parsedProposal.data;
  const { approval: approvalInput, ...validatedContext } = parsedContext.data;
  const context: AuthorizationContext = validatedContext;
  if (classifyRisk(context.operation) !== proposal.riskLevel) {
    return decision({ kind: "rejected", reason: "risk_mismatch" });
  }
  if (!context.projectAllowedOperations.includes(proposal.riskLevel)) {
    return decision({ kind: "rejected", reason: "project_operation_not_allowed" });
  }
  if (!canRequest(proposal.riskLevel, context.principal)) {
    return decision({ kind: "rejected", reason: "role_not_allowed" });
  }
  if (proposal.riskLevel === "L0" || proposal.riskLevel === "L1") {
    return decision({ kind: "auto" });
  }
  if (context.channel === "telegram") {
    return decision({ kind: "rejected", reason: "channel_not_allowed" });
  }
  if (!canApprove(proposal.riskLevel, context.principal)) {
    return decision({ kind: "rejected", reason: "role_not_allowed" });
  }

  const status = approvalStatus(proposal, context, approvalInput);
  if (status !== "valid") {
    return decision({ kind: "approval_required", reason: status });
  }
  return decision({
    kind: "auto",
    approvalId: ApprovalRecordSchema.parse(approvalInput).approvalId
  });
}
