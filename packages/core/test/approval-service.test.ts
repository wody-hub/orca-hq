import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ApprovalService,
  type ApprovalRecord,
  type ApprovalStore,
  type ExecutionProposal,
  type PrincipalBinding
} from "../src/index.js";

const owner = {
  principalId: "owner-1",
  slackUserIds: ["U1"],
  telegramUserIds: [],
  telegramChatIds: [],
  tailscaleLoginNames: ["owner@example.test"],
  roles: ["owner"]
} satisfies PrincipalBinding;

const operator = { ...owner, principalId: "operator-1", roles: ["operator"] } satisfies PrincipalBinding;

function at(time: string): Date {
  return new Date(`2026-09-01T${time}.000Z`);
}

function proposal(overrides: Partial<ExecutionProposal> = {}): ExecutionProposal {
  return {
    proposalId: "proposal-1",
    commandId: "command-1",
    selectedProjectKey: "project-a",
    routeCandidates: [{ projectKey: "project-a", score: 1, evidence: ["explicit"] }],
    baseRef: "main",
    allowedScope: ["src/**"],
    prohibitedEffects: ["delete_data"],
    acceptanceCommands: ["pnpm test"],
    riskLevel: "L2",
    tasks: [{
      localId: "implement",
      title: "Implement",
      dependsOn: [],
      role: "implement",
      preferredAgent: "codex"
    }],
    ...overrides
  };
}

function memoryStore(): ApprovalStore & { readonly invalidations: string[] } {
  const approvals = new Map<string, { record: ApprovalRecord; state: "approved" | "consumed" | "invalidated" }>();
  const invalidations: string[] = [];
  return {
    invalidations,
    confirmApproval(record) {
      approvals.set(record.approvalId, { record, state: "approved" });
      return record;
    },
    findApproval(approvalId) {
      const approval = approvals.get(approvalId);
      return approval === undefined ? undefined : { approval: approval.record, state: approval.state };
    },
    consumeApproval(approvalId) {
      const approval = approvals.get(approvalId);
      if (approval === undefined || approval.state !== "approved") return false;
      approval.state = "consumed";
      return true;
    },
    invalidateApproval(approvalId, _reason) {
      const approval = approvals.get(approvalId);
      if (approval === undefined || approval.state !== "approved") return false;
      approval.state = "invalidated";
      invalidations.push(approvalId);
      return true;
    }
  };
}

function requestedApproval(service: ApprovalService, overrides: Record<string, unknown> = {}) {
  return service.request({
    approvalId: "approval-1",
    proposal: proposal(),
    operation: "create_pull_request",
    commandDigest: "c".repeat(64),
    diffSha256: "d".repeat(64),
    targetEnvironment: "staging",
    channel: "slack",
    allowedChannels: ["slack", "tailscale-web"],
    ...overrides
  });
}

