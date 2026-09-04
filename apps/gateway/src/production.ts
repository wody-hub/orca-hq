import { createHash } from "node:crypto";

import {
  ApprovalService,
  approvalOperationDigest,
  proposalDigest,
  type AuthenticatedPrincipal,
  type CommandEnvelope,
  type ExecutionProposal,
  type PersistedApproval,
  type PrincipalBinding
} from "@orca-hq/core";
import { HqResultSchema, type HqResult } from "@orca-hq/codex-hq";
import { OrcaClient, type OrcaClientOptions } from "@orca-hq/orca-adapter";
import { ControlStore, openDatabase, OutboxDispatcher, type OutboxDispatcherOptions } from "@orca-hq/persistence";
import { WorktreeLockService } from "@orca-hq/project-registry";
import type { ProjectRegistryEntry } from "@orca-hq/project-registry";
import {
  diagnoseServeConfiguration,
  type ServeConfiguration
} from "@orca-hq/tailscale-adapter";
import {
  ExecutionLifecycle,
  ExecutionService,
  VerificationService,
  type AssignmentArtifactStore,
  type ProviderCapabilities,
  type VerificationCompletionTargetResolution,
  type VerificationEvidencePort,
  type VerificationReport,
  type WorkerLaunchPolicy,
  type WorkerProviderRegistryPort,
  type WorktreePlacementPort
} from "@orca-hq/worker-routing";

import {
  createGateway,
  type Gateway,
  type GatewayCommand,
  type GatewayConfig,
  type GatewayConfigPort,
  type GatewayDiagnostic,
  type GatewayIngressPort,
  type GatewayTransactionPort
} from "./lifecycle.js";
import { wireAbortSignals } from "./main.js";
import { createCommandDashboard, createProjectDashboard } from "./dashboard.js";
import { createHttpApp, type ApprovalConfirmationPort, type DispatchActionPort, type GatewayHttpOptions } from "./http.js";
import { validateGatewayConfig } from "./config.js";
import { GatewayOutboxDriver } from "./outbox-driver.js";
import type {
  OrcaDispatchInspection,
  ReconcileDispatch,
  ReconcilePorts
} from "./reconcile.js";

export interface GatewayDispatchControlPort {
  stop(input: Readonly<{ dispatchId: string; idempotencyKey: string }>): Promise<boolean>;
  retry(input: Readonly<{ dispatchId: string; idempotencyKey: string }>): Promise<boolean>;
}

export interface GatewayProposalModelPort {
  plan(
    command: CommandEnvelope,
    projects: readonly ProjectRegistryEntry[]
  ): Promise<unknown>;
}

export interface GatewayExecutionComposition {
  readonly placements: WorktreePlacementPort;
  readonly assignmentArtifacts: AssignmentArtifactStore;
  readonly verificationEvidence: VerificationEvidencePort;
  readonly providers?: WorkerProviderRegistryPort | undefined;
  readonly providerCapabilities?: ProviderCapabilities | undefined;
  readonly workerLaunchPolicy?: WorkerLaunchPolicy | undefined;
}

/**
 * The concrete process composition boundary. Network/Keychain handles remain
 * injected, while durable storage, Orca, locking, execution, and outbox use
 * their public concrete implementations exactly once.
 */
