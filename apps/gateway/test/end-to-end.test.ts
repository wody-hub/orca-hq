import { createHash } from "node:crypto";

import {
  IdentityResolver,
  approvalOperationDigest,
  authorizeProposal,
  proposalDigest,
  type ApprovalRecord,
  type ExecutionProposal,
  type PrincipalBinding
} from "@orca-hq/core";
import { ControlStore, openDatabase } from "@orca-hq/persistence";
import { createTelegramAdapter } from "@orca-hq/telegram-adapter";
import { describe, expect, it } from "vitest";

const owner: PrincipalBinding = {
  principalId: "owner", slackUserIds: [], telegramUserIds: ["10"], telegramChatIds: ["20"],
  tailscaleLoginNames: ["owner@example.test"], roles: ["owner"]
};
const digest = "a".repeat(64);

function phraseDigest(phrase: string): string {
  return createHash("sha256").update(phrase.normalize("NFKC").trim()).digest("hex");
}

function proposal(riskLevel: "L0" | "L1" | "L2" | "L3"): ExecutionProposal {
  return {
    proposalId: `proposal-${riskLevel}`, commandId: "501", selectedProjectKey: "sandbox",
    routeCandidates: [{ projectKey: "sandbox", score: 1, evidence: ["alias:sandbox"] }],
    allowedScope: ["src"], prohibitedEffects: [], acceptanceCommands: ["pnpm test"], riskLevel,
    tasks: [{ localId: "task-1", title: "변경", dependsOn: [], role: riskLevel === "L0" ? "investigate" : "implement", preferredAgent: "codex" }]
  };
}

describe("Gateway end-to-end durable boundaries", () => {
  it("normalizes Telegram ingress into the real durable command store before policy is evaluated", async () => {
    // Break caught: a provider-shaped update bypasses normalization/idempotency and feeds a fake command result.
    const database = openDatabase(":memory:");
    const store = new ControlStore(database);
    const identities = new IdentityResolver({ bindings: [owner], allowedSlackWorkspaceIds: ["T123"] });
    const adapter = createTelegramAdapter({ botIdentity: "bot", maxVoiceBytes: 1_000 }, {
      ingress: store,
      identities,
      cursorStore: { async load() { return undefined; }, async save() {} },
      outbox: { async enqueue() {} },
      approvalPort: { async request() {} }
    });
    try {
      await adapter.handleUpdate({ update_id: 7, message: {
        message_id: 501, date: 1_788_220_800, from: { id: 10 }, chat: { id: 20 }, text: "샌드박스 테스트 수정"
      } });
      const command = store.listCommands().find(({ externalMessageId }) => externalMessageId === "20:501");
      expect(command).toMatchObject({ channel: "telegram", principalId: "owner", text: "샌드박스 테스트 수정" });
      expect(command?.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
      expect(store.listAuditEvents().map(({ eventType }) => eventType)).toContain("command.accepted");
    } finally {
      database.close();
    }
  });

  it("uses the real policy and approval state rather than a fake verified-success literal", () => {
    // Break caught: L2/L3 advance without exact durable approval, or Telegram is treated as an approval channel.
    const database = openDatabase(":memory:");
    const store = new ControlStore(database);
    const l1 = proposal("L1");
    const l2 = proposal("L2");
    const l3 = proposal("L3");
    const context = (channel: "telegram" | "tailscale-web", operation: string, approval?: ApprovalRecord, expectedTypedPhraseDigest?: string) => ({
      channel, principal: owner, projectAllowedOperations: ["L0", "L1", "L2", "L3"] as const,
      operation, commandDigest: digest, now: "2026-09-03T00:00:00.000Z",
      ...(approval === undefined ? {} : { approval }),
      ...(expectedTypedPhraseDigest === undefined ? {} : { expectedTypedPhraseDigest })
    });
    try {
      expect(authorizeProposal(l1, context("telegram", "edit_isolated_worktree"))).toEqual({ kind: "auto" });
      expect(authorizeProposal(l2, context("tailscale-web", "commit_changes"))).toEqual({ kind: "approval_required", reason: "missing" });
      expect(authorizeProposal(l2, context("telegram", "commit_changes"))).toEqual({ kind: "rejected", reason: "channel_not_allowed" });
      expect(authorizeProposal(l3, context("telegram", "deploy_production"))).toEqual({ kind: "rejected", reason: "channel_not_allowed" });

      const approvedAt = "2026-09-03T00:00:00.000Z";
      const expiresAt = "2026-09-03T00:15:00.000Z";
      const l2Approval: ApprovalRecord = {
        approvalId: "approval-l2", proposalDigest: proposalDigest(l2), principalId: "owner", channel: "tailscale-web", approvedAt, expiresAt,
        operationDigest: approvalOperationDigest({ proposalDigest: proposalDigest(l2), operation: "commit_changes", commandDigest: digest })
      };
      expect(authorizeProposal(l2, context("tailscale-web", "commit_changes", l2Approval))).toEqual({ kind: "auto", approvalId: "approval-l2" });
      expect(authorizeProposal(l2, context("tailscale-web", "commit_changes", { ...l2Approval, operationDigest: "b".repeat(64) }))).toEqual({ kind: "approval_required", reason: "changed" });

      const l3OperationDigest = approvalOperationDigest({ proposalDigest: proposalDigest(l3), operation: "deploy_production", commandDigest: digest });
      const phrase = `APPROVE DEPLOY_PRODUCTION ${l3OperationDigest.slice(0, 12).toUpperCase()}`;
      const l3Approval: ApprovalRecord = {
        approvalId: "approval-l3", proposalDigest: proposalDigest(l3), principalId: "owner", channel: "tailscale-web", approvedAt, expiresAt,
        operationDigest: l3OperationDigest, typedPhraseDigest: phraseDigest(phrase)
      };
      expect(authorizeProposal(l3, context("tailscale-web", "deploy_production", l3Approval, phraseDigest("wrong phrase"))))
        .toEqual({ kind: "approval_required", reason: "invalid" });
      expect(authorizeProposal(l3, context("tailscale-web", "deploy_production", l3Approval, phraseDigest(phrase))))
        .toEqual({ kind: "auto", approvalId: "approval-l3" });
    } finally {
      database.close();
    }
  });
});
