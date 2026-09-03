import { ControlStore, openDatabase } from "@orca-hq/persistence";
import { approvalOperationDigest, proposalDigest, type ExecutionProposal } from "@orca-hq/core";
import { describe, expect, it } from "vitest";

import { createCommandDashboard } from "../src/dashboard.js";

describe("production command dashboard", () => {
  it("derives durable proposal, task, approval and failed verification evidence without low-risk defaults", async () => {
    // Break caught: an empty or non-runnable durable state is presented as successful or actionable.
    const database = openDatabase(":memory:");
    const store = new ControlStore(database);
    try {
      store.insertCommand({
        commandId: "command-501", idempotencyKey: "telegram-501", channel: "telegram",
        externalMessageId: "20:501", principalId: "owner", receivedAt: "2026-09-03T00:00:00.000Z",
        text: "샌드박스 테스트 수정"
      });
      const proposal: ExecutionProposal = {
        proposalId: "proposal-501", commandId: "command-501", selectedProjectKey: "sandbox",
        routeCandidates: [{ projectKey: "sandbox", score: 0.7, evidence: ["alias:sandbox"] }],
        allowedScope: ["src"], prohibitedEffects: ["deploy"], acceptanceCommands: ["pnpm test"], riskLevel: "L3",
        tasks: [{ localId: "implement", title: "수정", dependsOn: [], role: "implement", preferredAgent: "codex" }]
      };
      store.saveRun({
        id: "run-501", proposalId: proposal.proposalId, commandId: "command-501", state: "verification_failed",
        recoveryContext: { proposal }
      });
      store.saveTask({
        id: "task-501", runId: "run-501", title: "검증", role: "verify", preferredAgent: "claude",
        dependsOn: ["task-implement"], state: "verification_failed",
        // This is the durable writer shape produced by verification completion.  A
        // dashboard regression must read this evidence, not invent a Run field.
        report: {
          reportId: "report-501", runId: "run-501", verificationTaskId: "task-501",
          implementationTaskId: "task-implement", implementationDispatchId: "dispatch-implement", cycle: 0,
          verdict: "fail", projectRoute: { projectKey: "sandbox", orcaProjectId: "orca-sandbox", repositoryPath: "/srv/sandbox" },
          changedFiles: ["src/example.ts"], diffSha256: "c".repeat(64), diffSummary: "1 file changed",
          commands: [{ command: "pnpm test", exitCode: 1, outcome: "failed", auditReference: "audit:test" }],
          implementationProvider: "codex", verifierProvider: "claude", findings: ["test failed"], evidence: ["audit:test"],
          auditReferences: ["audit:test"], verifierEffects: { filesModified: false, committed: false, pushed: false, pullRequestChanged: false, merged: false, deployed: false, secretsAccessed: false, productionAccessed: false }
        }
      });
      store.saveDispatch({ id: "dispatch-501", taskId: "task-501", state: "worker_done" });
      store.appendAudit({ subjectId: "command-501", eventType: "command.accepted", data: {} });
      const digest = approvalOperationDigest({
        proposalDigest: proposalDigest(proposal), operation: "deploy_production", commandDigest: "a".repeat(64)
      });
      store.saveExecutionProposal(proposal);
      store.persistApprovalRequest({
        approvalId: "approval-501", proposal, operation: "deploy_production", commandDigest: "a".repeat(64),
        channel: "tailscale-web", allowedChannels: ["tailscale-web"], proposalDigest: proposalDigest(proposal),
        digest, riskLevel: "L3", typedPhraseDigest: "b".repeat(64)
      });
      const dashboard = createCommandDashboard(store);

      await expect(dashboard.listCommands({ principalId: "owner", roles: ["owner"] })).resolves.toEqual({ commands: [{
        id: "command-501", summary: "샌드박스 테스트 수정", status: "verification_failed",
        projectKey: "sandbox", riskLevel: "L3", updatedAt: "2026-09-03T00:00:00.000Z"
      }] });
      await expect(dashboard.getCommand({ commandId: "command-501", principal: { principalId: "owner", roles: ["owner"] } }))
        .resolves.toMatchObject({
          routing: { score: 0.7, selectedReason: "alias:sandbox", candidates: ["sandbox"] },
          contract: { allowedScope: ["src"], prohibitedEffects: ["deploy"], testCommands: ["pnpm test"] },
          verification: { status: "failed", commands: ["pnpm test"] },
          tasks: [{ id: "task-501", dependencies: ["task-implement"], verifierFamily: "claude", dispatchId: "dispatch-501", canStop: false, canRetry: false }],
          diff: { summary: "1 file changed" },
          approval: { id: "approval-501", level: "L3", digest, operationPhrase: `APPROVE DEPLOY_PRODUCTION ${digest.slice(0, 12).toUpperCase()}`, status: "pending", permitted: false },
          audit: { reference: expect.any(String) }, delivery: []
        });
    } finally {
      database.close();
    }
  });
});