export interface GatewayProductionDependencies {
  readonly config: GatewayConfigPort;
  /** A real Orca client is external I/O and may be injected; options construct the default client. */
  readonly orca: OrcaClientOptions | Pick<OrcaClient, "health" | "execute">;
  readonly execution: GatewayExecutionComposition;
  /** The external model only proposes; repository code validates and owns the HQ state flow. */
  readonly proposalModel: GatewayProposalModelPort;
  /** Host-validated local registry snapshot. */
  readonly projects: readonly ProjectRegistryEntry[];
  /** Provider-backed cursor recovery that completes before any ingress opens. */
  readonly channelRecovery: Readonly<{ resumeCursors(): Promise<void> }>;
  /** Legacy externally-hosted ingress. New hosts should supply httpOptions so production owns createHttpApp. */
  readonly http?: GatewayIngressPort;
  /** Keychain/session/identity-backed external boundary; production creates the HTTP app and loopback listener itself. */
  readonly httpOptions?: Omit<GatewayHttpOptions, "commands" | "projects" | "approvals" | "actions">;
  readonly slack: GatewayIngressPort;
  readonly telegram: GatewayIngressPort;
  readonly transactions: GatewayTransactionPort;
  readonly outbox: Omit<OutboxDispatcherOptions, "store">;
  /** Required external Orca control boundary. Production refuses to expose mutating routes without it. */
  readonly dispatchControl: GatewayDispatchControlPort;
  /** Injectable clock for approval expiry tests; production defaults to the system clock. */
  readonly now?: () => Date;
  readonly completionDestinations: Readonly<{
    slack: string;
    tailscaleWeb: string;
  }>;
  /** Host-owned observation of the active Tailscale Serve configuration. */
  readonly serveConfiguration?: Omit<ServeConfiguration, "gatewayHttpPort"> | undefined;
}

