import { describe, expect, it } from "vitest";
import {
  ApprovalRecordSchema,
  CommandEnvelopeSchema,
  ExecutionProposalSchema,
  PrincipalBindingSchema
} from "../src/index.js";

const command = {
  commandId: "c1",
  idempotencyKey: "slack:workspace:m1",
  channel: "slack",
  externalMessageId: "m1",
  principalId: "principal-1",
  receivedAt: "2026-09-01T00:00:00.000Z",
  text: "status"
};

const proposal = {
  proposalId: "p1",
  commandId: "c1",
  selectedProjectKey: "web",
  routeCandidates: [{ projectKey: "web", score: 1, evidence: ["alias"] }],
  allowedScope: ["src/**"],
  prohibitedEffects: ["push"],
  acceptanceCommands: ["pnpm test"],
  riskLevel: "L2",
  tasks: [
    {
      localId: "task-1",
      title: "Implement the change",
      dependsOn: [],
      role: "implement",
      preferredAgent: "codex"
    }
  ]
};

describe("core schemas", () => {
  it("rejects a route score outside the closed interval", () => {
    const parsed = ExecutionProposalSchema.safeParse({
      proposalId: "p1", commandId: "c1", selectedProjectKey: "web",
      routeCandidates: [{ projectKey: "web", score: 1.1, evidence: ["alias"] }],
      allowedScope: ["src/**"], prohibitedEffects: ["push"], acceptanceCommands: ["pnpm test"],
      riskLevel: "L2", tasks: []
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts route scores at both closed-interval boundaries", () => {
    expect(ExecutionProposalSchema.safeParse({
      ...proposal,
      routeCandidates: [
        { projectKey: "web", score: 0, evidence: ["fallback"] },
        { projectKey: "api", score: 1, evidence: ["exact alias"] }
      ]
    }).success).toBe(true);
  });

  it("requires a provider message identity", () => {
    expect(CommandEnvelopeSchema.safeParse({ channel: "slack", text: "status" }).success).toBe(false);
    expect(CommandEnvelopeSchema.safeParse({ ...command, externalMessageId: "" }).success).toBe(false);
  });

  it("rejects unknown command fields", () => {
    expect(CommandEnvelopeSchema.safeParse({ ...command, impersonated: true }).success).toBe(false);
  });

  it("keeps transcript metadata forward-compatible", () => {
    expect(CommandEnvelopeSchema.safeParse({
      ...command,
      transcript: {
        provider: "openai",
        sourceFileSha256: "c".repeat(64),
        language: "ko"
      }
    }).success).toBe(true);
  });

  it("allows only the approved principal roles", () => {
    expect(PrincipalBindingSchema.safeParse({
      principalId: "principal-1",
      slackUserIds: ["U1"],
      telegramUserIds: ["1"],
      telegramChatIds: ["1"],
      tailscaleLoginNames: ["owner@example.com"],
      roles: ["owner", "operator", "viewer"]
    }).success).toBe(true);
    expect(PrincipalBindingSchema.safeParse({
      principalId: "principal-1",
      slackUserIds: [],
      telegramUserIds: [],
      telegramChatIds: [],
      tailscaleLoginNames: [],
      roles: ["admin"]
    }).success).toBe(false);
  });

  it("requires immutable approval identity and rejects unknown fields", () => {
    const approval = {
      approvalId: "a1",
      proposalDigest: "a".repeat(64),
      operationDigest: "b".repeat(64),
      principalId: "principal-1",
      channel: "slack",
      approvedAt: "2026-09-01T00:00:00.000Z",
      expiresAt: "2026-09-01T00:15:00.000Z"
    };

    expect(ApprovalRecordSchema.safeParse(approval).success).toBe(true);
    expect(ApprovalRecordSchema.safeParse({ ...approval, proposalDigest: "not-a-digest" }).success).toBe(false);
    expect(ApprovalRecordSchema.safeParse({ ...approval, replayed: true }).success).toBe(false);
  });
});
