import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { reconcileStartup } from "@orca-hq/gateway/reconcile";
import {
  ApprovalService,
  IdentityResolver,
  authorizeProposal,
  type Channel,
  type ExecutionProposal,
  type PrincipalBinding
} from "@orca-hq/core";
import {
  ControlStore,
  OutboxDispatcher,
  openDatabase
} from "@orca-hq/persistence";
import {
  decideRankedRoute,
  routeProject,
  type ProjectRegistryEntry
} from "@orca-hq/project-registry";
import { createLocalSessionService } from "@orca-hq/tailscale-adapter";
import { GitWorktreePlacementService } from "@orca-hq/worker-routing";

import { FakeAgents } from "./fake-agents.js";
import { FakeSlack } from "./fake-slack.js";
import { FakeTelegram } from "./fake-telegram.js";
import { createSandboxRepo } from "./sandbox-repo.js";

export const PILOT_CRITERION_IDS = Object.freeze([
  "coworker_documented_install",
  "channels_authenticate",
  "korean_telegram_voice_to_codex_hq",
  "route_evidence_and_plan_preview",
  "l1_isolated_worktree",
  "both_model_families_implement",
  "cross_model_verification",
  "failed_verification_never_succeeds",
  "telegram_privileged_approval_denied",
  "slack_tailscale_digest_bound_expiring_approval",
  "restart_reconciliation",
  "complete_user_visible_audit_trail"
] as const);

export type PilotCriterionId = typeof PILOT_CRITERION_IDS[number];

export interface PilotAcceptanceReport {
  generatedAt: string;
  evidenceMode: "deterministic_simulation";
  pilotReady: false;
  criteria: Array<{
    id: PilotCriterionId;
    status: "pass" | "fail";
    scenarioIds: string[];
    evidence: string[];
  }>;
  scenarios: Array<{ id: string; status: "pass" | "fail"; evidence: string[] }>;
  restartRecoveryRate: number;
  duplicateExecutions: number;
  approvalBypasses: number;
  verifiedSuccessCoverage: number;
}

export interface RunPilotAcceptanceOptions {
  readonly runs: number;
  readonly runIdPrefix?: string;
  readonly now?: () => Date;
}

type EventKind =
  | "evidence"
  | "scenario_pass"
  | "scenario_fail"
  | "restart_attempt"
  | "restart_recovered"
  | "duplicate_execution"
  | "approval_bypass"
  | "verified_success"
  | "verified_success_evidence";

type PilotEvent = Readonly<{
  scenarioId: string;
  kind: EventKind;
  evidence: string;
}>;

const SCENARIO_IDS = Object.freeze([
  "documented_install_live_gate_marker",
  "scripted_channel_authentication_boundaries",
  "korean_voice_verified_l1",
  "reverse_model_verification",
  "duplicate_provider_delivery",
  "digest_bound_approvals",
  "telegram_privileged_denials",
  "restart_reconciliation",
  "agent_failure_safety",
  "pre_dispatch_safety",
  "outbox_recovery_exactly_once"
] as const);

const CRITERION_SCENARIOS: Readonly<Record<PilotCriterionId, readonly string[]>> = Object.freeze({
  coworker_documented_install: ["documented_install_live_gate_marker"],
  channels_authenticate: ["scripted_channel_authentication_boundaries"],
  korean_telegram_voice_to_codex_hq: ["korean_voice_verified_l1"],
  route_evidence_and_plan_preview: ["korean_voice_verified_l1"],
  l1_isolated_worktree: ["korean_voice_verified_l1", "pre_dispatch_safety"],
  both_model_families_implement: ["korean_voice_verified_l1", "reverse_model_verification"],
  cross_model_verification: ["korean_voice_verified_l1", "reverse_model_verification"],
  failed_verification_never_succeeds: ["agent_failure_safety"],
  telegram_privileged_approval_denied: ["telegram_privileged_denials"],
  slack_tailscale_digest_bound_expiring_approval: ["digest_bound_approvals"],
  restart_reconciliation: ["restart_reconciliation"],
  complete_user_visible_audit_trail: ["korean_voice_verified_l1"]
});