export interface GatewayProductionServices {
  readonly database: ReturnType<typeof openDatabase>;
  readonly store: ControlStore;
  readonly orca: Pick<OrcaClient, "health" | "execute">;
  readonly locks: WorktreeLockService;
  readonly execution: ExecutionService;
  readonly hq: Readonly<{ plan(command: CommandEnvelope): Promise<HqResult> }>;
  readonly outbox: OutboxDispatcher;
  /** Present only when production owns the HTTP app from httpOptions. */
  readonly httpApp?: ReturnType<typeof createHttpApp>;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonterminalDispatches(store: ControlStore): readonly ReconcileDispatch[] {
  const terminalStates = new Set(["worker_done", "launch_failed", "intervention_required"]);
  return Object.freeze(store.listTasks().flatMap((task) =>
    store.loadDispatchesForTask(task.id)
  ).flatMap((value) => {
    const dispatch = objectRecord(value);
    if (dispatch === undefined || typeof dispatch.id !== "string") return [];
    if (typeof dispatch.state === "string" && terminalStates.has(dispatch.state)) return [];
    const orcaDispatchId = typeof dispatch.orcaDispatchId === "string"
      ? dispatch.orcaDispatchId
      : undefined;
    return [Object.freeze({
      dispatchId: dispatch.id,
      receiptId: orcaDispatchId ?? dispatch.id,
      receipt: Object.freeze({ dispatchId: orcaDispatchId })
    })];
  }));
}

async function inspectOrcaDispatch(
  orca: Pick<OrcaClient, "execute">,
  receiptValue: unknown
): Promise<OrcaDispatchInspection> {
  const durableDispatchId = objectRecord(receiptValue)?.dispatchId;
  if (typeof durableDispatchId !== "string") return Object.freeze({ kind: "missing" });
  const receipt = await orca.execute({ kind: "show_worker", dispatchId: durableDispatchId });
  const result = objectRecord(receipt.result);
  const dispatch = objectRecord(result?.dispatch);
  const worker = objectRecord(result?.worker);
  const observation = objectRecord(result?.observation);
  if (
    dispatch?.id !== durableDispatchId
    || worker?.dispatch_id !== durableDispatchId
    || observation?.exactWorker !== true
  ) return Object.freeze({ kind: "inconsistent" });
  const state = typeof worker.state === "string" ? worker.state : "unknown";
  if (["ready", "starting", "running", "active", "working"].includes(state)) {
    return Object.freeze({ kind: "running" });
  }
  if (["worker_done", "completed", "released", "stopped"].includes(state)) {
    return Object.freeze({ kind: "completed" });
  }
  return Object.freeze({ kind: "unknown" });
}

function approvalPrincipal(principal: AuthenticatedPrincipal): PrincipalBinding {
  return {
    principalId: principal.principalId, slackUserIds: [], telegramUserIds: [],
    telegramChatIds: [], tailscaleLoginNames: [`dashboard:${principal.principalId}`], roles: [...principal.roles]
  };
}

type ApprovalResumeResult = Readonly<
  | { kind: "started" }
  | { kind: "changed" }
  | { kind: "denied" }
>;

function approvalAdapter(
  store: ControlStore,
  now: () => Date,
  resume: (approvalId: string) => Promise<ApprovalResumeResult>
): ApprovalConfirmationPort {
  const service = new ApprovalService(store);
  return {
    async confirmExisting(input) {
      try {
        const persisted = store.findApproval(input.approvalId);
        if (persisted === undefined) return { kind: "denied" };
        if (persisted.request.digest !== input.digest) return { kind: "changed" };
        // `request()` is deliberately not called here: this is a durable request,
        // not new user input, and persisted records include server-derived fields
        // rejected by ApprovalRequestInputSchema.  Restore only the redacted L3
        // display phrase required by the strict approval request contract.
        const operation = persisted.request.operation.trim().replace(/[\s-]+/g, "_").toUpperCase();
        const request = {
          ...persisted.request,
          ...(persisted.request.riskLevel === "L3" ? {
            operationPhrase: `APPROVE ${operation} ${persisted.request.digest.slice(0, 12).toUpperCase()}`
          } : {})
        };
        const decision = service.confirm(request, approvalPrincipal(input.principal), now(), input.phrase);
        if (decision.kind === "changed") return { kind: "changed" };
        if (decision.kind !== "approved") return { kind: "denied" };
        const confirmed = store.findApproval(input.approvalId)?.approval;
        if (confirmed === undefined) return { kind: "denied" };
        const resumed = await resume(input.approvalId);
        if (resumed.kind === "changed") return { kind: "changed" };
        return resumed.kind === "started"
          ? { kind: "approved", expiresAt: confirmed.expiresAt }
          : { kind: "denied" };
      } catch {
        // Invalid or stale durable content must never turn into an approval.
        return { kind: "denied" };
      }
    }
  };
}

function actionAdapter(store: ControlStore, control: GatewayDispatchControlPort): DispatchActionPort {
  const exists = (dispatchId: string): boolean => store.listTasks()
    .some((task) => store.loadDispatchesForTask(task.id).some((dispatch) => record(dispatch).id === dispatchId));
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const action = async (kind: "stop" | "retry", input: Readonly<{ dispatchId: string; idempotencyKey: string }>) => {
    if (!exists(input.dispatchId)) return { kind: "denied" } as const;
    const prior = store.listAuditEvents().find((event) =>
      record(event.data).idempotencyKey === input.idempotencyKey
    );
    if (prior !== undefined) {
      if (prior.subjectId !== input.dispatchId || prior.eventType !== `dispatch.${kind}_requested`) return { kind: "denied" } as const;
      return { kind: kind === "stop" ? "stopped" : "retried" } as const;
    }
    const accepted = await control[kind](input);
    if (!accepted) return { kind: "denied" } as const;
    store.appendAudit({ subjectId: input.dispatchId, eventType: `dispatch.${kind}_requested`, data: { idempotencyKey: input.idempotencyKey } });
    return { kind: kind === "stop" ? "stopped" : "retried" } as const;
  };
  return {
    async stop(input) {
      const result = await action("stop", input);
      return result.kind === "stopped" ? { kind: "stopped" as const } : { kind: "denied" as const };
    },
    async retry(input) {
      const result = await action("retry", input);
      return result.kind === "retried" ? { kind: "retried" as const } : { kind: "denied" as const };
    }
  };
}

function repositoryHq(
  model: GatewayProposalModelPort,
  projects: readonly ProjectRegistryEntry[]
): GatewayProductionServices["hq"] {
  return Object.freeze({
    async plan(command: CommandEnvelope): Promise<HqResult> {
      let result: HqResult;
      try {
        const parsed = HqResultSchema.safeParse(await model.plan(command, projects));
        if (!parsed.success) return Object.freeze({ kind: "failure", reason: "invalid_model_output" });
        result = parsed.data;
      } catch {
        return Object.freeze({ kind: "failure", reason: "invalid_model_output" });
      }
      if (result.kind === "proposal" && result.proposal.commandId !== command.commandId) {
        return Object.freeze({ kind: "failure", reason: "invalid_model_output" });
      }
      return result;
    }
  });
}

function commandDigest(command: CommandEnvelope): string {
  return createHash("sha256").update(JSON.stringify(command)).digest("hex");
}

const APPROVAL_WINDOW_MS = 15 * 60_000;

function approvalOperation(proposal: ExecutionProposal): Readonly<{
  operation: "commit_changes" | "deploy_production";
  targetEnvironment?: "production";
}> {
  return proposal.riskLevel === "L3"
    ? Object.freeze({ operation: "deploy_production", targetEnvironment: "production" })
    : Object.freeze({ operation: "commit_changes" });
}

function approvalValidation(
  proposal: ExecutionProposal,
  command: CommandEnvelope
) {
  const operation = approvalOperation(proposal);
  return {
    proposal,
    operation: operation.operation,
    commandDigest: commandDigest(command),
    ...(operation.targetEnvironment === undefined
      ? {}
      : { targetEnvironment: operation.targetEnvironment })
  };
}

function requireCompletionDestinations(
  value: unknown
): GatewayProductionDependencies["completionDestinations"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Gateway completion delivery configuration is unavailable");
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.slack !== "string"
    || candidate.slack.trim().length === 0
    || typeof candidate.tailscaleWeb !== "string"
    || candidate.tailscaleWeb.trim().length === 0
  ) {
    throw new Error("Gateway completion delivery configuration is unavailable");
  }
  return Object.freeze({
    slack: candidate.slack.trim(),
    tailscaleWeb: candidate.tailscaleWeb.trim()
  });
}

