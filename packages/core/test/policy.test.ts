import { describe, expect, it } from "vitest";

import {
  approvalOperationDigest,
  authorizeProposal,
  classifyRisk,
  proposalDigest,
  type ApprovalRecord,
  type AuthorizationContext,
  type ExecutionProposal,
  type PrincipalBinding,
  type RiskLevel
} from "../src/index.js";

const EXPECTED_PROPOSAL_DIGEST =
  "5c738ae45f1a00d2e62454634bb0ebfd5dc63bf7f9e0b2bac115267b3cb22ece";
const EXPECTED_OPERATION_DIGEST =
  "dbbfa5f9758db0ed374db8cf7bef37be6edb781c900b46e72828c245215de78e";

const owner = {
  principalId: "owner-1",
  slackUserIds: ["U1"],
  telegramUserIds: ["T1"],
  telegramChatIds: ["C1"],
  tailscaleLoginNames: ["owner@example.test"],
  roles: ["owner"]
} satisfies PrincipalBinding;

function principalWithRoles(roles: PrincipalBinding["roles"]): PrincipalBinding {
  return { ...owner, principalId: `principal-${roles.join("-")}`, roles };
}

function proposal(overrides: Partial<ExecutionProposal> = {}): ExecutionProposal {
  return {
    proposalId: "proposal-1",
    commandId: "command-1",
    selectedProjectKey: "project-a",
    routeCandidates: [
      { projectKey: "project-a", score: 1, evidence: ["explicit"] }
    ],
    baseRef: "main",
    allowedScope: ["src/**", "test/**"],
    prohibitedEffects: ["delete_data", "read_secret"],
    acceptanceCommands: ["pnpm test", "pnpm typecheck"],
    riskLevel: "L2",
    tasks: [
      {
        localId: "task-1",
        title: "Implement",
        dependsOn: [],
        role: "implement",
        preferredAgent: "codex"
      },
      {
        localId: "task-2",
        title: "Verify",
        dependsOn: ["task-1"],
        role: "verify",
        preferredAgent: "claude"
      }
    ],
    ...overrides
  };
}

function context(overrides: Partial<AuthorizationContext> = {}): AuthorizationContext {
  return {
    channel: "slack",
    principal: owner,
    projectAllowedOperations: ["L0", "L1", "L2", "L3"],
    operation: "create_pull_request",
    commandDigest: "c".repeat(64),
    diffSha256: "d".repeat(64),
    targetEnvironment: "staging",
    now: "2026-09-01T10:10:00.000Z",
    ...overrides
  };
}

function validApproval(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    approvalId: "approval-1",
    proposalDigest: EXPECTED_PROPOSAL_DIGEST,
    operationDigest: EXPECTED_OPERATION_DIGEST,
    principalId: owner.principalId,
    channel: "slack",
    approvedAt: "2026-09-01T10:00:00.000Z",
    expiresAt: "2026-09-01T10:15:00.000Z",
    ...overrides
  };
}

describe("risk classification", () => {
  it.each([
    ["inspect_status", "L0"],
    ["edit_isolated_worktree", "L1"],
    ["create_pull_request", "L2"],
    ["deploy_production", "L3"],
    ["delete_data", "L3"],
    ["read_secret", "L3"]
  ] as const)("classifies %s as %s", (operation, expected) => {
    expect(classifyRisk(operation)).toBe(expected);
  });

  it("classifies an unknown operation as L3 so new effects fail closed", () => {
    expect(classifyRisk("unreviewed_future_operation")).toBe("L3");
  });
});

