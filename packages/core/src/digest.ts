import { createHash } from "node:crypto";

import type { ExecutionProposal } from "./proposal.js";

export interface ApprovalOperationInput {
  readonly proposalDigest: string;
  readonly operation: string;
  readonly commandDigest: string;
  readonly diffSha256?: string | undefined;
  readonly targetEnvironment?: string | undefined;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical values must contain finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const properties = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
    return `{${properties.join(",")}}`;
  }
  throw new TypeError(`cannot canonicalize ${typeof value}`);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

export function proposalDigest(proposal: ExecutionProposal): string {
  return sha256({
    proposalId: proposal.proposalId,
    commandId: proposal.commandId,
    selectedProjectKey: proposal.selectedProjectKey,
    baseRef: proposal.baseRef ?? null,
    allowedScope: [...proposal.allowedScope].sort(),
    prohibitedEffects: [...proposal.prohibitedEffects].sort(),
    acceptanceCommands: [...proposal.acceptanceCommands],
    riskLevel: proposal.riskLevel,
    tasks: proposal.tasks
  });
}

export function approvalOperationDigest(input: ApprovalOperationInput): string {
  return sha256({
    proposalDigest: input.proposalDigest,
    operation: input.operation,
    commandDigest: input.commandDigest,
    diffSha256: input.diffSha256 ?? null,
    targetEnvironment: input.targetEnvironment ?? null
  });
}