function verificationCompletionTarget(
  store: ControlStore,
  report: VerificationReport,
  now: () => Date,
  destinations: GatewayProductionDependencies["completionDestinations"]
): VerificationCompletionTargetResolution {
  const runValue = store.loadRunRecord(report.runId);
  const run = typeof runValue === "object" && runValue !== null && !Array.isArray(runValue)
    ? runValue
    : undefined;
  const commandId = typeof run?.commandId === "string" ? run.commandId : undefined;
  if (commandId === undefined) {
    return Object.freeze({ kind: "unresolved", reason: "run_not_durable" });
  }
  const command = store.listCommands().find((candidate) => candidate.commandId === commandId);
  if (command === undefined) {
    return Object.freeze({ kind: "unresolved", reason: "command_not_durable" });
  }
  let destination: string | undefined;
  if (command.channel === "telegram") {
    const separator = command.externalMessageId.lastIndexOf(":");
    destination = separator > 0 ? command.externalMessageId.slice(0, separator) : undefined;
  } else if (command.channel === "slack") {
    destination = destinations.slack;
  } else {
    destination = destinations.tailscaleWeb;
  }
  if (destination === undefined || destination.length === 0) {
    return Object.freeze({
      kind: "unresolved",
      reason: command.channel === "telegram"
        ? "invalid_external_message_id"
        : "destination_unavailable"
    });
  }
  return Object.freeze({
    commandId: command.commandId,
    channel: command.channel,
    destination,
    nextAttemptAt: now().toISOString()
  });
}