describe("canonical approval digests", () => {
  it("hashes the hand-checked immutable proposal fixture", () => {
    expect(proposalDigest(proposal())).toBe(EXPECTED_PROPOSAL_DIGEST);
  });

  it("is independent of object property insertion order", () => {
    const reorderedTask = {
      preferredAgent: "codex" as const,
      title: "Implement",
      role: "implement" as const,
      dependsOn: [] as string[],
      localId: "task-1"
    };
    const reordered = {
      tasks: [reorderedTask, proposal().tasks[1]],
      riskLevel: "L2" as const,
      acceptanceCommands: ["pnpm test", "pnpm typecheck"],
      prohibitedEffects: ["delete_data", "read_secret"],
      allowedScope: ["src/**", "test/**"],
      baseRef: "main",
      routeCandidates: proposal().routeCandidates,
      selectedProjectKey: "project-a",
      commandId: "command-1",
      proposalId: "proposal-1"
    } satisfies ExecutionProposal;

    expect(proposalDigest(reordered)).toBe(EXPECTED_PROPOSAL_DIGEST);
  });

  it("normalizes only the set-like allowed scope and prohibited effects", () => {
    const reorderedSets = proposal({
      allowedScope: ["test/**", "src/**"],
      prohibitedEffects: ["read_secret", "delete_data"]
    });

    expect(proposalDigest(reorderedSets)).toBe(EXPECTED_PROPOSAL_DIGEST);
    expect(proposalDigest(proposal({
      acceptanceCommands: ["pnpm typecheck", "pnpm test"]
    }))).not.toBe(EXPECTED_PROPOSAL_DIGEST);
    expect(proposalDigest(proposal({
      tasks: [...proposal().tasks].reverse()
    }))).not.toBe(EXPECTED_PROPOSAL_DIGEST);
  });

  it("hashes the exact approval operation fields including diff and environment", () => {
    expect(approvalOperationDigest({
      proposalDigest: EXPECTED_PROPOSAL_DIGEST,
      operation: "create_pull_request",
      commandDigest: "c".repeat(64),
      diffSha256: "d".repeat(64),
      targetEnvironment: "staging"
    })).toBe(EXPECTED_OPERATION_DIGEST);
  });

  it("distinguishes omitted diff and environment from supplied values", () => {
    const minimal = approvalOperationDigest({
      proposalDigest: EXPECTED_PROPOSAL_DIGEST,
      operation: "create_pull_request",
      commandDigest: "c".repeat(64)
    });

    expect(minimal).not.toBe(EXPECTED_OPERATION_DIGEST);
    expect(minimal).toBe(approvalOperationDigest({
      proposalDigest: EXPECTED_PROPOSAL_DIGEST,
      operation: "create_pull_request",
      commandDigest: "c".repeat(64),
      diffSha256: undefined,
      targetEnvironment: undefined
    }));
  });
});