describe("ApprovalService", () => {
  it("expires an L2 approval after 15 minutes", () => {
    // Break caught: accepting a confirmation outside its fixed fifteen-minute validity window.
    const service = new ApprovalService(memoryStore());
    const request = requestedApproval(service);
    const confirmation = service.confirm(request, owner, at("10:00:00"));
    expect(confirmation.kind).toBe("approved");
    if (confirmation.kind !== "approved") throw new Error("approval was unexpectedly denied");

    expect(service.validate(confirmation.id, request.digest, at("10:15:01")))
      .toEqual({ kind: "expired" });
  });

  it("requires the generated phrase for L3", () => {
    // Break caught: an owner can approve an L3 operation with arbitrary text.
    const service = new ApprovalService(memoryStore());
    const l3Request = requestedApproval(service, {
      approvalId: "approval-l3",
      proposal: proposal({ riskLevel: "L3" }),
      operation: "deploy_production",
      targetEnvironment: "production"
    });

    expect(service.confirm(l3Request, owner, at("10:00:00"), "APPROVE OTHER"))
      .toEqual({ kind: "denied", reason: "phrase_mismatch" });
    expect(service.confirm(l3Request, owner, at("10:00:00"), l3Request.operationPhrase).kind)
      .toBe("approved");
  });

  it("rejects a request whose digest no longer matches its immutable operation", () => {
    // Break caught: a caller can substitute an operation digest after the request has been generated.
    const service = new ApprovalService(memoryStore());
    const request = requestedApproval(service);

    expect(() => service.confirm({ ...request, digest: "e".repeat(64) }, owner, at("10:00:00")))
      .toThrow("approval request digest does not match its immutable operation");
  });

  it("refuses an operation whose classified risk differs from the proposal risk", () => {
    // Break caught: a high-risk operation can be presented as an L2 approval request.
    const service = new ApprovalService(memoryStore());

    expect(() => requestedApproval(service, { operation: "deploy_production" }))
      .toThrow("approval request risk does not match its operation");
  });

  it("rejects a substituted L3 phrase digest", () => {
    // Break caught: a caller can replace the persisted phrase digest with the digest of arbitrary text.
    const service = new ApprovalService(memoryStore());
    const request = requestedApproval(service, {
      proposal: proposal({ riskLevel: "L3" }),
      operation: "deploy_production",
      targetEnvironment: "production"
    });
    const otherPhrase = "APPROVE OTHER";

    expect(() => service.confirm({
      ...request,
      operationPhrase: otherPhrase,
      typedPhraseDigest: createHash("sha256").update(otherPhrase).digest("hex")
    }, owner, at("10:00:00"), otherPhrase)).toThrow(
      "approval request phrase does not match its immutable operation"
    );
  });

  it("allows operator for L2 but only owner for L3", () => {
    // Break caught: an operator is allowed to confirm an L3 operation.
    const service = new ApprovalService(memoryStore());
    const l2Request = requestedApproval(service);
    const l3Request = requestedApproval(service, {
      approvalId: "approval-l3",
      proposal: proposal({ riskLevel: "L3" }),
      operation: "deploy_production",
      targetEnvironment: "production"
    });

    expect(service.confirm(l2Request, operator, at("10:00:00")).kind).toBe("approved");
    expect(service.confirm(l3Request, operator, at("10:00:00"), l3Request.operationPhrase))
      .toEqual({ kind: "denied", reason: "role" });
  });

  it("denies Telegram and consumes an approved digest exactly once", () => {
    // Break caught: an approval can be issued on Telegram or replayed for another dispatch.
    const service = new ApprovalService(memoryStore());
    const telegram = requestedApproval(service, {
      approvalId: "approval-telegram",
      channel: "telegram",
      allowedChannels: []
    });
    expect(service.confirm(telegram, owner, at("10:00:00")))
      .toEqual({ kind: "denied", reason: "channel_not_allowed" });

    const request = requestedApproval(service);
    const confirmation = service.confirm(request, owner, at("10:00:00"));
    if (confirmation.kind !== "approved") throw new Error("approval was unexpectedly denied");
    expect(service.validate(confirmation.id, request.digest, at("10:01:00"))).toEqual({ kind: "approved" });
    expect(service.validate(confirmation.id, request.digest, at("10:01:01")))
      .toEqual({ kind: "denied", reason: "replayed" });
  });

  it("invalidates and audits an approval when its recomputed operation digest changes", () => {
    // Break caught: a digest mismatch proceeds without invalidating the stale persisted approval.
    const store = memoryStore();
    const service = new ApprovalService(store);
    const request = requestedApproval(service);
    const confirmation = service.confirm(request, owner, at("10:00:00"));
    if (confirmation.kind !== "approved") throw new Error("approval was unexpectedly denied");
    const changed = requestedApproval(service, {
      proposal: proposal({ acceptanceCommands: ["pnpm test", "pnpm typecheck"] })
    });

    expect(service.validate(confirmation.id, changed.digest, at("10:01:00")))
      .toEqual({ kind: "changed" });
    expect(store.invalidations).toEqual([confirmation.id]);
  });

  it("recomputes current immutable operation inputs before invalidating a changed approval", () => {
    // Break caught: raw current operation fields are trusted without recalculating the operation digest.
    const mutations = [
      { proposal: proposal({ selectedProjectKey: "project-b" }) },
      { proposal: proposal({ baseRef: "release" }) },
      { proposal: proposal({ allowedScope: ["packages/**"] }) },
      { proposal: proposal({ prohibitedEffects: ["read_secret"] }) },
      { proposal: proposal({ acceptanceCommands: ["pnpm typecheck"] }) },
      { commandDigest: "e".repeat(64) },
      { diffSha256: "e".repeat(64) },
      { targetEnvironment: "production" }
    ];

    for (const [index, mutation] of mutations.entries()) {
      const store = memoryStore();
      const service = new ApprovalService(store);
      const request = requestedApproval(service, { approvalId: `approval-change-${index}` });
      const confirmation = service.confirm(request, owner, at("10:00:00"));
      if (confirmation.kind !== "approved") throw new Error("approval was unexpectedly denied");

      expect(service.validate(confirmation.id, {
        proposal: proposal(),
        operation: "create_pull_request",
        commandDigest: "c".repeat(64),
        diffSha256: "d".repeat(64),
        targetEnvironment: "staging",
        ...mutation
      }, at("10:01:00"))).toEqual({ kind: "changed" });
      expect(store.invalidations).toEqual([confirmation.id]);
    }
  });
});