function productionCommandFlow(
  store: ControlStore,
  hq: GatewayProductionServices["hq"],
  execution: ExecutionService,
  projects: readonly ProjectRegistryEntry[],
  now: () => Date
) {
  const approvals = new ApprovalService(store);
  const runId = (proposalId: string): string => `run:${proposalId}`;
  const runState = (proposalId: string): string | undefined => {
    const run = store.loadRunRecord(runId(proposalId));
    return typeof run === "object" && run !== null && !Array.isArray(run)
      && typeof run.state === "string"
      ? run.state
      : undefined;
  };
  const projectFor = (proposal: ExecutionProposal): ProjectRegistryEntry | undefined =>
    projects.find((candidate) => candidate.projectKey === proposal.selectedProjectKey);
  const startAuthorized = async (
    proposal: ExecutionProposal,
    project: ProjectRegistryEntry,
    authorization: Readonly<
      | { kind: "automatic" }
      | { kind: "durable_approval"; approvalId: string }
    >
  ) => {
    if (
      (proposal.riskLevel === "L2" || proposal.riskLevel === "L3")
      !== (authorization.kind === "durable_approval")
    ) {
      throw new TypeError("production execution authorization does not match proposal risk");
    }
    const started = await execution.start({ authorization: "authorized", proposal, project });
    return { state: started.kind === "started" ? "active" : started.kind };
  };
  const recoverConsumedApproval = (
    persisted: PersistedApproval,
    proposal: ExecutionProposal,
    command: CommandEnvelope
  ): "authorized" | "changed" | "denied" => {
    if (
      persisted.state !== "consumed"
      || persisted.approval === undefined
      || runState(proposal.proposalId) !== "waiting_approval"
    ) {
      return "denied";
    }
    const current = approvalValidation(proposal, command);
    const currentProposalDigest = proposalDigest(proposal);
    const currentOperationDigest = approvalOperationDigest({
      proposalDigest: currentProposalDigest,
      operation: current.operation,
      commandDigest: current.commandDigest,
      ...(current.targetEnvironment === undefined
        ? {}
        : { targetEnvironment: current.targetEnvironment })
    });
    if (
      persisted.request.proposalDigest !== currentProposalDigest
      || persisted.request.digest !== currentOperationDigest
      || persisted.request.operation !== current.operation
      || persisted.request.commandDigest !== current.commandDigest
      || persisted.request.targetEnvironment !== current.targetEnvironment
      || persisted.approval.proposalDigest !== currentProposalDigest
      || persisted.approval.operationDigest !== currentOperationDigest
      || persisted.approval.channel !== persisted.request.channel
    ) {
      return "changed";
    }
    const approvedAt = Date.parse(persisted.approval.approvedAt);
    const expiresAt = Date.parse(persisted.approval.expiresAt);
    const currentTime = now().getTime();
    if (
      !Number.isFinite(currentTime)
      || !Number.isFinite(approvedAt)
      || !Number.isFinite(expiresAt)
      || expiresAt - approvedAt !== APPROVAL_WINDOW_MS
      || currentTime < approvedAt
      || currentTime >= expiresAt
    ) {
      return "denied";
    }
    return "authorized";
  };
  const resumeApproval = async (approvalId: string): Promise<ApprovalResumeResult> => {
    const persisted = store.findApproval(approvalId);
    if (persisted === undefined || (persisted.state !== "approved" && persisted.state !== "consumed")) {
      return { kind: "denied" };
    }
    const proposal = store.findExecutionProposal(persisted.request.proposal.proposalId);
    if (proposal === undefined) return { kind: "denied" };
    const command = store.listCommands().find((candidate) => candidate.commandId === proposal.commandId);
    if (command === undefined) return { kind: "denied" };
    const project = projectFor(proposal);
    if (project === undefined) return { kind: "denied" };
    if (persisted.state === "approved") {
      const validation = approvals.validate(
        approvalId,
        approvalValidation(proposal, command),
        now()
      );
      if (validation.kind === "changed") return { kind: "changed" };
      if (validation.kind !== "approved") return { kind: "denied" };
    } else {
      const recovery = recoverConsumedApproval(persisted, proposal, command);
      if (recovery === "changed") return { kind: "changed" };
      if (recovery !== "authorized") return { kind: "denied" };
    }
    const started = await startAuthorized(proposal, project, {
      kind: "durable_approval",
      approvalId
    });
    return started.state === "active" ? { kind: "started" } : { kind: "denied" };
  };
  return {
    resumeApproval,
    async accept(command: GatewayCommand) {
      const durable = store.listCommands().find((candidate) => candidate.commandId === command.commandId);
      if (durable === undefined) {
        store.appendAudit({
          subjectId: command.commandId,
          eventType: "command.planning_failed",
          data: { reason: "durable_command_missing" }
        });
        return { state: "failure" };
      }
      const result = await hq.plan(durable);
      if (result.kind !== "proposal") {
        if (result.kind === "failure") {
          store.appendAudit({
            subjectId: durable.commandId,
            eventType: "command.planning_failed",
            data: { reason: result.reason }
          });
        }
        return { state: result.kind };
      }
      const proposal = result.proposal;
      store.saveExecutionProposal(proposal);
      const project = projectFor(proposal);
      if (project === undefined) return { state: "review_required" };
      store.appendAudit({
        subjectId: durable.commandId,
        eventType: "command.route_selected",
        data: { proposalId: proposal.proposalId, projectKey: project.projectKey }
      });
      if (proposal.riskLevel === "L2" || proposal.riskLevel === "L3") {
        const approvalId = `approval:${proposal.proposalId}`;
        const existing = store.findApproval(approvalId);
        if (existing?.state === "approved") {
          const resumed = await resumeApproval(approvalId);
          return { state: resumed.kind === "started" ? "active" : "review_required" };
        }
        if (existing?.state === "consumed") {
          if (runState(proposal.proposalId) === "waiting_approval") {
            const resumed = await resumeApproval(approvalId);
            return { state: resumed.kind === "started" ? "active" : "review_required" };
          }
          return { state: runState(proposal.proposalId) ?? "review_required" };
        }
        if (existing?.state === "invalidated" || existing?.state === "expired") {
          return { state: "review_required" };
        }
        if (existing === undefined) {
          const operation = approvalOperation(proposal);
          approvals.request({
            approvalId,
            proposal,
            operation: operation.operation,
            commandDigest: commandDigest(durable),
            ...(operation.targetEnvironment === undefined
              ? {}
              : { targetEnvironment: operation.targetEnvironment }),
            channel: "tailscale-web",
            allowedChannels: ["slack", "tailscale-web"]
          });
        }
        store.appendAudit({
          subjectId: durable.commandId,
          eventType: "command.policy_approval_required",
          data: { proposalId: proposal.proposalId, approvalId, riskLevel: proposal.riskLevel }
        });
        store.saveRun({
          id: runId(proposal.proposalId),
          proposalId: proposal.proposalId,
          commandId: proposal.commandId,
          objective: durable.text,
          state: "waiting_approval",
          recoveryContext: { proposal, project }
        });
        store.appendAudit({
          subjectId: durable.commandId,
          eventType: "command.waiting_approval",
          data: { approvalId, riskLevel: proposal.riskLevel }
        });
        return { state: "waiting_approval" };
      }
      store.appendAudit({
        subjectId: durable.commandId,
        eventType: "command.policy_authorized",
        data: { proposalId: proposal.proposalId, riskLevel: proposal.riskLevel }
      });
      return startAuthorized(proposal, project, { kind: "automatic" });
    }
  };
}