describe("proposal authorization", () => {
  it.each([
    ["telegram", "L1", "edit_isolated_worktree", "auto"],
    ["telegram", "L2", "create_pull_request", "rejected"],
    ["telegram", "L3", "deploy_production", "rejected"],
    ["slack", "L2", "create_pull_request", "approval_required"],
    ["tailscale-web", "L3", "deploy_production", "approval_required"]
  ] as const)("maps %s %s to %s", (channel, riskLevel, operation, expected) => {
    expect(authorizeProposal(
      proposal({ riskLevel }),
      context({ channel, operation, diffSha256: undefined, targetEnvironment: undefined })
    ).kind).toBe(expected);
  });

  it.each([
    [["viewer"], "L0", "inspect_status", "auto"],
    [["viewer"], "L1", "edit_isolated_worktree", "rejected"],
    [["viewer"], "L2", "create_pull_request", "rejected"],
    [["operator"], "L1", "edit_isolated_worktree", "auto"],
    [["operator"], "L2", "create_pull_request", "approval_required"],
    [["operator"], "L3", "deploy_production", "rejected"],
    [["owner"], "L3", "deploy_production", "approval_required"]
  ] as const)("enforces %j authority for %s", (roles, riskLevel, operation, expected) => {
    expect(authorizeProposal(
      proposal({ riskLevel }),
      context({
        principal: principalWithRoles([...roles]),
        operation,
        diffSha256: undefined,
        targetEnvironment: undefined
      })
    ).kind).toBe(expected);
  });

  it("rejects a proposal risk that the selected project does not allow", () => {
    expect(authorizeProposal(proposal(), context({
      projectAllowedOperations: ["L0", "L1"]
    }))).toMatchObject({ kind: "rejected", reason: "project_operation_not_allowed" });
  });

  it("rejects a proposal whose declared risk understates its operation", () => {
    expect(authorizeProposal(
      proposal({ riskLevel: "L2" }),
      context({ operation: "unreviewed_future_operation" })
    )).toMatchObject({ kind: "rejected", reason: "risk_mismatch" });
  });

  it("never accepts a Telegram approval for L2", () => {
    expect(authorizeProposal(proposal(), context({
      channel: "telegram",
      approval: validApproval({ channel: "telegram" })
    }))).toMatchObject({ kind: "rejected", reason: "channel_not_allowed" });
  });

  it("accepts an exact L2 approval from an operator", () => {
    const operator = principalWithRoles(["operator"]);
    expect(authorizeProposal(proposal(), context({
      principal: operator,
      approval: validApproval({ principalId: operator.principalId })
    }))).toMatchObject({ kind: "auto", approvalId: "approval-1" });
  });

  it("authorizes only an exact, current, fifteen-minute approval", () => {
    const decision = authorizeProposal(proposal(), context({ approval: validApproval() }));

    expect(decision).toMatchObject({ kind: "auto", approvalId: "approval-1" });
    expect(Object.isFrozen(decision)).toBe(true);
  });

  it.each([
    ["proposal digest", { proposalDigest: "a".repeat(64) }],
    ["operation digest", { operationDigest: "b".repeat(64) }],
    ["principal", { principalId: "someone-else" }],
    ["channel", { channel: "tailscale-web" }]
  ] as const)("requires the exact approval %s", (_label, approvalOverrides) => {
    const approval = validApproval(approvalOverrides as Partial<ApprovalRecord>);
    expect(authorizeProposal(proposal(), context({ approval })).kind).toBe("approval_required");
  });

  it("invalidates approval when proposal project, base, scope, command, or acceptance changes", () => {
    const approval = validApproval();
    const mutations: ExecutionProposal[] = [
      proposal({ selectedProjectKey: "project-b" }),
      proposal({ baseRef: "release" }),
      proposal({ allowedScope: ["src/**"] }),
      proposal({ prohibitedEffects: ["read_secret"] }),
      proposal({ commandId: "command-2" }),
      proposal({ acceptanceCommands: ["pnpm test"] })
    ];

    for (const changedProposal of mutations) {
      expect(authorizeProposal(changedProposal, context({ approval })).kind).toBe("approval_required");
    }
  });

  it("invalidates approval when current diff, command digest, or environment changes", () => {
    const approval = validApproval();
    const changes: Partial<AuthorizationContext>[] = [
      { diffSha256: "e".repeat(64) },
      { commandDigest: "e".repeat(64) },
      { targetEnvironment: "production" }
    ];

    for (const change of changes) {
      expect(authorizeProposal(proposal(), context({ approval, ...change })).kind)
        .toBe("approval_required");
    }
  });

  it("expires at exactly fifteen minutes using parsed timestamps", () => {
    const approval = validApproval();

    expect(authorizeProposal(proposal(), context({
      approval,
      now: "2026-09-01T10:14:59.999Z"
    })).kind).toBe("auto");
    expect(authorizeProposal(proposal(), context({
      approval,
      now: "2026-09-01T10:15:00Z"
    })).kind).toBe("approval_required");
    expect(authorizeProposal(proposal(), context({
      approval: validApproval({ expiresAt: "2026-09-01T10:16:00.000Z" })
    })).kind).toBe("approval_required");
  });

  it("requires typed-phrase evidence for an L3 approval", () => {
    const l3Proposal = proposal({ riskLevel: "L3" });
    const l3ProposalDigest = proposalDigest(l3Proposal);
    const l3OperationDigest = approvalOperationDigest({
      proposalDigest: l3ProposalDigest,
      operation: "deploy_production",
      commandDigest: "c".repeat(64),
      targetEnvironment: "production"
    });
    const approval = validApproval({
      proposalDigest: l3ProposalDigest,
      operationDigest: l3OperationDigest,
      channel: "tailscale-web"
    });
    const l3Context = context({
      channel: "tailscale-web",
      operation: "deploy_production",
      diffSha256: undefined,
      targetEnvironment: "production",
      approval
    });

    expect(authorizeProposal(l3Proposal, l3Context).kind).toBe("approval_required");
    expect(authorizeProposal(l3Proposal, {
      ...l3Context,
      approval: { ...approval, typedPhraseDigest: "f".repeat(64) }
    }).kind).toBe("auto");
  });

  it("returns a frozen fail-closed decision for malformed runtime context", () => {
    const decision = authorizeProposal(proposal(), {
      ...context(),
      channel: "email"
    } as unknown as AuthorizationContext);

    expect(decision).toMatchObject({ kind: "rejected", reason: "invalid_context" });
    expect(Object.isFrozen(decision)).toBe(true);
  });
});