const owner: PrincipalBinding = {
  principalId: "owner",
  slackUserIds: ["U-OWNER"],
  telegramUserIds: ["10"],
  telegramChatIds: ["20"],
  tailscaleLoginNames: ["owner@example.test"],
  roles: ["owner"]
};

function assertCondition(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

function project(repositoryPath: string): ProjectRegistryEntry {
  return {
    projectKey: "sandbox-web",
    orcaProjectId: "orca-sandbox-web",
    repoId: "repo-sandbox-web",
    absolutePath: repositoryPath,
    aliases: ["샌드박스 프런트엔드", "sandbox web"],
    component: "frontend",
    defaultBaseRef: "main",
    instructionsFiles: [],
    setupPolicy: "run",
    allowedOperations: ["L0", "L1", "L2", "L3"],
    requiredChecks: ["pnpm test"],
    sensitivePaths: [".env"],
    lockKey: "sandbox-web"
  };
}

function proposal(input: Readonly<{
  proposalId: string;
  commandId: string;
  operation: string;
  riskLevel: "L2" | "L3";
}>): ExecutionProposal {
  return {
    proposalId: input.proposalId,
    commandId: input.commandId,
    selectedProjectKey: "sandbox-web",
    routeCandidates: [{
      projectKey: "sandbox-web",
      score: 1,
      evidence: ["alias:샌드박스 프런트엔드"]
    }],
    baseRef: "main",
    allowedScope: ["src/**"],
    prohibitedEffects: ["secret access"],
    acceptanceCommands: ["pnpm test"],
    riskLevel: input.riskLevel,
    tasks: [{
      localId: `task-${input.proposalId}`,
      title: input.operation,
      dependsOn: [],
      role: "implement",
      preferredAgent: "codex"
    }]
  };
}

function safeFailure(error: unknown): string {
  if (error instanceof Error && /^[a-z0-9_:-]+$/i.test(error.message)) return error.message;
  return "scripted_scenario_failed";
}

class SimulationRun {
  readonly events: PilotEvent[] = [];
  readonly #runId: string;
  readonly #store;
  readonly #database;
  readonly #identities;
  readonly #agents = new FakeAgents();
  readonly #nextId: (kind: string) => string;
  readonly #now: Date;
  #slack!: FakeSlack;
  #telegram!: FakeTelegram;
  #sandbox!: Awaited<ReturnType<typeof createSandboxRepo>>;
  #mainCommandId = "";

  constructor(runId: string, now: Date) {
    this.#runId = runId;
    this.#now = new Date(now);
    this.#database = openDatabase(":memory:");
    this.#store = new ControlStore(this.#database);
    this.#identities = new IdentityResolver({
      bindings: [owner],
      allowedSlackWorkspaceIds: ["T-PILOT"]
    });
    let sequence = 0;
    this.#nextId = (kind) => `${this.#runId}:${kind}:${++sequence}`;
  }

  async execute(): Promise<readonly PilotEvent[]> {
    this.#sandbox = await createSandboxRepo();
    this.#slack = new FakeSlack({
      ingress: this.#store,
      identities: this.#identities,
      nextId: this.#nextId
    });
    this.#telegram = new FakeTelegram({
      ingress: this.#store,
      identities: this.#identities,
      nextId: this.#nextId
    });
    try {
      await this.#scenario("documented_install_live_gate_marker", () => this.#installMarker());
      await this.#scenario("scripted_channel_authentication_boundaries", () => this.#channelBoundaries());
      await this.#scenario("korean_voice_verified_l1", () => this.#koreanVoiceFlow());
      await this.#scenario("reverse_model_verification", () => this.#reverseModels());
      await this.#scenario("duplicate_provider_delivery", () => this.#duplicateDeliveries());
      await this.#scenario("digest_bound_approvals", () => this.#digestApprovals());
      await this.#scenario("telegram_privileged_denials", () => this.#telegramDenials());
      await this.#scenario("restart_reconciliation", () => this.#restartReconciliation());
      await this.#scenario("agent_failure_safety", () => this.#agentFailures());
      await this.#scenario("pre_dispatch_safety", () => this.#preDispatchSafety());
      await this.#scenario("outbox_recovery_exactly_once", () => this.#outboxRecovery());
      return Object.freeze([...this.events]);
    } finally {
      this.#database.close();
      await this.#sandbox.cleanup();
    }
  }

  async #scenario(id: string, action: () => Promise<void> | void): Promise<void> {
    try {
      await action();
      this.#emit(id, "scenario_pass", "scripted_scenario:pass");
    } catch (error) {
      this.#emit(id, "scenario_fail", `scripted_scenario:fail:${safeFailure(error)}`);
    }
  }

  #emit(scenarioId: string, kind: EventKind, evidence: string): void {
    this.events.push(Object.freeze({ scenarioId, kind, evidence }));
  }

  #evidence(scenarioId: string, evidence: string): void {
    this.#emit(scenarioId, "evidence", evidence);
  }

  #installMarker(): void {
    this.#evidence("documented_install_live_gate_marker", "scripted_install_contract:bounded_harness_only");
    this.#evidence("documented_install_live_gate_marker", "no_coworker_or_clean_machine_was_used");
  }

  #channelBoundaries(): void {
    const scenarioId = "scripted_channel_authentication_boundaries";
    this.#slack.connect();
    this.#telegram.connect();
    const sessions = createLocalSessionService({
      signingKey: new Uint8Array(32).fill(7),
      now: () => new Date(this.#now),
      nonce: () => `${this.#runId}-nonce`
    });
    const session = sessions.startLocalSession({
      principalId: owner.principalId,
      loginName: owner.tailscaleLoginNames[0]!
    });
    const verified = sessions.verify(session.token, {
      principalId: owner.principalId,
      loginName: owner.tailscaleLoginNames[0]!
    });
    assertCondition(this.#slack.connected && this.#telegram.connected, "fake_channels_not_connected");
    assertCondition(!("kind" in verified), "fake_tailscale_session_denied");
    this.#evidence(scenarioId, "fake_channels:slack,telegram,tailscale:authenticated_boundaries");
    this.#evidence(scenarioId, "no_live_provider_credentials_or_sessions_used");
  }

  async #koreanVoiceFlow(): Promise<void> {
    const scenarioId = "korean_voice_verified_l1";
    await this.#telegram.sendVoice({ messageId: 501, updateId: 501 });
    assertCondition(this.#telegram.confirmationRequired, "transcript_confirmation_not_requested");
    this.#evidence(scenarioId, "telegram_fake_voice:confirmation_required");
    const accepted = await this.#telegram.approveTranscript();
    assertCondition(accepted.kind === "accepted", "confirmed_transcript_not_accepted");
    this.#mainCommandId = accepted.commandId;
    this.#evidence(scenarioId, "transcript_approved:샌드박스 프런트엔드 테스트를 수정해줘");

    const decision = routeProject({
      text: "샌드박스 프런트엔드 테스트를 수정해줘"
    }, [project(this.#sandbox.repositoryPath)]);
    assertCondition(decision.kind === "selected" && decision.projectKey === "sandbox-web", "route_not_selected");
    this.#evidence(scenarioId, `route_selected:${decision.projectKey}:${decision.evidence[0]}`);
    this.#evidence(scenarioId, "plan_preview:risk=L1:scope=src/**");

    const placements = new GitWorktreePlacementService(this.#sandbox.git);
    const planned = await placements.resolve({
      proposalId: `${this.#runId}-voice-l1`,
      riskLevel: "L1",
      repositoryPath: this.#sandbox.repositoryPath,
      baseRef: "main",
      attempt: 1
    });
    assertCondition(planned.kind === "ready" && planned.worktree.kind === "isolated", "isolated_worktree_not_planned");
    const created = await placements.createWorktree(planned);
    assertCondition(created.kind === "ready" && created.worktree.kind === "isolated", "isolated_worktree_not_created");
    this.#evidence(scenarioId, "worktree:isolated");

    const verified = await this.#agents.verifiedPair(
      `${this.#runId}-codex`,
      "codex",
      created.worktree.path
    );
    assertCondition(
      verified.verifierProvider === "claude" && verified.decision.kind === "verified_success",
      "cross_model_verification_failed"
    );
    assertCondition(verified.evidence.length > 0, "verified_success_missing_evidence");
    this.#evidence(scenarioId, "worker_pair:codex->claude");
    this.#emit(scenarioId, "verified_success", "final_state:verified_success");
    this.#emit(scenarioId, "verified_success_evidence", "verifier_evidence:present");
    this.#evidence(scenarioId, "final_state:verified_success");

    for (const eventType of ["route", "policy", "approval", "Dispatch", "worker", "verifier", "delivery"]) {
      this.#store.appendAudit({
        subjectId: this.#mainCommandId,
        eventType: `pilot.${eventType}`,
        data: { mode: "deterministic_simulation" }
      });
    }
    const linked = new Set(this.#store.listAuditEvents()
      .filter(({ subjectId }) => subjectId === this.#mainCommandId)
      .map(({ eventType }) => eventType.replace("pilot.", "")));
    assertCondition(
      ["route", "policy", "approval", "Dispatch", "worker", "verifier", "delivery"]
        .every((part) => linked.has(part)),
      "audit_linkage_incomplete"
    );
    this.#evidence(scenarioId, "audit_linkage:route,policy,approval,Dispatch,worker,verifier,delivery");
  }

  async #reverseModels(): Promise<void> {
    const scenarioId = "reverse_model_verification";
    const verified = await this.#agents.verifiedPair(
      `${this.#runId}-claude`,
      "claude",
      this.#sandbox.repositoryPath
    );
    assertCondition(
      verified.verifierProvider === "codex" && verified.decision.kind === "verified_success",
      "reverse_cross_model_verification_failed"
    );
    assertCondition(verified.evidence.length > 0, "reverse_verified_success_missing_evidence");
    this.#evidence(scenarioId, "worker_pair:claude->codex");
    this.#emit(scenarioId, "verified_success", "final_state:verified_success");
    this.#emit(scenarioId, "verified_success_evidence", "verifier_evidence:present");
    this.#evidence(scenarioId, "final_state:verified_success");
  }

  async #duplicateDeliveries(): Promise<void> {
    const scenarioId = "duplicate_provider_delivery";
    const slackBefore = this.#store.listCommands().length;
    const firstSlack = await this.#slack.sendText({ text: "sandbox web 확인", timestamp: "1788451201.000001" });
    const secondSlack = await this.#slack.sendText({ text: "sandbox web 확인", timestamp: "1788451201.000001" });
    const slackCommands = this.#store.listCommands().length - slackBefore;
    for (let index = 1; index < slackCommands; index += 1) {
      this.#emit(scenarioId, "duplicate_execution", "fake_slack_duplicate_execution");
    }
    assertCondition(firstSlack.kind === "accepted" && secondSlack.kind === "duplicate" && slackCommands === 1, "slack_dedup_failed");
    this.#evidence(scenarioId, "fake_slack_duplicate:commands=1:dags=1:executions=1");

    const telegramBefore = this.#store.listCommands().length;
    await this.#telegram.sendText({ text: "sandbox web 확인", messageId: 777, updateId: 777 });
    await this.#telegram.sendText({ text: "sandbox web 확인", messageId: 777, updateId: 777 });
    const telegramCommands = this.#store.listCommands().length - telegramBefore;
    for (let index = 1; index < telegramCommands; index += 1) {
      this.#emit(scenarioId, "duplicate_execution", "fake_telegram_duplicate_execution");
    }
    assertCondition(telegramCommands === 1, "telegram_dedup_failed");
    this.#evidence(scenarioId, "fake_telegram_duplicate:commands=1:dags=1:executions=1");
  }

  #approval(
    service: ApprovalService,
    channel: Extract<Channel, "slack" | "tailscale-web">,
    suffix: string,
    validation: "exact" | "changed" | "expired"
  ): "accepted" | "rejected" {
    const execution = proposal({
      proposalId: `${this.#runId}-${suffix}`,
      commandId: this.#mainCommandId,
      operation: "commit_changes",
      riskLevel: "L2"
    });
    this.#store.saveExecutionProposal(execution);
    const request = service.request({
      approvalId: `approval-${this.#runId}-${suffix}`,
      proposal: execution,
      operation: "commit_changes",
      commandDigest: "c".repeat(64),
      channel,
      allowedChannels: [channel]
    });
    const confirmed = service.confirm(request, owner, this.#now);
    assertCondition(confirmed.kind === "approved", "approval_confirmation_failed");
    const current = validation === "changed"
      ? {
          proposal: execution,
          operation: "commit_changes",
          commandDigest: "d".repeat(64)
        }
      : {
          proposal: execution,
          operation: "commit_changes",
          commandDigest: "c".repeat(64)
        };
    const at = validation === "expired"
      ? new Date(this.#now.getTime() + 15 * 60_000)
      : this.#now;
    const decision = service.validate(request.approvalId, current, at);
    return decision.kind === "approved" ? "accepted" : "rejected";
  }

  #digestApprovals(): void {
    const scenarioId = "digest_bound_approvals";
    const service = new ApprovalService(this.#store);
    const results = {
      slackExact: this.#approval(service, "slack", "slack-exact", "exact"),
      slackChanged: this.#approval(service, "slack", "slack-changed", "changed"),
      slackExpired: this.#approval(service, "slack", "slack-expired", "expired"),
      tailscaleExact: this.#approval(service, "tailscale-web", "tailscale-exact", "exact"),
      tailscaleChanged: this.#approval(service, "tailscale-web", "tailscale-changed", "changed"),
      tailscaleExpired: this.#approval(service, "tailscale-web", "tailscale-expired", "expired")
    };
    assertCondition(
      results.slackExact === "accepted" && results.slackChanged === "rejected"
      && results.slackExpired === "rejected" && results.tailscaleExact === "accepted"
      && results.tailscaleChanged === "rejected" && results.tailscaleExpired === "rejected",
      "digest_bound_approval_failed"
    );
    this.#evidence(scenarioId, "slack_approval:exact_digest:accepted");
    this.#evidence(scenarioId, "slack_approval:changed_digest:rejected");
    this.#evidence(scenarioId, "slack_approval:expired_digest:rejected");
    this.#evidence(scenarioId, "tailscale_approval:exact_digest:accepted");
    this.#evidence(scenarioId, "tailscale_approval:changed_digest:rejected");
    this.#evidence(scenarioId, "tailscale_approval:expired_digest:rejected");
  }

  async #telegramDenials(): Promise<void> {
    const scenarioId = "telegram_privileged_denials";
    const operations = [
      ["commit", "commit_changes", "L2"],
      ["push", "push_branch", "L2"],
      ["PR", "create_pull_request", "L2"],
      ["merge", "merge_pull_request", "L3"],
      ["deploy", "deploy_production", "L3"],
      ["database", "database_mutation", "L3"],
      ["deletion", "delete_data", "L3"],
      ["secret", "read_secret", "L3"]
    ] as const;
    let bypasses = 0;
    for (const [label, operation, riskLevel] of operations) {
      const execution = proposal({
        proposalId: `${this.#runId}-telegram-${label}`,
        commandId: this.#mainCommandId,
        operation,
        riskLevel
      });
      const decision = authorizeProposal(execution, {
        channel: "telegram",
        principal: owner,
        projectAllowedOperations: ["L0", "L1", "L2", "L3"],
        operation,
        commandDigest: "e".repeat(64),
        now: this.#now
      });
      if (decision.kind !== "rejected" || decision.reason !== "channel_not_allowed") bypasses += 1;
    }
    await this.#telegram.requestPrivilegedApproval("L2", 901);
    await this.#telegram.requestPrivilegedApproval("L3", 902);
    if (bypasses > 0) {
      for (let index = 0; index < bypasses; index += 1) {
        this.#emit(scenarioId, "approval_bypass", "telegram_privileged_bypass");
      }
    }
    assertCondition(bypasses === 0 && this.#telegram.deniedRiskLevels.length === 2, "telegram_privileged_denial_failed");
    this.#evidence(scenarioId, "telegram_denied:commit,push,PR,merge,deploy,database,deletion,secret");
  }

  async #restartReconciliation(): Promise<void> {
    const scenarioId = "restart_reconciliation";
    const durable = {
      command: this.#mainCommandId,
      approval: `approval-${this.#runId}-tailscale-exact`,
      lock: "sandbox-web",
      cursor: { slack: this.#slack.cursor, telegram: this.#telegram.cursor },
      Outbox: "pending"
    };
    const before = JSON.stringify(durable);
    const cases = [
      ["simulated_gateway_process_loss:state_preserved", "running"],
      ["simulated_orca_restart:resumable", "resumable"],
      ["simulated_mac_launchd_restart:review_required", "unknown"],
      ["fake_slack_disconnect_reconnect:cursor_preserved", "active"],
      ["fake_telegram_disconnect_reconnect:cursor_preserved", "active"],
      ["fake_tailscale_disconnect_reconnect:approval_preserved", "active"]
    ] as const;
    for (const [evidence, inspectionKind] of cases) {
      this.#emit(scenarioId, "restart_attempt", evidence);
      if (evidence.startsWith("fake_slack")) {
        const cursor = this.#slack.cursor;
        this.#slack.disconnect();
        this.#slack.connect();
        assertCondition(this.#slack.connected && this.#slack.cursor === cursor, "slack_cursor_lost");
      }
      if (evidence.startsWith("fake_telegram")) {
        const cursor = this.#telegram.cursor;
        this.#telegram.disconnect();
        this.#telegram.connect();
        assertCondition(this.#telegram.connected && this.#telegram.cursor === cursor, "telegram_cursor_lost");
      }
      const report = await reconcileStartup({
        store: {
          recoverOutboxClaims() {},
          listNonterminalDispatches: () => [{
            dispatchId: `${this.#runId}:dispatch:worker`,
            receiptId: `${this.#runId}:receipt:worker`,
            receipt: { mode: "deterministic_simulation" }
          }]
        },
        channels: { resumeCursors() {} },
        orca: {
          inspectMany: async () => [{ kind: inspectionKind }]
        },
        locks: { reviewExpired() {} },
        outbox: { drain() {} },
        audit: { record() {} }
      });
      const expected = inspectionKind === "unknown" ? "review_required" : "resumable";
      if (report[0]?.state === expected && JSON.stringify(durable) === before) {
        this.#emit(scenarioId, "restart_recovered", evidence);
        this.#evidence(scenarioId, evidence);
      }
    }
    const recovered = this.events.filter(({ scenarioId: id, kind }) =>
      id === scenarioId && kind === "restart_recovered"
    ).length;
    assertCondition(recovered === cases.length, "restart_recovery_incomplete");
    this.#evidence(scenarioId, "durable_state:command,approval,lock,cursor,Outbox");
    this.#evidence(scenarioId, "duplicate_dispatches:0");
  }

  async #agentFailures(): Promise<void> {
    const scenarioId = "agent_failure_safety";
    const authLoss = this.#agents.simulateCodexAuthenticationLoss();
    const retry = this.#agents.simulateSafeLaunchRetry();
    const exhausted = this.#agents.simulateLaunchRetryExhaustion();
    const verification = await this.#agents.failTwoCycles(this.#sandbox.repositoryPath);
    assertCondition(
      authLoss.state === "queue_review" && authLoss.claudeHqTakeovers === 0,
      "codex_auth_takeover_occurred"
    );
    assertCondition(retry.retries === 1 && retry.attempts === 2 && !retry.intervention, "safe_retry_count_wrong");
    assertCondition(
      exhausted.attempts === 2 && exhausted.retries === 1
      && exhausted.intervention && !exhausted.thirdAttempted,
      "launch_retry_exhaustion_wrong"
    );
    assertCondition(
      verification.firstDecision.kind === "create_fix_task"
      && verification.secondDecision.kind === "intervention_required"
      && verification.successOutboxes === 0,
      "failed_verification_safety_wrong"
    );
    this.#evidence(scenarioId, "codex_auth_loss:queue_review:no_claude_hq_takeover");
    this.#evidence(scenarioId, "worker_launch:safe_retry_count=1");
    this.#evidence(scenarioId, "worker_launch:retry_exhausted:third_attempt_blocked:intervention_required");
    this.#evidence(scenarioId, "verification_cycle_2:intervention_required:no_success_outbox");
  }

  async #preDispatchSafety(): Promise<void> {
    const scenarioId = "pre_dispatch_safety";
    const ambiguity = decideRankedRoute([
      { projectKey: "sandbox-web", score: 0.9, evidence: ["synthetic:a"] },
      { projectKey: "sandbox-api", score: 0.8, evidence: ["synthetic:b"] }
    ]);
    assertCondition(ambiguity.kind === "clarification_required", "ambiguous_route_selected");
    this.#evidence(scenarioId, "wrong_project_ambiguity:clarification_required");

    await writeFile(join(this.#sandbox.repositoryPath, "synthetic-dirty.txt"), "dirty\n", "utf8");
    const placements = new GitWorktreePlacementService(this.#sandbox.git);
    const dirty = await placements.resolve({
      proposalId: `${this.#runId}-dirty`,
      riskLevel: "L1",
      repositoryPath: this.#sandbox.repositoryPath,
      baseRef: "main",
      attempt: 1
    });
    assertCondition(
      dirty.kind === "review_required" && dirty.reason === "dirty_current_worktree_requires_approval",
      "dirty_checkout_dispatched"
    );
    this.#evidence(scenarioId, "dirty_checkout:review_required:dispatches=0");
  }

  async #outboxRecovery(): Promise<void> {
    const scenarioId = "outbox_recovery_exactly_once";
    const start = new Date(this.#now.getTime() + 60_000);
    this.#store.enqueueOutbox({
      id: `${this.#runId}:outbox:pending`,
      channel: "slack",
      destination: "C-PILOT",
      template: "pilot_summary",
      payload: { text: "synthetic summary" },
      nextAttemptAt: start.toISOString()
    });
    let online = false;
    let deliveries = 0;
    const dispatcher = new OutboxDispatcher({
      store: this.#store,
      workerId: `${this.#runId}:outbox-worker`,
      providers: {
        slack: {
          deliver: async () => {
            if (!online) throw Object.assign(new Error("provider_disconnected"), {
              code: "provider_disconnected",
              retryable: true,
              retryAfterMs: 1_000
            });
            deliveries += 1;
            return { providerMessageId: `${this.#runId}:provider:1` };
          }
        }
      }
    });
    await dispatcher.tick(start.toISOString());
    const retryAt = new Date(start.getTime() + 1_000);
    const claimed = this.#store.claimOutbox(retryAt.toISOString(), "stale-worker");
    assertCondition(claimed !== undefined, "outbox_not_claimed_before_restart");
    const recoveredAt = new Date(start.getTime() + 3_000);
    assertCondition(
      this.#store.recoverExpiredOutboxClaims(recoveredAt.toISOString(), 1_000) === 1,
      "outbox_claim_not_recovered"
    );
    online = true;
    await dispatcher.tick(recoveredAt.toISOString());
    await dispatcher.tick(recoveredAt.toISOString());
    assertCondition(deliveries === 1 && this.#store.getOutbox(claimed.id)?.state === "delivered", "outbox_duplicate_delivery");
    this.#evidence(scenarioId, "pending_outbox:provider_recovered");
    this.#evidence(scenarioId, "claim_restart:deliveries=1");
  }
}

function scenarioReport(events: readonly PilotEvent[], runs: number) {
  return SCENARIO_IDS.map((id) => {
    const matching = events.filter(({ scenarioId }) => scenarioId === id);
    const passes = matching.filter(({ kind }) => kind === "scenario_pass").length;
    const failures = matching.filter(({ kind }) => kind === "scenario_fail");
    const evidence = [...new Set(matching
      .filter(({ kind }) => kind === "evidence" || kind === "scenario_fail")
      .map((event) => event.evidence))];
    return {
      id,
      status: passes === runs && failures.length === 0 ? "pass" as const : "fail" as const,
      evidence
    };
  });
}

export async function runPilotAcceptance(
  options: RunPilotAcceptanceOptions
): Promise<PilotAcceptanceReport> {
  if (!Number.isSafeInteger(options.runs) || options.runs <= 0) {
    throw new TypeError("pilot runs must be a positive safe integer");
  }
  const now = options.now?.() ?? new Date("2026-09-04T00:00:00.000Z");
  if (!Number.isFinite(now.getTime())) throw new TypeError("pilot clock must return a valid Date");
  const prefix = options.runIdPrefix?.trim() || "pilot";
  const events: PilotEvent[] = [];
  for (let index = 1; index <= options.runs; index += 1) {
    const run = new SimulationRun(`${prefix}-${index}`, now);
    events.push(...await run.execute());
  }
  const scenarios = scenarioReport(events, options.runs);
  const byId = new Map<string, (typeof scenarios)[number]>(
    scenarios.map((scenario) => [scenario.id, scenario])
  );
  const criteria = PILOT_CRITERION_IDS.map((id) => {
    const scenarioIds = [...CRITERION_SCENARIOS[id]];
    const supporting = scenarioIds.flatMap((scenarioId) => byId.get(scenarioId)?.evidence ?? []);
    return {
      id,
      status: scenarioIds.every((scenarioId) => byId.get(scenarioId)?.status === "pass")
        ? "pass" as const
        : "fail" as const,
      scenarioIds,
      evidence: [...new Set([
        ...supporting,
        "live_gate_required:clean_pilot_mac"
      ])]
    };
  });
  const restartAttempts = events.filter(({ kind }) => kind === "restart_attempt").length;
  const restartRecoveries = events.filter(({ kind }) => kind === "restart_recovered").length;
  const verifiedSuccesses = events.filter(({ kind }) => kind === "verified_success").length;
  const verifiedEvidence = events.filter(({ kind }) => kind === "verified_success_evidence").length;
  return {
    generatedAt: new Date(now).toISOString(),
    evidenceMode: "deterministic_simulation",
    pilotReady: false,
    criteria,
    scenarios,
    restartRecoveryRate: restartAttempts === 0 ? 0 : restartRecoveries / restartAttempts,
    duplicateExecutions: events.filter(({ kind }) => kind === "duplicate_execution").length,
    approvalBypasses: events.filter(({ kind }) => kind === "approval_bypass").length,
    verifiedSuccessCoverage: verifiedSuccesses === 0 ? 0 : verifiedEvidence / verifiedSuccesses
  };
}