export async function createProductionGateway(
  config: GatewayConfig,
  dependencies: GatewayProductionDependencies
): Promise<Readonly<{ gateway: Gateway; services: GatewayProductionServices }>> {
  const runtimeConfig = validateGatewayConfig(config);
  const now = dependencies.now ?? (() => new Date());
  const completionDestinations = requireCompletionDestinations(
    dependencies.completionDestinations
  );
  // Database construction is deliberately deferred to database.migrate: config/secret
  // validation is the first lifecycle operation and a rejected config leaves no handle.
  let services: GatewayProductionServices | undefined;
  let commandFlow: ReturnType<typeof productionCommandFlow> | undefined;
  let outboxDriver: GatewayOutboxDriver | undefined;
  let reconciliationTimestamp: string | undefined;
  let http: GatewayIngressPort | undefined = dependencies.http;
  const requireServices = (): GatewayProductionServices => {
    if (services === undefined) throw new Error("production services are unavailable before configuration validation");
    return services;
  };
  const reconciledAt = (): string => reconciliationTimestamp ??= now().toISOString();
  const orca = "execute" in dependencies.orca
    ? dependencies.orca
    : new OrcaClient(dependencies.orca);
  const exposedServices = {} as GatewayProductionServices;
  for (const key of ["database", "store", "orca", "locks", "execution", "hq", "outbox", "httpApp"] as const) {
    Object.defineProperty(exposedServices, key, { enumerable: true, get: () => requireServices()[key] });
  }
  const gateway = await createGateway(runtimeConfig, {
    config: dependencies.config,
    database: {
      async migrate() {
        // openDatabase owns WAL, foreign keys, and idempotent migration.
        let database: ReturnType<typeof openDatabase> | undefined;
        try {
          database = openDatabase(runtimeConfig.databasePath);
          const store = new ControlStore(database);
          const locks = new WorktreeLockService(store);
          const lifecycle = new ExecutionLifecycle({ store });
          const hq = repositoryHq(dependencies.proposalModel, dependencies.projects);
          const verification = new VerificationService({
            store,
            completionTarget: (report) => verificationCompletionTarget(
              store,
              report,
              now,
              completionDestinations
            )
          });
          const execution = new ExecutionService({
            orca,
            locks,
            lifecycle,
            placements: dependencies.execution.placements,
            assignmentArtifacts: dependencies.execution.assignmentArtifacts,
            verification: {
              service: verification,
              evidence: dependencies.execution.verificationEvidence
            },
            ...(dependencies.execution.providers === undefined
              ? {}
              : { providers: dependencies.execution.providers }),
            ...(dependencies.execution.providerCapabilities === undefined
              ? {}
              : { providerCapabilities: dependencies.execution.providerCapabilities }),
            ...(dependencies.execution.workerLaunchPolicy === undefined
              ? {}
              : { workerLaunchPolicy: dependencies.execution.workerLaunchPolicy })
          });
          const outbox = new OutboxDispatcher({ ...dependencies.outbox, store });
          outboxDriver = new GatewayOutboxDriver({
            dispatcher: outbox,
            now,
            pollMs: runtimeConfig.outboxPollMs,
            maxBackoffMs: runtimeConfig.outboxMaxBackoffMs,
            auditFailure() {
              store.appendAudit({
                subjectId: "gateway",
                eventType: "outbox.tick_failed",
                data: {}
              });
            }
          });
          commandFlow = productionCommandFlow(
            store,
            hq,
            execution,
            dependencies.projects,
            now
          );
          let httpApp: ReturnType<typeof createHttpApp> | undefined;
          if (dependencies.httpOptions !== undefined) {
            const app = createHttpApp({
              ...dependencies.httpOptions, commands: createCommandDashboard(store), projects: createProjectDashboard(store),
              approvals: approvalAdapter(store, now, commandFlow.resumeApproval),
              actions: actionAdapter(store, dependencies.dispatchControl)
            });
            httpApp = app;
            http = {
              async start() {
                await app.listen({ host: "127.0.0.1", port: runtimeConfig.httpPort });
              },
              async stopIngress() { await app.close(); }
            };
          }
          services = Object.freeze({ database, store, orca, locks, execution, hq, outbox,
            ...(httpApp === undefined ? {} : { httpApp }) });
          if (http === undefined) throw new Error("production HTTP security configuration is required");
        } catch (error) {
          if (database?.open) database.close();
          throw error;
        }
      },
      async checkpoint() {
        requireServices().database.pragma("wal_checkpoint(TRUNCATE)");
      },
      async close() {
        const database = requireServices().database;
        if (database.open) database.close();
      }
    },
    orca: { async check() { await orca.health(); } },
    reconcile: {
      store: {
        async recoverOutboxClaims() {
          const store = requireServices().store;
          store.recoverExpiredOutboxClaims(reconciledAt(), runtimeConfig.outboxClaimTtlMs);
          if (commandFlow === undefined) return;
          for (const approval of store.listApprovals()) {
            if (approval.state !== "approved" && approval.state !== "consumed") continue;
            try {
              await commandFlow.resumeApproval(approval.request.approvalId);
            } catch {
              // Durable approval and reconciliation audit remain authoritative.
            }
          }
        },
        listNonterminalDispatches() {
          return nonterminalDispatches(requireServices().store);
        }
      },
      channels: dependencies.channelRecovery,
      orca: {
        inspectDispatch: (receipt) => inspectOrcaDispatch(orca, receipt)
      },
      locks: {
        reviewExpired(report) {
          const { locks, store } = requireServices();
          const timestamp = reconciledAt();
          for (const project of dependencies.projects) {
            const lease = locks.get(project.lockKey);
            if (lease === undefined || lease.expiresAt > timestamp) continue;
            const classification = report.find((result) =>
              result.dispatchId === lease.dispatchId || result.receiptId === lease.dispatchId
            );
            store.appendAudit({
              subjectId: lease.dispatchId,
              eventType: "worktree_lock.reconciliation_reviewed",
              data: {
                lockKey: project.lockKey,
                state: classification?.state ?? "review_required"
              }
            });
          }
        }
      },
      outbox: {
        async drain() {
          const { outbox, store } = requireServices();
          const timestamp = reconciledAt();
          const dueCount = store.listOutbox().filter((message) =>
            message.state === "pending" && message.nextAttemptAt <= timestamp
          ).length;
          for (let index = 0; index < dueCount; index += 1) await outbox.tick(timestamp);
        }
      },
      audit: {
        record(event) {
          requireServices().store.appendAudit({
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
    } satisfies ReconcilePorts,
    http: {
      async start() {
        if (http === undefined) throw new Error("production HTTP security configuration is required");
        await http.start();
      },
      async stopIngress() { await http?.stopIngress(); }
    },
    diagnoseHttp: async () => {
      if (dependencies.serveConfiguration === undefined) return [];
      const diagnostic = diagnoseServeConfiguration({
        ...dependencies.serveConfiguration,
        gatewayHttpPort: runtimeConfig.httpPort
      });
      if (diagnostic.kind === "valid") return [];
      const safe = Object.freeze({
        component: "tailscale-serve",
        code: "serve_configuration_invalid",
        reasons: Object.freeze([...diagnostic.reasons])
      }) satisfies GatewayDiagnostic;
      requireServices().store.appendAudit({
        subjectId: "gateway",
        eventType: "gateway.serve_configuration_invalid",
        data: { reasons: [...diagnostic.reasons] }
      });
      return [safe];
    },
    outbox: {
      async start(reportDiagnostic) {
        if (outboxDriver === undefined) throw new Error("production Outbox driver is unavailable");
        await outboxDriver.start(reportDiagnostic);
      },
      async stop() {
        await outboxDriver?.stop();
      }
    },
    slack: dependencies.slack,
    telegram: dependencies.telegram,
    transactions: dependencies.transactions,
    commandFlow: {
      async accept(command) {
        requireServices();
        if (commandFlow === undefined) throw new Error("production command flow is unavailable");
        return commandFlow.accept(command);
      }
    },
    audit: {
      append(input) {
        // The initial "starting" audit occurs before config validation; there is
        // intentionally no durable database to write on a rejected configuration.
        if (services === undefined || !services.database.open) return;
        services.store.appendAudit({ ...input, data: {
          state: input.data.state,
          degradedChannels: [...input.data.degradedChannels]
        } });
      }
    }
  });
  // Creating this adapter here ensures command/dashboard queries derive from the
  // actual ControlStore rather than host-provided fixtures once the process starts.
  return Object.freeze({ gateway, services: exposedServices });
}

/** Starts the concrete composition after the host supplied its external adapters and secret port. */
export async function startProductionGateway(
  config: GatewayConfig,
  dependencies: GatewayProductionDependencies
): Promise<Readonly<{ gateway: Gateway; services: GatewayProductionServices }>> {
  const composition = await createProductionGateway(config, dependencies);
  const removeAbortWiring = wireAbortSignals(composition.gateway);
  try {
    await composition.gateway.start();
  } catch (error) {
    removeAbortWiring();
    throw error;
  }
  return composition;
}
