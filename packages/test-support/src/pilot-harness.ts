import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
} from "@orca-hq/project-registry";
import { createLocalSessionService } from "@orca-hq/tailscale-adapter";
import { GitWorktreePlacementService } from "@orca-hq/worker-routing";

import { FakeAgents, startDurablePilotExecution } from "./fake-agents.js";
import { FakeSlack } from "./fake-slack.js";
import { FakeTelegram } from "./fake-telegram.js";
import { createSandboxRepo } from "./sandbox-repo.js";
import { runProductionPilotFlow } from "./production-pilot.js";

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
  scenarios: Array<{
    id: string;
    status: "pass" | "fail";
    evidence: string[];
    measurements?: Readonly<Record<string, number>>;
  }>;
  restartRecoveryRate: number;
  duplicateExecutions: number;
  approvalBypasses: number;
  verifiedSuccessCoverage: number;
}

export interface RunPilotAcceptanceOptions {
  readonly runs: number;
  readonly runIdPrefix?: string;
  readonly now?: () => Date;
  readonly verifierEvidenceMode?:
    | "complete"
    | "missing_codex_to_claude"
    | "missing_claude_to_codex";
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
  | "verified_success_evidence"
  | "measurement";

type PilotEvent = Readonly<{
  scenarioId: string;
  kind: EventKind;
  evidence: string;
  value?: number;
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
  restart_reconciliation: ["restart_reconciliation", "outbox_recovery_exactly_once"],
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

function durableRestartSnapshot(store: ControlStore) {
  return structuredClone({
    commands: store.listCommands(),
    approvals: store.listApprovals(),
    lock: store.getWorktreeLock("pilot-restart"),
    outbox: store.listOutbox(),
    cursors: {
      slack: store.loadChannelCursor("slack"),
      telegram: store.loadChannelCursor("telegram")
    }
  });
}

export async function simulateDurableRestart() {
  const directory = await mkdtemp(join(tmpdir(), "orca-pilot-restart-"));
  const databasePath = join(directory, "control.sqlite");
  let firstDatabase: ReturnType<typeof openDatabase> | undefined;
  let reopenedDatabase: ReturnType<typeof openDatabase> | undefined;
  try {
    firstDatabase = openDatabase(databasePath);
    const firstStore = new ControlStore(firstDatabase);
    firstStore.insertCommand({
      commandId: "pilot-restart-command",
      idempotencyKey: "pilot:restart-command",
      channel: "slack",
      externalMessageId: "pilot-restart-message",
      principalId: "owner",
      receivedAt: "2026-09-04T00:00:00.000Z",
      text: "재시작 상태를 확인해줘"
    });
    const execution = await startDurablePilotExecution(firstStore, directory);
    const approvalProposal = proposal({
      proposalId: "pilot-restart-approval-proposal",
      commandId: "pilot-restart-command",
      operation: "commit_changes",
      riskLevel: "L2"
    });
    firstStore.saveExecutionProposal(approvalProposal);
    new ApprovalService(firstStore).request({
      approvalId: "pilot-restart-approval",
      proposal: approvalProposal,
      operation: "commit_changes",
      commandDigest: "a".repeat(64),
      channel: "slack",
      allowedChannels: ["slack", "tailscale-web"]
    });
    const lockResult = firstStore.acquireWorktreeLock({
      lockKey: "pilot-restart",
      commandId: "pilot-restart-command",
      taskId: "task:pilot-restart:inspect-one",
      projectKey: "pilot-restart",
      worktreePath: directory,
      branch: "main",
      dispatchId: "dispatch:pilot-restart:inspect-one:1",
      acquiredAt: "2026-09-04T00:00:00.000Z",
      heartbeatAt: "2026-09-04T00:00:00.000Z",
      expiresAt: "2026-09-04T01:00:00.000Z"
    });
    assertCondition(lockResult.kind === "acquired", "restart_lock_not_acquired");
    firstStore.enqueueOutbox({
      id: "pilot-restart-outbox",
      commandId: "pilot-restart-command",
      channel: "slack",
      destination: "C-PILOT",
      template: "pilot_summary",
      payload: { text: "synthetic restart summary" },
      nextAttemptAt: "2026-09-04T01:00:00.000Z"
    });
    firstStore.saveChannelCursor("slack", "1788451201.000001");
    firstStore.saveChannelCursor("telegram", 903);
    const before = durableRestartSnapshot(firstStore);
    const providerDispatchCallsBefore = execution.orca.calls
      .filter(({ kind }) => kind === "dispatch_worker").length;
    firstDatabase.close();
    firstDatabase = undefined;

    reopenedDatabase = openDatabase(databasePath);
    const store = new ControlStore(reopenedDatabase);
    const resumedCursors: Array<string | number> = [];
    const outbox = new OutboxDispatcher({
      store,
      workerId: "pilot-restart-outbox-worker",
      providers: {}
    });
    const report = await reconcileStartup({
      store: {
        recoverOutboxClaims() {
          store.recoverExpiredOutboxClaims("2026-09-04T00:10:00.000Z", 60_000);
        },
        listNonterminalDispatches() {
          return store.listTasks().flatMap((task) => store.loadDispatchesForTask(task.id))
            .filter((value) => {
              const state = (value as { state?: unknown }).state;
              return typeof state === "string"
                && !["worker_done", "launch_failed", "intervention_required"].includes(state);
            })
            .map((value) => {
              const dispatch = value as { id: string; orcaDispatchId?: string };
              return {
                dispatchId: dispatch.id,
                receiptId: dispatch.orcaDispatchId ?? dispatch.id,
                receipt: { dispatchId: dispatch.orcaDispatchId }
              };
            });
        }
      },
      channels: {
        resumeCursors() {
          const slack = store.loadChannelCursor("slack");
          const telegram = store.loadChannelCursor("telegram");
          if (slack !== undefined) resumedCursors.push(slack);
          if (telegram !== undefined) resumedCursors.push(telegram);
        }
      },
      orca: {
        async inspectMany(receipts) {
          return receipts.map((_, index) => index === 0
            ? { kind: "running" as const }
            : { kind: "unknown" as const });
        }
      },
      locks: { reviewExpired() { store.getWorktreeLock("pilot-restart"); } },
      outbox: { drain: () => outbox.tick("2026-09-04T00:10:00.000Z") },
      audit: {
        record(event) {
          store.appendAudit({
            subjectId: event.dispatchId,
            eventType: event.kind === "classified"
              ? "gateway.reconciliation_classified"
              : `gateway.reconciliation_${event.kind}`,
            data: event.kind === "classified"
              ? { receiptId: event.receiptId, state: event.state }
              : { receiptId: event.receiptId }
          });
        }
      }
    });
    const after = durableRestartSnapshot(store);
    const providerDispatchCallsAfter = execution.orca.calls
      .filter(({ kind }) => kind === "dispatch_worker").length;
    const uncertainWorkerReleases = execution.orca.calls
      .filter(({ kind }) => kind === "release_worker" || kind === "stop_worker").length;
    return Object.freeze({
      before,
      after,
      reconcileStates: Object.freeze(report.map(({ state }) => state)),
      providerDispatchCallsBefore,
      providerDispatchCallsAfter,
      uncertainWorkerReleases,
      resumedCursors: Object.freeze(resumedCursors)
    });
  } finally {
    if (firstDatabase?.open) firstDatabase.close();
    if (reopenedDatabase?.open) reopenedDatabase.close();
    await rm(directory, { recursive: true, force: true });
  }
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
  readonly #verifierEvidenceMode: NonNullable<RunPilotAcceptanceOptions["verifierEvidenceMode"]>;
  #slack!: FakeSlack;
  #telegram!: FakeTelegram;
  #sandbox!: Awaited<ReturnType<typeof createSandboxRepo>>;
  #mainCommandId = "";

  constructor(
    runId: string,
    now: Date,
    verifierEvidenceMode: NonNullable<RunPilotAcceptanceOptions["verifierEvidenceMode"]>
  ) {
    this.#runId = runId;
    this.#now = new Date(now);
    this.#verifierEvidenceMode = verifierEvidenceMode;
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
      nextId: this.#nextId,
      cursorStore: {
        load: () => this.#store.loadChannelCursor("slack") as string | undefined,
        save: (_channel, cursor) => this.#store.saveChannelCursor("slack", cursor)
      }
    });
    this.#telegram = new FakeTelegram({
      ingress: this.#store,
      identities: this.#identities,
      nextId: this.#nextId,
      cursorStore: {
        load: () => this.#store.loadChannelCursor("telegram") as number | undefined,
        save: (_channel, cursor) => this.#store.saveChannelCursor("telegram", cursor)
      }
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

  #measure(scenarioId: string, name: string, value: number): void {
    this.events.push(Object.freeze({ scenarioId, kind: "measurement", evidence: name, value }));
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

    const command = this.#store.listCommands().find(({ commandId }) => commandId === this.#mainCommandId);
    assertCondition(command !== undefined, "confirmed_command_not_durable");
    const production = await runProductionPilotFlow({
      sandbox: this.#sandbox,
      command,
      runIdentity: `${this.#runId}-voice-l1`,
      now: this.#now
    });
    assertCondition(
      production.proposal?.selectedProjectKey === "sandbox-web"
      && production.proposal.riskLevel === "L1",
      "route_not_selected"
    );
    this.#evidence(scenarioId, `route_selected:sandbox-web:${production.proposal.routeCandidates[0]?.evidence[0]}`);
    this.#evidence(scenarioId, `plan_preview:risk=${production.proposal.riskLevel}:scope=${production.proposal.allowedScope.join(",")}`);
    assertCondition(production.worktreeKind === "isolated", "isolated_worktree_not_created");
    this.#evidence(scenarioId, "worktree:isolated");
    assertCondition(
      production.implementationProvider === "codex"
      && production.verifierProvider === "claude"
      && production.decision.kind === "verified_success"
      && production.runState === "verified_success"
      && production.outboxState === "delivered",
      "cross_model_verification_failed"
    );
    this.#evidence(scenarioId, "worker_pair:codex->claude");
    this.#emit(scenarioId, "verified_success", "final_state:verified_success");
    const emittedEvidence = production.evidence.length > 0
      && this.#verifierEvidenceMode !== "missing_codex_to_claude";
    if (emittedEvidence) {
      this.#emit(scenarioId, "verified_success_evidence", "verifier_evidence:present");
    }
    assertCondition(emittedEvidence, "verified_success_missing_evidence");
    this.#evidence(scenarioId, "final_state:verified_success");
    assertCondition(
      ["route", "policy", "approval", "Dispatch", "worker", "verifier", "delivery"]
        .every((part) => production.linkedParts.includes(part)),
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
    this.#evidence(scenarioId, "worker_pair:claude->codex");
    this.#emit(scenarioId, "verified_success", "final_state:verified_success");
    const emittedEvidence = verified.evidence.length > 0
      && this.#verifierEvidenceMode !== "missing_claude_to_codex";
    if (emittedEvidence) {
      this.#emit(scenarioId, "verified_success_evidence", "verifier_evidence:present");
    }
    assertCondition(emittedEvidence, "reverse_verified_success_missing_evidence");
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
    this.#measure(scenarioId, "slackCommands", slackCommands);
    this.#evidence(scenarioId, "fake_slack_duplicate:commands=1");

    const telegramBefore = this.#store.listCommands().length;
    await this.#telegram.sendText({ text: "sandbox web 확인", messageId: 777, updateId: 777 });
    await this.#telegram.sendText({ text: "sandbox web 확인", messageId: 777, updateId: 777 });
    const telegramCommands = this.#store.listCommands().length - telegramBefore;
    for (let index = 1; index < telegramCommands; index += 1) {
      this.#emit(scenarioId, "duplicate_execution", "fake_telegram_duplicate_execution");
    }
    assertCondition(telegramCommands === 1, "telegram_dedup_failed");
    this.#measure(scenarioId, "telegramCommands", telegramCommands);
    this.#evidence(scenarioId, "fake_telegram_duplicate:commands=1");
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
    const durable = await simulateDurableRestart();
    const snapshotsMatch = JSON.stringify(durable.after) === JSON.stringify(durable.before);
    const duplicateDispatches = Math.max(
      durable.providerDispatchCallsAfter - durable.providerDispatchCallsBefore,
      0
    );
    const cases: Array<readonly [string, boolean]> = [
      ["simulated_gateway_process_loss:state_preserved", snapshotsMatch],
      ["simulated_orca_restart:resumable", durable.reconcileStates.includes("resumable")],
      ["simulated_mac_launchd_restart:review_required",
        durable.reconcileStates.includes("review_required") && durable.uncertainWorkerReleases === 0]
    ];

    const slackCursor = this.#store.loadChannelCursor("slack");
    this.#slack.disconnect();
    await this.#slack.reconnectFromCursor();
    cases.push(["fake_slack_disconnect_reconnect:cursor_preserved",
      this.#slack.connected && this.#slack.cursor === slackCursor]);

    const telegramCursor = this.#store.loadChannelCursor("telegram");
    this.#telegram.disconnect();
    await this.#telegram.reconnectFromCursor();
    cases.push(["fake_telegram_disconnect_reconnect:cursor_preserved",
      this.#telegram.connected && this.#telegram.cursor === telegramCursor]);

    const beforeApprovalCount = (durable.before as { approvals: readonly unknown[] }).approvals.length;
    const afterApprovalCount = (durable.after as { approvals: readonly unknown[] }).approvals.length;
    cases.push(["fake_tailscale_disconnect_reconnect:approval_preserved",
      beforeApprovalCount === 1 && afterApprovalCount === beforeApprovalCount]);

    for (const [evidence, recovered] of cases) {
      this.#emit(scenarioId, "restart_attempt", evidence);
      if (!recovered) continue;
      this.#emit(scenarioId, "restart_recovered", evidence);
      this.#evidence(scenarioId, evidence);
    }
    for (let index = 0; index < duplicateDispatches; index += 1) {
      this.#emit(scenarioId, "duplicate_execution", "restart_duplicate_dispatch");
    }
    this.#measure(scenarioId, "durableSnapshotsMatched", snapshotsMatch ? 1 : 0);
    this.#measure(scenarioId, "providerDispatchCallsBefore", durable.providerDispatchCallsBefore);
    this.#measure(scenarioId, "providerDispatchCallsAfter", durable.providerDispatchCallsAfter);
    this.#measure(scenarioId, "uncertainWorkerReleases", durable.uncertainWorkerReleases);
    const recovered = this.events.filter(({ scenarioId: id, kind }) =>
      id === scenarioId && kind === "restart_recovered"
    ).length;
    assertCondition(recovered === cases.length, "restart_recovery_incomplete");
    assertCondition(duplicateDispatches === 0, "restart_duplicate_dispatch");
  }

  async #agentFailures(): Promise<void> {
    const scenarioId = "agent_failure_safety";
    const authLoss = await this.#agents.simulateCodexAuthenticationLoss();
    const retry = await this.#agents.simulateSafeLaunchRetry();
    const exhausted = await this.#agents.simulateLaunchRetryExhaustion();
    const verification = await this.#agents.failTwoCycles(this.#sandbox.repositoryPath);
    assertCondition(
      authLoss.outcome.kind === "degraded"
      && authLoss.outcome.reason === "codex_unavailable"
      && authLoss.deferredCommandIds.length === 1
      && authLoss.openedAuthorityModels.every((model) => model === "gpt-5.6-sol"),
      "codex_auth_takeover_occurred"
    );
    assertCondition(
      retry.outcome.kind === "retried" && retry.providerLaunches === 2
      && retry.dispatchStates.join(",") === "launch_failed,running",
      "safe_retry_count_wrong"
    );
    assertCondition(
      exhausted.outcome.kind === "intervention_required"
      && exhausted.outcome.reason === "launch_retry_exhausted"
      && exhausted.providerLaunches === 2
      && exhausted.dispatchStates.join(",") === "launch_failed,intervention_required",
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
    const measurements = Object.fromEntries([...new Set(matching
      .filter(({ kind }) => kind === "measurement")
      .map(({ evidence: name }) => name))]
      .map((name) => [name, matching
        .filter((event) => event.kind === "measurement" && event.evidence === name)
        .reduce((total, event) => total + (event.value ?? 0), 0)]));
    return {
      id,
      status: passes === runs && failures.length === 0 ? "pass" as const : "fail" as const,
      evidence,
      ...(Object.keys(measurements).length === 0 ? {} : { measurements })
    };
  });
}

export function pilotAcceptancePassesGate(report: PilotAcceptanceReport): boolean {
  return report.evidenceMode === "deterministic_simulation"
    && report.pilotReady === false
    && report.criteria.length === 12
    && report.criteria.every(({ status }) => status === "pass")
    && report.scenarios.every(({ status }) => status === "pass")
    && report.duplicateExecutions === 0
    && report.approvalBypasses === 0
    && report.verifiedSuccessCoverage === 1
    && report.restartRecoveryRate >= 0.95;
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
  const verifierEvidenceMode = options.verifierEvidenceMode ?? "complete";
  const events: PilotEvent[] = [];
  for (let index = 1; index <= options.runs; index += 1) {
    const run = new SimulationRun(`${prefix}-${index}`, now, verifierEvidenceMode);
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
