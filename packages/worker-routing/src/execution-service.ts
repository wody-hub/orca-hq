import { createHash } from "node:crypto";

import {
  ExecutionProposalSchema,
  type ExecutionProposal,
  type ExecutionTask
} from "@orca-hq/core";
import type {
  OrcaClient,
  OrcaOperation,
  OrcaReceipt
} from "@orca-hq/orca-adapter";
import { parseOrcaOperationReceipt } from "@orca-hq/orca-adapter";
import {
  ProjectRegistryEntrySchema,
  type ProjectRegistryEntry
} from "@orca-hq/project-registry";

import type {
  AssignmentArtifact,
  AssignmentArtifactReference,
  AssignmentArtifactStore
} from "./assignment-artifacts.js";
import {
  ExecutionLifecycle,
  parseWorkerAssignment,
  type DispatchRecord,
  type LaunchFailureMessage,
  type RunRecord,
  type TaskRecord,
  type TrustedRepositorySnapshot,
  type WorkerAssignment,
  type WorkerMessage,
  type WorkerReleaseFailure
} from "./lifecycle.js";
import {
  type CurrentWorktreeApproval,
  type ReadyWorktreePlacement,
  type WorktreePlacement,
  type WorktreePlacementPort
} from "./worktree-placement.js";
import { ClaudeWorkerProvider } from "./claude-worker.js";
import { CodexWorkerProvider } from "./codex-worker.js";
import {
  DEFAULT_PROVIDER_CAPABILITIES,
  ProviderCapabilitiesSchema,
  ProviderInspectReceiptSchema,
  ProviderStartReceiptSchema,
  STRICT_WORKER_LAUNCH_POLICY,
  WorkerProviderError,
  WorkerProviderRegistry,
  assertAuthoritativeActiveWorkerInspection,
  assertAuthoritativeWorkerIdentityInspection,
  parseWorkerLaunchPolicy,
  providerInspectOrcaAuditReceipts,
  providerStartOrcaAuditReceipt,
  selectProvider,
  workerPrompt,
  type ProviderCapabilities,
  type ProviderInspectReceipt,
  type ProviderStartReceipt,
  type WorkerLaunchPolicy,
  type WorkerProvider,
  type WorkerProviderId
} from "./providers.js";
import {
  FixTaskSchema,
  VerificationCommandReceiptSchema,
  VerificationTaskSchema,
  type FixTask,
  type VerificationCommandReceipt,
  type VerificationInput,
  type VerificationReport,
  type VerificationTask
} from "./verifier.js";
import type { CompletionDecision } from "./completion-gate.js";

type MaybePromise<T> = T | Promise<T>;

export type AuthorizedProposal = Readonly<{
  authorization: "authorized";
  proposal: ExecutionProposal;
  project: ProjectRegistryEntry;
  currentWorktreeApproval?: CurrentWorktreeApproval | undefined;
}>;

export interface OrcaExecutionPort {
  execute(operation: OrcaOperation): Promise<OrcaReceipt>;
}

export interface WorkerProviderRegistryPort {
  get(id: WorkerProviderId): WorkerProvider;
}

export type EditingLeaseRequest = Readonly<{
  lockKey: string;
  commandId: string;
  taskId: string;
  projectKey: string;
  worktreePath: string;
  branch: string;
  dispatchId: string;
}>;

export type EditingLockAcquireResult =
  | Readonly<{ kind: "acquired"; lease?: unknown }>
  | Readonly<{ kind: "conflict"; lease: Readonly<{ dispatchId: string }> }>
  | Readonly<{
      kind: "review_required";
      reason: string;
      lease?: Readonly<{ dispatchId: string }> | undefined;
    }>;

export type EditingLockReleaseResult =
  | Readonly<{ kind: "released" }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "conflict"; lease: Readonly<{ dispatchId: string }> }>;

export interface EditingLockPort {
  acquire(input: EditingLeaseRequest): MaybePromise<EditingLockAcquireResult>;
  release(input: Readonly<{ lockKey: string; dispatchId: string }>): MaybePromise<EditingLockReleaseResult>;
}

export type ExecutionReviewRequired = WorktreePlacement & { kind: "review_required" } | Readonly<{
  kind: "review_required";
  reason: "editing_lock_conflict";
  dispatchId: string;
}> | Readonly<{
  kind: "review_required";
  reason: "editing_lock_reconciliation_required";
  dispatchId?: string | undefined;
}> | Readonly<{
  kind: "review_required";
  reason: "l0_requires_investigation_tasks";
}> | Readonly<{
  kind: "review_required";
  reason: "worker_release_failed";
  dispatchId: string;
}> | Readonly<{
  kind: "review_required";
  reason: "launch_terminal_unproven";
  dispatchId: string;
}> | Readonly<{
  kind: "review_required";
  reason: "assignment_artifact_cleanup_failed";
  dispatchId: string;
}> | Readonly<{
  kind: "review_required";
  reason: "verifier_repository_mutation";
  dispatchId: string;
}>;

export type ExecutionStart = ExecutionReviewRequired | Readonly<{
  kind: "started";
  runId: string;
  localRunId: string;
  taskIds: readonly string[];
  dispatchIds: readonly string[];
}>;

export type WorkerMessageResult =
  | Readonly<{ kind: "duplicate" }>
  | Readonly<{
      kind: "recorded";
      verificationRequired?: true | undefined;
      dispatched?: readonly string[] | undefined;
      investigationComplete?: true | undefined;
    }>
  | ExecutionReviewRequired;

export interface LaunchFailureInput {
  readonly dispatchId: string;
  readonly failureId: string;
  readonly evidence: LaunchFailureMessage["evidence"];
}

export type LaunchFailureResult =
  | Readonly<{ kind: "duplicate" }>
  | Readonly<{
      kind: "retried";
      dispatchId: string;
      retryOf: string;
    }>
  | Readonly<{
      kind: "intervention_required";
      reason:
        | "launch_retry_exhausted"
        | "replacement_not_conflict_free"
        | "assignment_artifact_cleanup_failed"
        | "launch_terminal_unproven";
      dispatchId: string;
    }>;

interface DispatchContext {
  readonly localId: string;
  readonly attempt: number;
  readonly assignment: WorkerAssignment;
  placement: ReadyWorktreePlacement;
  orcaDispatchId?: string;
  assignmentArtifact?: AssignmentArtifact;
  editingLeaseHeld: boolean;
  leaseReleaseBlocked: boolean;
}

type WorkerCompletionContext = Readonly<{
  outcome: "completed" | "failed";
  summary: string;
  auditReference: string;
}>;

interface TaskContext {
  readonly task: ExecutionTask;
  readonly localId: string;
  readonly initialAssignment: WorkerAssignment;
  readonly assignmentArtifactReference: AssignmentArtifactReference;
  readonly dispatches: DispatchContext[];
  readonly verificationTask?: VerificationTask | undefined;
  readonly fixTask?: FixTask | undefined;
  workerDone?: WorkerCompletionContext;
  orcaTaskId?: string;
}

interface RunContext {
  readonly authorized: AuthorizedProposal;
  readonly proposal: ExecutionProposal;
  readonly project: ProjectRegistryEntry;
  readonly localId: string;
  readonly tasks: TaskContext[];
  readonly tasksByProposalId: Map<string, TaskContext>;
  placement: ReadyWorktreePlacement;
  orcaRunId?: string;
}

export type ImplementationVerificationEvidence = Readonly<{
  changedFiles: readonly string[];
  gitDiff: Readonly<{ sha256: string; summary: string }>;
  testReceipts: readonly VerificationCommandReceipt[];
  auditReferences: readonly string[];
}>;

export interface VerificationEvidencePort {
  collectImplementation(input: Readonly<{
    run: RunRecord;
    task: TaskRecord;
    dispatch: DispatchRecord;
    workerResult: Readonly<{
      outcome: "completed" | "failed";
      summary: string;
      auditReference: string;
    }>;
  }>): MaybePromise<ImplementationVerificationEvidence>;
  collectVerifierCommands(input: Readonly<{
    run: RunRecord;
    task: TaskRecord;
    dispatch: DispatchRecord;
    verificationTask: VerificationTask;
  }>): MaybePromise<readonly VerificationCommandReceipt[]>;
  captureRepositorySnapshot(input: Readonly<{
    run: RunRecord;
    task: TaskRecord;
    dispatch: DispatchRecord;
    verificationTask: VerificationTask;
    phase: "before_verifier" | "after_verifier";
  }>): MaybePromise<TrustedRepositorySnapshot>;
}

export class VerifierRepositoryMutationError extends Error {
  readonly code = "verifier_repository_mutation";
  readonly retryable = false;

  constructor(dispatchId: string) {
    super(`Verifier Dispatch ${dispatchId} mutated its repository`);
    this.name = "VerifierRepositoryMutationError";
  }
}

export interface ExecutionVerificationPort {
  start(input: VerificationInput): MaybePromise<VerificationTask>;
  complete(report: VerificationReport): MaybePromise<CompletionDecision>;
  fixTaskFor(verificationTaskId: string): FixTask | undefined;
}

export type ExecutionVerificationOptions = Readonly<{
  service: ExecutionVerificationPort;
  evidence: VerificationEvidencePort;
}>;

interface DispatchLookup {
  readonly run: RunContext;
  readonly task: TaskContext;
  readonly dispatch: DispatchContext;
}

function runLocalId(proposalId: string): string {
  return `run:${proposalId}`;
}

function taskLocalId(proposalId: string, localId: string): string {
  return `task:${proposalId}:${localId}`;
}

function dispatchLocalId(proposalId: string, localId: string, attempt: number): string {
  return `dispatch:${proposalId}:${localId}:${attempt}`;
}

function objectiveFor(proposal: ExecutionProposal): string {
  return `${proposal.proposalId}: ${proposal.tasks.map(({ title }) => title).join("; ")}`;
}

function topologicalTasks(tasks: readonly ExecutionTask[]): readonly ExecutionTask[] {
  if (tasks.length === 0) throw new TypeError("execution proposal must contain at least one Task");
  const byId = new Map<string, ExecutionTask>();
  for (const task of tasks) {
    if (byId.has(task.localId)) throw new TypeError(`duplicate Task localId: ${task.localId}`);
    byId.set(task.localId, task);
  }
  for (const task of tasks) {
    const seenDependencies = new Set<string>();
    for (const dependency of task.dependsOn) {
      if (dependency === task.localId) throw new TypeError(`Task ${task.localId} depends on itself`);
      if (!byId.has(dependency)) {
        throw new TypeError(`Task ${task.localId} has unknown dependency ${dependency}`);
      }
      if (seenDependencies.has(dependency)) {
        throw new TypeError(`Task ${task.localId} repeats dependency ${dependency}`);
      }
      seenDependencies.add(dependency);
    }
  }

  const indegree = new Map(tasks.map((task) => [task.localId, task.dependsOn.length]));
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      const values = dependents.get(dependency) ?? [];
      values.push(task.localId);
      dependents.set(dependency, values);
    }
  }
  const orderById = new Map(tasks.map((task, index) => [task.localId, index]));
  const ready = tasks.filter((task) => task.dependsOn.length === 0).map(({ localId }) => localId);
  const sorted: ExecutionTask[] = [];
  while (ready.length > 0) {
    ready.sort((left, right) => (orderById.get(left) ?? 0) - (orderById.get(right) ?? 0));
    const currentId = ready.shift();
    if (currentId === undefined) break;
    const current = byId.get(currentId);
    if (current === undefined) throw new Error("Task DAG changed during sorting");
    sorted.push(current);
    for (const dependentId of dependents.get(currentId) ?? []) {
      const next = (indegree.get(dependentId) ?? 0) - 1;
      indegree.set(dependentId, next);
      if (next === 0) ready.push(dependentId);
    }
  }
  if (sorted.length !== tasks.length) throw new TypeError("execution proposal Task dependencies contain a cycle");
  return Object.freeze(sorted);
}

function immutableStrings(values: readonly string[]): readonly string[] {
  return Object.freeze([...values]);
}

function assignmentFor(
  proposal: ExecutionProposal,
  project: ProjectRegistryEntry,
  task: ExecutionTask,
  placement: ReadyWorktreePlacement,
  attempt: number
): WorkerAssignment {
  const localTaskId = taskLocalId(proposal.proposalId, task.localId);
  return parseWorkerAssignment({
    protocol: 1,
    project: {
      projectKey: project.projectKey,
      orcaProjectId: project.orcaProjectId
    },
    repo: {
      repoId: project.repoId ?? project.orcaProjectId,
      repositoryPath: project.absolutePath
    },
    worktree: placement.worktree,
    base: {
      ref: placement.baseRef,
      commit: placement.baseCommit
    },
    title: task.title,
    role: task.role,
    preferredAgent: task.preferredAgent,
    fileScope: proposal.allowedScope,
    acceptanceCommands: proposal.acceptanceCommands,
    prohibitedEffects: proposal.prohibitedEffects,
    taskId: localTaskId,
    dispatchId: dispatchLocalId(proposal.proposalId, task.localId, attempt),
    permissions: placement.permissions,
    nestedWorkers: "forbidden"
  });
}

function placementFromAssignment(assignment: WorkerAssignment): ReadyWorktreePlacement {
  return Object.freeze({
    kind: "ready",
    repositoryPath: assignment.repo.repositoryPath,
    baseRef: assignment.base.ref,
    baseCommit: assignment.base.commit,
    worktree: assignment.worktree,
    permissions: assignment.permissions,
    requiresEditingLease: assignment.permissions === "read-write"
  });
}

function recoveryPlacement(
  dispatches: readonly DispatchRecord[],
  activeLeaseDispatchIds: readonly string[]
): ReadyWorktreePlacement {
  const activeLeases = new Set(activeLeaseDispatchIds);
  const candidates = dispatches.map((dispatch) => Object.freeze({
    dispatch,
    assignment: parseWorkerAssignment(dispatch.assignment)
  }));
  const latest = (
    predicate: (candidate: (typeof candidates)[number]) => boolean
  ): (typeof candidates)[number] | undefined => {
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const candidate = candidates[index];
      if (candidate !== undefined && predicate(candidate)) return candidate;
    }
    return undefined;
  };
  const selected = latest(({ dispatch, assignment }) =>
    activeLeases.has(dispatch.id) && assignment.permissions === "read-write"
  ) ?? latest(({ assignment }) => assignment.permissions === "read-write")
    ?? candidates.at(-1);
  if (selected === undefined) throw new TypeError("durable Run has no recovery placement");
  return placementFromAssignment(selected.assignment);
}

function verificationTaskFromDurable(record: TaskRecord): VerificationTask {
  const value = record as unknown as Record<string, unknown>;
  return VerificationTaskSchema.parse({
    runId: value.runId,
    implementationTaskId: value.implementationTaskId,
    implementationDispatchId: value.implementationDispatchId,
    implementationProvider: value.implementationProvider,
    cycle: value.cycle,
    projectRoute: value.projectRoute,
    requestedScope: value.requestedScope,
    changedFiles: value.changedFiles,
    gitDiff: value.gitDiff,
    testReceipts: value.testReceipts,
    prohibitedEffects: value.prohibitedEffects,
    workerResult: value.workerResult,
    auditReferences: value.auditReferences,
    taskId: value.taskId,
    title: value.title,
    role: value.role,
    preferredAgent: value.preferredAgent,
    dependsOn: value.dependsOn,
    permissions: value.permissions,
    nestedWorkers: value.nestedWorkers,
    implementationProhibitedEffects: value.implementationProhibitedEffects,
    allowedActions: value.allowedActions
  });
}

function fixTaskFromDurable(record: TaskRecord): FixTask {
  const value = record as unknown as Record<string, unknown>;
  return FixTaskSchema.parse({
    taskId: value.taskId,
    runId: value.runId,
    sourceVerificationTaskId: value.sourceVerificationTaskId,
    implementationTaskId: value.implementationTaskId,
    title: value.title,
    role: value.role,
    preferredAgent: value.preferredAgent,
    dependsOn: value.dependsOn,
    cycle: value.cycle,
    findings: value.findings,
    requestedScope: value.requestedScope,
    prohibitedEffects: value.prohibitedEffects,
    permissions: value.permissions,
    nestedWorkers: value.nestedWorkers
  });
}

function runIdFrom(receipt: OrcaReceipt): string {
  const result = receipt.result as { runId?: unknown; run?: { id?: unknown } };
  const value = typeof result.runId === "string" ? result.runId : result.run?.id;
  if (typeof value !== "string" || value.length === 0) throw new Error("validated Run receipt has no Run ID");
  return value;
}

function taskIdFrom(receipt: OrcaReceipt, expectedRunId: string): string {
  const result = receipt.result as {
    taskId?: unknown;
    runId?: unknown;
    task?: { id?: unknown; run_id?: unknown };
  };
  const value = typeof result.taskId === "string" ? result.taskId : result.task?.id;
  if (typeof value !== "string" || value.length === 0) throw new Error("validated Task receipt has no Task ID");
  const runId = typeof result.runId === "string" ? result.runId : result.task?.run_id;
  if (runId !== expectedRunId) {
    throw Object.assign(new Error("validated Task receipt belongs to another Run"), {
      code: "orca_task_run_mismatch",
      retryable: false
    });
  }
  return value;
}

function releaseDispatchIdFrom(receipt: OrcaReceipt): string {
  const result = receipt.result as { dispatchId?: unknown; state?: unknown; verdict?: unknown };
  if (
    typeof result.dispatchId !== "string"
    || result.dispatchId.length === 0
    || result.state !== "released"
    || result.verdict !== "released"
  ) {
    throw Object.assign(new Error("validated release receipt has no Dispatch ID"), {
      code: "orca_release_receipt_invalid",
      retryable: false
    });
  }
  return result.dispatchId;
}

function stopDispatchIdFrom(receipt: OrcaReceipt): string {
  const result = receipt.result as { dispatchId?: unknown; state?: unknown; verdict?: unknown };
  if (
    typeof result.dispatchId !== "string"
    || result.dispatchId.length === 0
    || result.state !== "stopped"
    || result.verdict !== "stopped"
  ) {
    throw Object.assign(new Error("validated stop receipt has no stopped Dispatch"), {
      code: "orca_stop_receipt_invalid",
      retryable: false
    });
  }
  return result.dispatchId;
}

function boundProviderStartDispatchId(
  value: ProviderStartReceipt,
  expectedOrcaTaskId: string
): string | undefined {
  const candidate = value as Partial<ProviderStartReceipt>;
  if (
    typeof candidate.orcaDispatchId !== "string"
    || candidate.orcaDispatchId.length === 0
    || candidate.orcaTaskId !== expectedOrcaTaskId
    || candidate.orcaReceipt === undefined
  ) return undefined;
  try {
    const receipt = parseOrcaOperationReceipt("dispatch_worker", candidate.orcaReceipt);
    const result = receipt.result as { dispatchId?: unknown; taskId?: unknown };
    return result.dispatchId === candidate.orcaDispatchId
      && result.taskId === expectedOrcaTaskId
      ? candidate.orcaDispatchId
      : undefined;
  } catch {
    return undefined;
  }
}

function releaseFailure(error: unknown): WorkerReleaseFailure {
  const value = error as { code?: unknown; retryable?: unknown };
  return Object.freeze({
    code: typeof value?.code === "string" && value.code.trim().length > 0
      ? value.code
      : "orca_release_failed",
    retryable: value?.retryable === true
  });
}

function assignmentArtifactCleanupFailure(
  error: unknown,
  fallbackCode: string
): WorkerReleaseFailure {
  const value = error as { code?: unknown; retryable?: unknown };
  return Object.freeze({
    code: typeof value?.code === "string" && value.code.trim().length > 0
      ? value.code
      : fallbackCode,
    retryable: value?.retryable === true
  });
}

function taskSpec(task: TaskContext): string {
  const {
    project,
    repo,
    base,
    fileScope,
    acceptanceCommands,
    prohibitedEffects,
    permissions,
    nestedWorkers
  } = task.initialAssignment;
  return JSON.stringify({
    protocol: 1,
    task: {
      taskId: task.localId,
      localId: task.task.localId,
      title: task.task.title,
      role: task.task.role,
      preferredAgent: task.task.preferredAgent,
      dependsOn: task.task.dependsOn
    },
    authorization: {
      project,
      repo,
      base,
      fileScope,
      acceptanceCommands,
      prohibitedEffects,
      permissions,
      nestedWorkers
    },
    dispatchLinkage: {
      kind: "hq_receipt_linked_dispatch",
      taskId: task.localId
    },
    assignmentArtifact: {
      ...task.assignmentArtifactReference,
      format: "orca_hq_assignment_artifact_v1",
      requiredBeforeWork: true,
      integrity: "sha256_content",
      workerConsumption: "read_content_as_authoritative_assignment_before_work"
    }
  });
}

function lockBranch(placement: ReadyWorktreePlacement): string {
  return placement.worktree.branch ?? `detached:${placement.worktree.head}`;
}

function lockReview(result: Exclude<EditingLockAcquireResult, { kind: "acquired" }>): ExecutionReviewRequired {
  if (result.kind === "conflict") {
    return Object.freeze({
      kind: "review_required",
      reason: "editing_lock_conflict",
      dispatchId: result.lease.dispatchId
    });
  }
  return Object.freeze({
    kind: "review_required",
    reason: "editing_lock_reconciliation_required",
    ...(result.lease === undefined ? {} : { dispatchId: result.lease.dispatchId })
  });
}

export class ExecutionService {
  readonly #orca: OrcaExecutionPort;
  readonly #placements: WorktreePlacementPort;
  readonly #locks: EditingLockPort;
  readonly #lifecycle: ExecutionLifecycle;
  readonly #providers: WorkerProviderRegistryPort;
  readonly #providerCapabilities: ProviderCapabilities;
  readonly #workerLaunchPolicy: WorkerLaunchPolicy;
  readonly #assignmentArtifacts: AssignmentArtifactStore;
  readonly #verification: ExecutionVerificationOptions | undefined;
  readonly #dispatchLookup = new Map<string, DispatchLookup>();
  readonly #runs = new Map<string, RunContext>();

  constructor(options: Readonly<{
    orca: Pick<OrcaClient, "execute"> | OrcaExecutionPort;
    placements: WorktreePlacementPort;
    locks: EditingLockPort;
    lifecycle: ExecutionLifecycle;
    assignmentArtifacts: AssignmentArtifactStore;
    providers?: WorkerProviderRegistryPort | undefined;
    providerCapabilities?: ProviderCapabilities | undefined;
    workerLaunchPolicy?: WorkerLaunchPolicy | undefined;
    verification?: ExecutionVerificationOptions | undefined;
  }>) {
    this.#orca = options.orca;
    this.#placements = options.placements;
    this.#locks = options.locks;
    this.#lifecycle = options.lifecycle;
    this.#providers = options.providers ?? new WorkerProviderRegistry([
      new CodexWorkerProvider({ orca: options.orca }),
      new ClaudeWorkerProvider({ orca: options.orca })
    ]);
    this.#providerCapabilities = Object.freeze(ProviderCapabilitiesSchema.parse(
      options.providerCapabilities ?? DEFAULT_PROVIDER_CAPABILITIES
    ));
    this.#workerLaunchPolicy = parseWorkerLaunchPolicy(
      options.workerLaunchPolicy ?? STRICT_WORKER_LAUNCH_POLICY
    );
    this.#assignmentArtifacts = options.assignmentArtifacts;
    this.#verification = options.verification;
  }

  async start(input: AuthorizedProposal): Promise<ExecutionStart> {
    if (input.authorization !== "authorized") throw new TypeError("proposal is not authorized");
    const proposal = ExecutionProposalSchema.parse(input.proposal);
    const project = ProjectRegistryEntrySchema.parse(input.project);
    if (proposal.selectedProjectKey !== project.projectKey) {
      throw new TypeError("authorized proposal project does not match the Registry entry");
    }
    if (!project.allowedOperations.includes(proposal.riskLevel)) {
      throw new TypeError("authorized proposal risk is not permitted by the Registry entry");
    }
    const sortedTasks = topologicalTasks(proposal.tasks);
    if (proposal.riskLevel === "L0" && sortedTasks.some(({ role }) => role !== "investigate")) {
      return Object.freeze({ kind: "review_required", reason: "l0_requires_investigation_tasks" });
    }
    if (this.#runs.has(proposal.proposalId)) {
      throw new Error(`proposal ${proposal.proposalId} has already started`);
    }

    const placement = await this.#placements.resolve({
      proposalId: proposal.proposalId,
      riskLevel: proposal.riskLevel,
      repositoryPath: project.absolutePath,
      baseRef: proposal.baseRef ?? project.defaultBaseRef,
      currentWorktreeApproval: input.currentWorktreeApproval,
      attempt: 1
    });
    if (placement.kind !== "ready") return placement;

    const context = this.#context(input, proposal, project, sortedTasks, placement);
    for (const task of context.tasks) this.#providerFor(task.initialAssignment);
    const initialTasks = context.tasks.filter(({ task }) => task.dependsOn.length === 0);
    const permittedInitialTasks = placement.requiresEditingLease ? initialTasks.slice(0, 1) : initialTasks;
    const initialDispatches = permittedInitialTasks.map((task) =>
      this.#prepareDispatch(context, task, placement, 1)
    );

    let editingDispatch: DispatchContext | undefined;
    if (placement.requiresEditingLease) {
      editingDispatch = initialDispatches[0];
      if (editingDispatch === undefined) throw new Error("editing execution has no ready root Task");
      const acquired = await this.#acquire(context, editingDispatch);
      if (acquired.kind !== "acquired") return lockReview(acquired);
    }

    try {
      await this.#planRunAndTasks(context);
      for (const dispatch of initialDispatches) {
        await this.#persistDispatch(
          context,
          this.#taskForPreparedDispatch(context, dispatch),
          dispatch
        );
      }
      if (placement.worktree.kind === "isolated") {
        let materialized: WorktreePlacement;
        try {
          materialized = await this.#placements.createWorktree(placement);
        } catch (error) {
          if (editingDispatch !== undefined) {
            await this.#markIntervention(
              context,
              this.#taskForPreparedDispatch(context, editingDispatch),
              editingDispatch
            );
          }
          throw error;
        }
        if (materialized.kind !== "ready") {
          if (editingDispatch !== undefined) {
            await this.#markIntervention(
              context,
              this.#taskForPreparedDispatch(context, editingDispatch),
              editingDispatch
            );
            await this.#release(context, editingDispatch);
          }
          return materialized;
        }
      }
      await this.#createRunAndTasks(context);
      const dispatchIds: string[] = [];
      for (const dispatch of initialDispatches) {
        dispatchIds.push(await this.#launchWithIntervention(
          context,
          this.#taskForDispatch(context, dispatch),
          dispatch
        ));
      }
      this.#runs.set(proposal.proposalId, context);
      return Object.freeze({
        kind: "started",
        runId: context.orcaRunId as string,
        localRunId: context.localId,
        taskIds: immutableStrings(context.tasks.map(({ orcaTaskId }) => orcaTaskId as string)),
        dispatchIds: immutableStrings(dispatchIds)
      });
    } catch (error) {
      if (
        editingDispatch !== undefined
        && editingDispatch.orcaDispatchId === undefined
        && !editingDispatch.leaseReleaseBlocked
      ) {
        await this.#release(context, editingDispatch);
      }
      throw error;
    }
  }

  async recordWorkerMessage(message: WorkerMessage): Promise<WorkerMessageResult> {
    const lookup = await this.#lookupDispatch(message.dispatchId);
    if (lookup === undefined) throw new Error(`Dispatch ${message.dispatchId} is not known`);
    const launchRecoveryReview = await this.#reconcileLaunchGraph(lookup);
    if (launchRecoveryReview !== undefined) return launchRecoveryReview;
    const recorded = await this.#lifecycle.recordWorkerMessage(message, lookup.dispatch.localId);
    if (message.kind !== "worker_done") return recorded;
    const completedDispatch = this.#lifecycle.dispatch(lookup.dispatch.localId);
    if (
      completedDispatch.workerCompletion === undefined
      || completedDispatch.workerCompletionAuditReference === undefined
    ) {
      throw new Error(`Dispatch ${lookup.dispatch.localId} has no durable worker completion`);
    }
    lookup.task.workerDone ??= Object.freeze({
      outcome: completedDispatch.workerCompletion.outcome,
      summary: completedDispatch.workerCompletion.summary,
      auditReference: completedDispatch.workerCompletionAuditReference
    });

    const terminalDispatch = this.#lifecycle.dispatch(lookup.dispatch.localId);
    if (terminalDispatch.releaseFailure !== undefined) {
      if (recorded.kind === "duplicate") return recorded;
      return Object.freeze({
        kind: "review_required",
        reason: "worker_release_failed",
        dispatchId: message.dispatchId
      });
    }
    if (terminalDispatch.releaseReceipt === undefined) {
      const workerReleaseReview = await this.#releaseOrcaWorker(lookup);
      if (workerReleaseReview !== undefined) return workerReleaseReview;
    }

    if (lookup.task.verificationTask !== undefined && this.#verification !== undefined) {
      let durable = this.#lifecycle.dispatch(lookup.dispatch.localId);
      if (durable.repositorySnapshots?.after === undefined) {
        const snapshot = await this.#verification.evidence.captureRepositorySnapshot({
          run: this.#lifecycle.run(lookup.run.localId),
          task: this.#lifecycle.task(lookup.task.localId),
          dispatch: durable,
          verificationTask: lookup.task.verificationTask,
          phase: "after_verifier"
        });
        durable = await this.#lifecycle.recordVerifierRepositorySnapshotAfter(
          lookup.dispatch.localId,
          snapshot
        );
      }
      if (durable.repositorySnapshots?.mutated === true) {
        const cleanupReview = durable.assignmentArtifactCleanup === undefined
          ? await this.#cleanupAssignmentArtifact(lookup)
          : undefined;
        await this.#markIntervention(lookup.run, lookup.task, lookup.dispatch);
        if (cleanupReview !== undefined) return cleanupReview;
        return Object.freeze({
          kind: "review_required",
          reason: "verifier_repository_mutation",
          dispatchId: message.dispatchId
        });
      }
      if (durable.verificationCommands === undefined) {
        const commands = await this.#verification.evidence.collectVerifierCommands({
          run: this.#lifecycle.run(lookup.run.localId),
          task: this.#lifecycle.task(lookup.task.localId),
          dispatch: durable,
          verificationTask: lookup.task.verificationTask
        });
        const parsedCommands = commands.map((command) =>
          VerificationCommandReceiptSchema.parse(command)
        );
        await this.#lifecycle.recordVerificationCommands(lookup.dispatch.localId, parsedCommands);
      }
    }
    const releasedDispatch = this.#lifecycle.dispatch(lookup.dispatch.localId);
    if (releasedDispatch.assignmentArtifactCleanupFailure !== undefined) {
      if (recorded.kind === "duplicate") return recorded;
      return Object.freeze({
        kind: "review_required",
        reason: "assignment_artifact_cleanup_failed",
        dispatchId: message.dispatchId
      });
    }
    if (releasedDispatch.assignmentArtifactCleanup === undefined) {
      const artifactCleanupReview = await this.#cleanupAssignmentArtifact(lookup);
      if (artifactCleanupReview !== undefined) {
        await this.#lifecycle.transitionRun(lookup.run.localId, "intervention_required");
        return artifactCleanupReview;
      }
    }

    if (lookup.dispatch.placement.requiresEditingLease) {
      const released = await this.#release(lookup.run, lookup.dispatch);
      if (released.kind === "conflict") {
        return Object.freeze({
          kind: "review_required",
          reason: "editing_lock_conflict",
          dispatchId: released.lease.dispatchId
        });
      }
    }

    const ready = this.#readyPendingTasks(lookup.run);
    const permitted = lookup.run.placement.requiresEditingLease ? ready.slice(0, 1) : ready;
    const dispatched: string[] = [];
    for (const task of permitted) {
      const dispatch = this.#prepareDispatch(lookup.run, task, lookup.run.placement, 1);
      if (dispatch.placement.requiresEditingLease) {
        const acquired = await this.#acquire(lookup.run, dispatch);
        if (acquired.kind !== "acquired") {
          await this.#lifecycle.transitionTask(task.localId, "intervention_required");
          await this.#lifecycle.transitionRun(lookup.run.localId, "intervention_required");
          return lockReview(acquired);
        }
      }
      try {
        await this.#persistDispatch(lookup.run, task, dispatch);
      } catch (error) {
        if (dispatch.placement.requiresEditingLease) await this.#release(lookup.run, dispatch);
        throw error;
      }
      dispatched.push(await this.#launchWithIntervention(lookup.run, task, dispatch));
    }

    if (lookup.task.verificationTask !== undefined) {
      return recorded.kind === "duplicate"
        ? recorded
        : Object.freeze({ kind: "recorded", verificationRequired: true });
    }
    if (lookup.task.fixTask !== undefined) {
      if (this.#lifecycle.run(lookup.run.localId).state !== "awaiting_verification") {
        await this.#lifecycle.transitionRun(lookup.run.localId, "awaiting_verification");
      }
      const verifierDispatchId = await this.#startVerification(
        lookup,
        lookup.task.workerDone,
        lookup.task.fixTask.cycle
      );
      if (verifierDispatchId !== undefined) dispatched.push(verifierDispatchId);
    } else if (this.#allOriginalTasksDone(lookup.run)) {
      const originalImplementations = lookup.run.tasks.filter((candidate) =>
        candidate.verificationTask === undefined
        && candidate.fixTask === undefined
        && candidate.task.role === "implement"
      );
      if (originalImplementations.length === 0) {
        await this.#lifecycle.transitionRun(lookup.run.localId, "investigation_complete");
        return recorded.kind === "duplicate"
          ? recorded
          : Object.freeze({ kind: "recorded", investigationComplete: true });
      }
      await this.#lifecycle.ensureVerificationObligations(
        lookup.run.localId,
        originalImplementations.map((task) => {
          const dispatch = task.dispatches.at(-1);
          if (dispatch === undefined) {
            throw new Error(`implementation Task ${task.localId} has no Dispatch`);
          }
          return Object.freeze({
            rootImplementationTaskId: task.localId,
            currentImplementationTaskId: task.localId,
            implementationDispatchId: dispatch.localId,
            cycle: 0,
            status: "pending" as const,
            verificationTaskId: `${task.localId}:verify:0`
          });
        })
      );
      if (this.#lifecycle.run(lookup.run.localId).state !== "awaiting_verification") {
        await this.#lifecycle.transitionRun(lookup.run.localId, "awaiting_verification");
      }
      for (const task of originalImplementations) {
        const dispatch = task.dispatches.at(-1);
        if (dispatch === undefined || task.workerDone === undefined) continue;
        const verifierDispatchId = await this.#startVerification(
          { run: lookup.run, task, dispatch },
          task.workerDone,
          0
        );
        if (verifierDispatchId !== undefined) dispatched.push(verifierDispatchId);
      }
    }
    if (recorded.kind === "duplicate" && dispatched.length === 0) return recorded;
    return Object.freeze({
      kind: "recorded",
      verificationRequired: true,
      ...(dispatched.length === 0 ? {} : { dispatched: immutableStrings(dispatched) })
    });
  }

  async recordVerificationReport(report: VerificationReport): Promise<CompletionDecision> {
    if (this.#verification === undefined) {
      throw new Error("verification is not configured");
    }
    let run = [...this.#runs.values()].find(({ localId }) => localId === report.runId);
    let task = run?.tasks.find(({ verificationTask }) =>
      verificationTask?.taskId === report.verificationTaskId
    );
    if (run === undefined || task?.verificationTask === undefined) {
      const recovered = await this.#recoverVerificationContext(report);
      run = recovered?.run;
      task = recovered?.task;
    }
    if (run === undefined || task?.verificationTask === undefined) {
      throw new Error(`Verification Task ${report.verificationTaskId} is not known`);
    }
    const dispatch = task.dispatches.at(-1);
    if (dispatch === undefined) {
      throw new Error(`Verification Task ${report.verificationTaskId} has no Dispatch`);
    }
    const durableDispatch = this.#lifecycle.dispatch(dispatch.localId);
    if (durableDispatch.repositorySnapshots?.mutated === true) {
      throw new VerifierRepositoryMutationError(dispatch.orcaDispatchId ?? dispatch.localId);
    }
    if (durableDispatch.state !== "worker_done") {
      throw new Error(`verification Dispatch ${dispatch.localId} is not worker_done`);
    }
    if (
      durableDispatch.repositorySnapshots?.after === undefined
      || durableDispatch.repositorySnapshots.mutated !== false
    ) {
      throw new VerifierRepositoryMutationError(dispatch.orcaDispatchId ?? dispatch.localId);
    }
    if (
      durableDispatch.verificationCommands === undefined
      || JSON.stringify(durableDispatch.verificationCommands) !== JSON.stringify(report.commands)
    ) {
      throw new TypeError("verification report commands do not match durable Dispatch evidence");
    }
    const decision = await this.#verification.service.complete(report);
    const currentTaskState = (await this.#lifecycle.recoverTask(task.localId)
      ?? this.#lifecycle.task(task.localId)).state;
    const currentRunState = (await this.#lifecycle.recoverRun(run.localId)
      ?? this.#lifecycle.run(run.localId)).state;
    if (decision.kind === "verified_success") {
      if (currentTaskState !== "verified_success") {
        await this.#lifecycle.transitionTask(task.localId, "verified_success");
      }
    } else if (decision.kind === "intervention_required") {
      if (
        currentTaskState === "intervention_required"
        && currentRunState === "intervention_required"
      ) return decision;
      await this.#lifecycle.transitionTask(task.localId, "intervention_required");
      await this.#lifecycle.transitionRun(run.localId, "intervention_required");
    } else {
      if (currentTaskState !== "verification_failed") {
        await this.#lifecycle.transitionTask(task.localId, "verification_failed");
      }
      if (currentRunState !== "active") await this.#lifecycle.transitionRun(run.localId, "active");
      const fixTask = this.#verification.service.fixTaskFor(report.verificationTaskId);
      if (fixTask === undefined) {
        throw new Error(`Verification Task ${report.verificationTaskId} has no durable Fix Task`);
      }
      await this.#startFixTask(run, task, fixTask);
    }
    return decision;
  }

  async #recoverVerificationContext(report: VerificationReport): Promise<Readonly<{
    run: RunContext;
    task: TaskContext;
  }> | undefined> {
    const durableDispatches = await this.#lifecycle.recoverDispatchesForTask(
      report.verificationTaskId
    );
    const durableDispatch = durableDispatches.at(-1);
    if (durableDispatch === undefined) return undefined;
    await this.#hydrateRunGraph(durableDispatch.orcaDispatchId ?? durableDispatch.id);
    const run = [...this.#runs.values()].find(({ localId }) => localId === report.runId);
    const task = run?.tasks.find(({ verificationTask }) =>
      verificationTask?.taskId === report.verificationTaskId
    );
    return run === undefined || task?.verificationTask === undefined
      ? undefined
      : Object.freeze({ run, task });
  }

  async #startFixTask(
    run: RunContext,
    verification: TaskContext,
    fixTask: FixTask
  ): Promise<string> {
    if (verification.orcaTaskId === undefined) {
      throw new Error(`Verification Task ${verification.localId} has no Orca receipt`);
    }
    const localDispatchId = `dispatch:${fixTask.taskId}:1`;
    const placement: ReadyWorktreePlacement = Object.freeze({
      ...run.placement,
      permissions: "read-write" as const,
      requiresEditingLease: true
    });
    const assignment = parseWorkerAssignment({
      protocol: 1,
      project: {
        projectKey: run.project.projectKey,
        orcaProjectId: run.project.orcaProjectId
      },
      repo: {
        repoId: run.project.repoId ?? run.project.orcaProjectId,
        repositoryPath: run.project.absolutePath
      },
      worktree: placement.worktree,
      base: { ref: placement.baseRef, commit: placement.baseCommit },
      title: fixTask.title,
      role: fixTask.role,
      preferredAgent: fixTask.preferredAgent,
      fileScope: fixTask.requestedScope,
      acceptanceCommands: run.proposal.acceptanceCommands,
      prohibitedEffects: fixTask.prohibitedEffects,
      taskId: fixTask.taskId,
      dispatchId: localDispatchId,
      permissions: fixTask.permissions,
      nestedWorkers: fixTask.nestedWorkers
    });
    const executionTask: ExecutionTask = Object.freeze({
      localId: `fix:${fixTask.implementationTaskId}:${fixTask.cycle}`,
      title: fixTask.title,
      dependsOn: [verification.task.localId],
      role: "implement",
      preferredAgent: fixTask.preferredAgent
    });
    let task = run.tasks.find((candidate) => candidate.localId === fixTask.taskId);
    if (task === undefined) {
      task = {
        task: executionTask,
        localId: fixTask.taskId,
        initialAssignment: assignment,
        assignmentArtifactReference: this.#assignmentArtifacts.referenceFor(fixTask.taskId),
        dispatches: [],
        fixTask
      };
      run.tasks.push(task);
      run.tasksByProposalId.set(executionTask.localId, task);
    }
    const recoveredTask = await this.#lifecycle.recoverTask(fixTask.taskId);
    if (recoveredTask === undefined) {
      await this.#lifecycle.planTask(Object.freeze({
        id: fixTask.taskId,
        runId: run.localId,
        localId: executionTask.localId,
        title: executionTask.title,
        role: executionTask.role,
        preferredAgent: executionTask.preferredAgent,
        dependsOn: immutableStrings([verification.localId]),
        state: "planned"
      }));
    } else if (recoveredTask.orcaTaskId !== undefined) {
      task.orcaTaskId = recoveredTask.orcaTaskId;
    }
    if (task.orcaTaskId === undefined) {
      if (this.#lifecycle.task(fixTask.taskId).state !== "creating") {
        await this.#lifecycle.transitionTask(fixTask.taskId, "creating");
      }
      const taskReceipt = await this.#orca.execute({
        kind: "create_task",
        spec: taskSpec(task),
        dependencies: [verification.orcaTaskId]
      });
      if (run.orcaRunId === undefined) throw new Error(`Run ${run.localId} has no Orca receipt`);
      task.orcaTaskId = taskIdFrom(taskReceipt, run.orcaRunId);
      await this.#lifecycle.transitionTask(fixTask.taskId, "ready", {
        orcaTaskId: task.orcaTaskId,
        receipt: taskReceipt
      });
    }
    const recoveredDispatch = (await this.#lifecycle.recoverDispatchesForTask(fixTask.taskId)).at(-1);
    let dispatch: DispatchContext;
    if (recoveredDispatch !== undefined) {
      const existing = task.dispatches.find(({ localId }) => localId === recoveredDispatch.id);
      if (existing?.orcaDispatchId !== undefined) return existing.orcaDispatchId;
      if (recoveredDispatch.orcaDispatchId !== undefined) return recoveredDispatch.orcaDispatchId;
      if (recoveredDispatch.state !== "planned") {
        throw new Error(
          `Fix Dispatch ${recoveredDispatch.id} is not safely resumable from ${recoveredDispatch.state}`
        );
      }
      if (existing !== undefined) {
        dispatch = existing;
      } else {
        const recoveredAssignment = parseWorkerAssignment(recoveredDispatch.assignment);
        dispatch = {
          localId: recoveredDispatch.id,
          attempt: recoveredDispatch.attempt,
          assignment: recoveredAssignment,
          placement: placementFromAssignment(recoveredAssignment),
          ...(recoveredDispatch.assignmentArtifact === undefined
            ? {}
            : { assignmentArtifact: recoveredDispatch.assignmentArtifact }),
          editingLeaseHeld: false,
          leaseReleaseBlocked: recoveredDispatch.fenceFailure !== undefined
            || recoveredDispatch.releaseFailure !== undefined
        };
        task.dispatches.push(dispatch);
        this.#dispatchLookup.set(dispatch.localId, { run, task, dispatch });
      }
    } else {
      dispatch = {
        localId: localDispatchId,
        attempt: 1,
        assignment,
        placement,
        editingLeaseHeld: false,
        leaseReleaseBlocked: false
      };
    }
    if (dispatch.placement.requiresEditingLease && !dispatch.editingLeaseHeld) {
      const acquired = await this.#acquire(run, dispatch);
      if (acquired.kind !== "acquired") {
        await this.#lifecycle.transitionTask(fixTask.taskId, "intervention_required");
        await this.#lifecycle.transitionRun(run.localId, "intervention_required");
        throw new Error(`Fix Task ${fixTask.taskId} could not acquire its editing lease`);
      }
    }
    if (recoveredDispatch === undefined) await this.#persistDispatch(run, task, dispatch);
    return this.#launchWithIntervention(run, task, dispatch);
  }

  async #startVerification(
    implementation: DispatchLookup,
    completion: WorkerCompletionContext,
    cycle: number
  ): Promise<string | undefined> {
    if (this.#verification === undefined) return undefined;
    const verificationTaskId = `${implementation.task.localId}:verify:${cycle}`;
    const existingTask = implementation.run.tasks.find(({ verificationTask }) =>
      verificationTask?.implementationDispatchId === implementation.dispatch.localId
      && verificationTask.cycle === cycle
    );
    if (existingTask !== undefined) {
      const existingDispatch = existingTask.dispatches.at(-1);
      if (existingDispatch?.orcaDispatchId !== undefined) return existingDispatch.orcaDispatchId;
      if (existingTask.orcaTaskId === undefined) {
        if (this.#lifecycle.task(existingTask.localId).state !== "creating") {
          await this.#lifecycle.transitionTask(existingTask.localId, "creating");
        }
        if (implementation.task.orcaTaskId === undefined) {
          throw new Error(`implementation Task ${implementation.task.localId} has no Orca receipt`);
        }
        const taskReceipt = await this.#orca.execute({
          kind: "create_task",
          spec: taskSpec(existingTask),
          dependencies: [implementation.task.orcaTaskId]
        });
        if (implementation.run.orcaRunId === undefined) {
          throw new Error(`Run ${implementation.run.localId} has no Orca receipt`);
        }
        existingTask.orcaTaskId = taskIdFrom(taskReceipt, implementation.run.orcaRunId);
        await this.#lifecycle.transitionTask(existingTask.localId, "ready", {
          orcaTaskId: existingTask.orcaTaskId,
          receipt: taskReceipt
        });
      }
      if (existingDispatch !== undefined) {
        const durableDispatch = this.#lifecycle.dispatch(existingDispatch.localId);
        if (durableDispatch.state !== "planned") return undefined;
        return this.#launchWithIntervention(
          implementation.run,
          existingTask,
          existingDispatch
        );
      }
      const placement: ReadyWorktreePlacement = Object.freeze({
        ...implementation.run.placement,
        permissions: "read-only" as const,
        requiresEditingLease: false
      });
      const dispatch: DispatchContext = {
        localId: existingTask.initialAssignment.dispatchId,
        attempt: 1,
        assignment: existingTask.initialAssignment,
        placement,
        editingLeaseHeld: false,
        leaseReleaseBlocked: false
      };
      await this.#persistDispatch(implementation.run, existingTask, dispatch);
      return this.#launchWithIntervention(implementation.run, existingTask, dispatch);
    }
    await this.#lifecycle.setVerificationObligationVerifier({
      runId: implementation.run.localId,
      rootImplementationTaskId: this.#verificationRootTaskId(
        implementation.run,
        implementation.task
      ),
      currentImplementationTaskId: implementation.task.localId,
      implementationDispatchId: implementation.dispatch.localId,
      cycle,
      verificationTaskId
    });
    const implementationDispatch = this.#lifecycle.dispatch(implementation.dispatch.localId);
    const implementationTask = this.#lifecycle.task(implementation.task.localId);
    const provider = implementationDispatch.providerId;
    if (provider === undefined) {
      throw new Error(`implementation Dispatch ${implementationDispatch.id} has no provider`);
    }
    const workerResult = Object.freeze({ ...completion });
    const evidence = await this.#verification.evidence.collectImplementation({
      run: this.#lifecycle.run(implementation.run.localId),
      task: implementationTask,
      dispatch: implementationDispatch,
      workerResult
    });
    const verificationTask = await this.#verification.service.start({
      runId: implementation.run.localId,
      implementationTaskId: implementation.task.localId,
      implementationDispatchId: implementation.dispatch.localId,
      implementationProvider: provider,
      cycle,
      projectRoute: {
        projectKey: implementation.run.project.projectKey,
        orcaProjectId: implementation.run.project.orcaProjectId,
        repositoryPath: implementation.run.project.absolutePath
      },
      requestedScope: implementation.run.proposal.allowedScope,
      changedFiles: [...evidence.changedFiles],
      gitDiff: evidence.gitDiff,
      testReceipts: evidence.testReceipts.map((receipt) => ({ ...receipt })),
      prohibitedEffects: implementation.run.proposal.prohibitedEffects,
      workerResult,
      auditReferences: [...evidence.auditReferences]
    });
    const placement: ReadyWorktreePlacement = Object.freeze({
      ...implementation.run.placement,
      permissions: "read-only" as const,
      requiresEditingLease: false
    });
    const localTaskId = verificationTask.taskId;
    const localDispatchId = `dispatch:${verificationTask.taskId}:1`;
    const assignment = parseWorkerAssignment({
      protocol: 1,
      project: {
        projectKey: implementation.run.project.projectKey,
        orcaProjectId: implementation.run.project.orcaProjectId
      },
      repo: {
        repoId: implementation.run.project.repoId ?? implementation.run.project.orcaProjectId,
        repositoryPath: implementation.run.project.absolutePath
      },
      worktree: placement.worktree,
      base: {
        ref: placement.baseRef,
        commit: placement.baseCommit
      },
      title: verificationTask.title,
      role: verificationTask.role,
      preferredAgent: verificationTask.preferredAgent,
      fileScope: verificationTask.requestedScope,
      acceptanceCommands: verificationTask.testReceipts.map(({ command }) => command),
      prohibitedEffects: verificationTask.prohibitedEffects,
      taskId: localTaskId,
      dispatchId: localDispatchId,
      permissions: verificationTask.permissions,
      nestedWorkers: verificationTask.nestedWorkers
    });
    const executionTask: ExecutionTask = Object.freeze({
      localId: `verify:${implementation.task.task.localId}:${verificationTask.cycle}`,
      title: verificationTask.title,
      dependsOn: [implementation.task.task.localId],
      role: "verify",
      preferredAgent: verificationTask.preferredAgent
    });
    const task: TaskContext = {
      task: executionTask,
      localId: localTaskId,
      initialAssignment: assignment,
      assignmentArtifactReference: this.#assignmentArtifacts.referenceFor(localTaskId),
      dispatches: [],
      verificationTask
    };
    implementation.run.tasks.push(task);
    implementation.run.tasksByProposalId.set(executionTask.localId, task);
    await this.#lifecycle.planTask(Object.freeze({
      id: localTaskId,
      runId: implementation.run.localId,
      localId: executionTask.localId,
      title: executionTask.title,
      role: executionTask.role,
      preferredAgent: executionTask.preferredAgent,
      dependsOn: immutableStrings([implementation.task.localId]),
      state: "planned"
    }));
    await this.#lifecycle.transitionTask(localTaskId, "creating");
    if (implementation.task.orcaTaskId === undefined) {
      throw new Error(`implementation Task ${implementation.task.localId} has no Orca receipt`);
    }
    const taskReceipt = await this.#orca.execute({
      kind: "create_task",
      spec: taskSpec(task),
      dependencies: [implementation.task.orcaTaskId]
    });
    if (implementation.run.orcaRunId === undefined) {
      throw new Error(`Run ${implementation.run.localId} has no Orca receipt`);
    }
    task.orcaTaskId = taskIdFrom(taskReceipt, implementation.run.orcaRunId);
    await this.#lifecycle.transitionTask(localTaskId, "ready", {
      orcaTaskId: task.orcaTaskId,
      receipt: taskReceipt
    });
    const dispatch: DispatchContext = {
      localId: localDispatchId,
      attempt: 1,
      assignment,
      placement,
      editingLeaseHeld: false,
      leaseReleaseBlocked: false
    };
    await this.#persistDispatch(implementation.run, task, dispatch);
    return this.#launchWithIntervention(implementation.run, task, dispatch);
  }

  #verificationRootTaskId(run: RunContext, implementation: TaskContext): string {
    const seen = new Set<string>();
    let current = implementation;
    while (current.fixTask !== undefined) {
      if (seen.has(current.localId)) {
        throw new Error(`Fix Task lineage contains a cycle at ${current.localId}`);
      }
      seen.add(current.localId);
      const parentTaskId = current.fixTask.implementationTaskId;
      const parent = run.tasks.find((task) => task.localId === parentTaskId);
      if (parent === undefined) {
        throw new Error(`Fix Task ${current.localId} has no implementation parent ${parentTaskId}`);
      }
      current = parent;
    }
    return current.localId;
  }

  async recordLaunchFailure(input: LaunchFailureInput): Promise<LaunchFailureResult> {
    const lookup = await this.#lookupDispatch(input.dispatchId);
    if (lookup === undefined) throw new Error(`Dispatch ${input.dispatchId} is not known`);
    const launchRecoveryReview = await this.#reconcileLaunchGraph(lookup);
    if (launchRecoveryReview !== undefined) {
      return Object.freeze({
        kind: "intervention_required",
        reason: "launch_terminal_unproven",
        dispatchId: input.dispatchId
      });
    }
    let durable = this.#lifecycle.dispatch(lookup.dispatch.localId);
    if (!["running", "launch_failure_reserved", "launch_failed"].includes(durable.state)) {
      return Object.freeze({ kind: "duplicate" });
    }
    const message: LaunchFailureMessage = Object.freeze({
      kind: "launch_failure",
      messageId: input.failureId,
      dispatchId: input.dispatchId,
      evidence: Object.freeze({ ...input.evidence })
    });
    if (
      durable.state !== "running"
      && (
        durable.launchFailureId !== input.failureId
        || durable.orcaDispatchId !== input.dispatchId
      )
    ) {
      return Object.freeze({ kind: "duplicate" });
    }
    if (durable.state !== "launch_failed") {
      try {
        await this.#inspectLaunchFailureWorker(lookup);
      } catch {
        await this.#markIntervention(lookup.run, lookup.task, lookup.dispatch);
        return Object.freeze({
          kind: "intervention_required",
          reason: "launch_terminal_unproven",
          dispatchId: input.dispatchId
        });
      }
    }
    if (durable.state === "running") {
      try {
        await this.#lifecycle.reserveLaunchFailure(message, lookup.dispatch.localId);
      } catch (error) {
        if (this.#lifecycle.dispatch(lookup.dispatch.localId).state !== "running") {
          return Object.freeze({ kind: "duplicate" });
        }
        throw error;
      }
      durable = this.#lifecycle.dispatch(lookup.dispatch.localId);
    }
    if (durable.state === "launch_failure_reserved") {
      let fenceReceipt: OrcaReceipt;
      try {
        fenceReceipt = await this.#orca.execute({
          kind: "stop_worker",
          dispatchId: input.dispatchId
        });
        if (stopDispatchIdFrom(fenceReceipt) !== input.dispatchId) {
          throw Object.assign(new Error("stop receipt does not match the exact Dispatch"), {
            code: "orca_stop_receipt_mismatch",
            retryable: false
          });
        }
      } catch (error) {
        await this.#lifecycle.recordWorkerFence(
          lookup.dispatch.localId,
          input.dispatchId,
          { fenceFailure: releaseFailure(error) }
        );
        await this.#markIntervention(lookup.run, lookup.task, lookup.dispatch);
        return Object.freeze({
          kind: "intervention_required",
          reason: "launch_terminal_unproven",
          dispatchId: input.dispatchId
        });
      }
      await this.#lifecycle.recordLaunchFailure(
        message,
        lookup.dispatch.localId,
        fenceReceipt
      );
    }
    return this.#resumeLaunchFailure(input, lookup);
  }

  async #resumeLaunchFailure(
    input: LaunchFailureInput,
    lookup: DispatchLookup
  ): Promise<LaunchFailureResult> {
    const durable = this.#lifecycle.dispatch(lookup.dispatch.localId);
    if (
      durable.state !== "launch_failed"
      || durable.launchFailureId !== input.failureId
      || durable.orcaDispatchId !== input.dispatchId
    ) {
      return Object.freeze({ kind: "duplicate" });
    }
    const existingRetry = lookup.task.dispatches.find((candidate) =>
      this.#lifecycle.dispatch(candidate.localId).retryOf === input.dispatchId
    );
    if (existingRetry !== undefined) {
      const existing = this.#lifecycle.dispatch(existingRetry.localId);
      if (existing.orcaDispatchId !== undefined && existing.state === "running") {
        return Object.freeze({
          kind: "retried",
          dispatchId: existing.orcaDispatchId,
          retryOf: input.dispatchId
        });
      }
      if (existing.state !== "planned") {
        return Object.freeze({ kind: "duplicate" });
      }
      if (existingRetry.placement.requiresEditingLease && !existingRetry.editingLeaseHeld) {
        const acquired = await this.#acquire(lookup.run, existingRetry);
        if (acquired.kind !== "acquired") {
          await this.#lifecycle.transitionTask(lookup.task.localId, "intervention_required");
          await this.#lifecycle.transitionRun(lookup.run.localId, "intervention_required");
          return Object.freeze({
            kind: "intervention_required",
            reason: "replacement_not_conflict_free",
            dispatchId: input.dispatchId
          });
        }
      }
      if (existingRetry.placement.worktree.kind === "isolated") {
        let materialized: WorktreePlacement;
        try {
          materialized = await this.#placements.createWorktree(existingRetry.placement);
        } catch (error) {
          try {
            await this.#markIntervention(lookup.run, lookup.task, existingRetry);
          } finally {
            if (existingRetry.placement.requiresEditingLease) {
              await this.#release(lookup.run, existingRetry);
            }
          }
          throw error;
        }
        if (materialized.kind !== "ready") {
          await this.#markIntervention(lookup.run, lookup.task, existingRetry);
          if (existingRetry.placement.requiresEditingLease) {
            await this.#release(lookup.run, existingRetry);
          }
          return Object.freeze({
            kind: "intervention_required",
            reason: "replacement_not_conflict_free",
            dispatchId: input.dispatchId
          });
        }
      }
      const dispatchId = await this.#launchWithIntervention(
        lookup.run,
        lookup.task,
        existingRetry,
        input.dispatchId
      );
      return Object.freeze({
        kind: "retried",
        dispatchId,
        retryOf: input.dispatchId
      });
    }
    if (durable.assignmentArtifactCleanupFailure !== undefined) {
      await this.#markLaunchFailureIntervention(lookup);
      return Object.freeze({
        kind: "intervention_required",
        reason: "assignment_artifact_cleanup_failed",
        dispatchId: input.dispatchId
      });
    }
    if (durable.assignmentArtifactCleanup === undefined) {
      const artifactCleanupReview = await this.#cleanupAssignmentArtifact(lookup);
      if (artifactCleanupReview !== undefined) {
        await this.#markLaunchFailureIntervention(lookup);
        return Object.freeze({
          kind: "intervention_required",
          reason: "assignment_artifact_cleanup_failed",
          dispatchId: input.dispatchId
        });
      }
    }
    if (lookup.dispatch.placement.requiresEditingLease) await this.#release(lookup.run, lookup.dispatch);

    if (lookup.dispatch.attempt >= 2) {
      await this.#lifecycle.transitionDispatch(lookup.dispatch.localId, "intervention_required");
      await this.#lifecycle.transitionTask(lookup.task.localId, "intervention_required");
      await this.#lifecycle.transitionRun(lookup.run.localId, "intervention_required");
      return Object.freeze({
        kind: "intervention_required",
        reason: "launch_retry_exhausted",
        dispatchId: input.dispatchId
      });
    }

    const replacement = await this.#placements.resolve({
      proposalId: lookup.run.proposal.proposalId,
      riskLevel: lookup.run.proposal.riskLevel,
      repositoryPath: lookup.run.project.absolutePath,
      baseRef: lookup.run.proposal.baseRef ?? lookup.run.project.defaultBaseRef,
      pinnedBaseCommit: lookup.task.initialAssignment.base.commit,
      currentWorktreeApproval: lookup.run.authorized.currentWorktreeApproval,
      attempt: 2
    });
    if (replacement.kind !== "ready") {
      await this.#lifecycle.transitionTask(lookup.task.localId, "intervention_required");
      await this.#lifecycle.transitionRun(lookup.run.localId, "intervention_required");
      return Object.freeze({
        kind: "intervention_required",
        reason: "replacement_not_conflict_free",
        dispatchId: input.dispatchId
      });
    }

    const retry = this.#prepareDispatch(lookup.run, lookup.task, replacement, 2);
    if (replacement.requiresEditingLease) {
      const acquired = await this.#acquire(lookup.run, retry);
      if (acquired.kind !== "acquired") {
        await this.#lifecycle.transitionTask(lookup.task.localId, "intervention_required");
        await this.#lifecycle.transitionRun(lookup.run.localId, "intervention_required");
        return Object.freeze({
          kind: "intervention_required",
          reason: "replacement_not_conflict_free",
          dispatchId: input.dispatchId
        });
      }
    }
    try {
      await this.#persistDispatch(lookup.run, lookup.task, retry, input.dispatchId);
    } catch (error) {
      if (replacement.requiresEditingLease) await this.#release(lookup.run, retry);
      throw error;
    }
    if (replacement.worktree.kind === "isolated") {
      let materialized: WorktreePlacement;
      try {
        materialized = await this.#placements.createWorktree(replacement);
      } catch (error) {
        try {
          await this.#markIntervention(lookup.run, lookup.task, retry);
        } finally {
          if (replacement.requiresEditingLease) await this.#release(lookup.run, retry);
        }
        throw error;
      }
      if (materialized.kind !== "ready") {
        await this.#markIntervention(lookup.run, lookup.task, retry);
        if (replacement.requiresEditingLease) await this.#release(lookup.run, retry);
        return Object.freeze({
          kind: "intervention_required",
          reason: "replacement_not_conflict_free",
          dispatchId: input.dispatchId
        });
      }
    }
    const dispatchId = await this.#launchWithIntervention(
      lookup.run,
      lookup.task,
      retry,
      input.dispatchId
    );
    lookup.run.placement = replacement;
    return Object.freeze({ kind: "retried", dispatchId, retryOf: input.dispatchId });
  }

  async inspectWorker(dispatchId: string): Promise<ProviderInspectReceipt> {
    const lookup = await this.#lookupDispatch(dispatchId);
    if (lookup === undefined) throw new Error(`Dispatch ${dispatchId} is not known`);
    const orcaDispatchId = lookup.dispatch.orcaDispatchId;
    if (orcaDispatchId === undefined) {
      throw new Error(`Dispatch ${lookup.dispatch.localId} has no Orca receipt`);
    }
    if (lookup.task.orcaTaskId === undefined || lookup.run.orcaRunId === undefined) {
      throw new Error(`Dispatch ${lookup.dispatch.localId} has incomplete Orca ownership`);
    }
    const durableDispatch = this.#lifecycle.dispatch(lookup.dispatch.localId);
    if (durableDispatch.providerStartReceipt === undefined) {
      throw new Error(`Dispatch ${lookup.dispatch.localId} has no provider start receipt`);
    }
    const provider = this.#providerFor(lookup.dispatch.assignment);
    const receipt = this.#validatedInspectReceipt(
      provider.id,
      orcaDispatchId,
      lookup.task.orcaTaskId,
      lookup.run.orcaRunId,
      durableDispatch.providerStartReceipt,
      await provider.inspect(orcaDispatchId)
    );
    await this.#lifecycle.recordProviderInspection(lookup.dispatch.localId, receipt);
    return receipt;
  }

  async #reconcileLaunchGraph(
    lookup: DispatchLookup
  ): Promise<ExecutionReviewRequired | undefined> {
    const durableDispatch = this.#lifecycle.dispatch(lookup.dispatch.localId);
    const durableTask = this.#lifecycle.task(lookup.task.localId);
    if (
      durableDispatch.state === "intervention_required"
      && (durableDispatch.fenceReceipt !== undefined || durableDispatch.fenceFailure !== undefined)
    ) {
      return Object.freeze({
        kind: "review_required",
        reason: "launch_terminal_unproven",
        dispatchId: durableDispatch.orcaDispatchId ?? durableDispatch.id
      });
    }
    const transitional = durableDispatch.state === "launching"
      || (durableDispatch.state === "running" && durableTask.state !== "running");
    if (!transitional) return undefined;
    let recoveredInspection: ProviderInspectReceipt | undefined;
    try {
      if (
        lookup.task.orcaTaskId === undefined
        || lookup.run.orcaRunId === undefined
        || durableDispatch.providerId === undefined
        || durableDispatch.providerStartReceipt === undefined
        || durableDispatch.assignmentArtifact === undefined
        || durableDispatch.orcaDispatchId === undefined
      ) {
        throw new TypeError("durable launch identity is incomplete");
      }
      const provider = this.#providerFor(lookup.dispatch.assignment);
      const startReceipt = this.#validatedStartReceipt(
        provider.id,
        lookup.dispatch.assignment,
        lookup.task.orcaTaskId,
        lookup.run.orcaRunId,
        durableDispatch.assignmentArtifact,
        durableDispatch.providerStartReceipt
      );
      if (
        provider.id !== durableDispatch.providerId
        || startReceipt.orcaDispatchId !== durableDispatch.orcaDispatchId
      ) {
        throw new TypeError("durable launch provider identity is inconsistent");
      }
      const inspections = durableDispatch.providerInspectReceipts ?? [];
      if (inspections.length === 0) {
        recoveredInspection = this.#validatedInspectReceipt(
          provider.id,
          durableDispatch.orcaDispatchId,
          lookup.task.orcaTaskId,
          lookup.run.orcaRunId,
          startReceipt,
          await provider.inspect(durableDispatch.orcaDispatchId)
        );
      } else {
        for (const inspection of inspections) {
          this.#validatedInspectReceipt(
            provider.id,
            durableDispatch.orcaDispatchId,
            lookup.task.orcaTaskId,
            lookup.run.orcaRunId,
            startReceipt,
            inspection
          );
        }
      }
    } catch {
      return this.#interveneUnprovenLaunch(lookup);
    }
    if (recoveredInspection !== undefined) {
      await this.#lifecycle.recordProviderInspection(
        lookup.dispatch.localId,
        recoveredInspection
      );
    }
    await this.#lifecycle.recordLaunchSuccess(lookup.dispatch.localId);
    return undefined;
  }

  async #interveneUnprovenLaunch(lookup: DispatchLookup): Promise<ExecutionReviewRequired> {
    const current = this.#lifecycle.dispatch(lookup.dispatch.localId);
    const startReceipt = current.providerStartReceipt;
    const trustedDispatchId =
      lookup.task.orcaTaskId === undefined || startReceipt === undefined
        ? undefined
        : boundProviderStartDispatchId(startReceipt, lookup.task.orcaTaskId);
    let outcome: Readonly<
      | { fenceReceipt: OrcaReceipt }
      | { fenceFailure: WorkerReleaseFailure }
    >;
    if (trustedDispatchId !== undefined && trustedDispatchId === current.orcaDispatchId) {
      try {
        const fenceReceipt = await this.#orca.execute({
          kind: "stop_worker",
          dispatchId: trustedDispatchId
        });
        if (stopDispatchIdFrom(fenceReceipt) !== trustedDispatchId) {
          throw Object.assign(new Error("stop receipt does not match the exact Dispatch"), {
            code: "orca_stop_receipt_mismatch",
            retryable: false
          });
        }
        outcome = Object.freeze({ fenceReceipt });
      } catch (stopError) {
        outcome = Object.freeze({ fenceFailure: releaseFailure(stopError) });
      }
    } else {
      outcome = Object.freeze({
        fenceFailure: Object.freeze({
          code: "launch_identity_unproven",
          retryable: false
        })
      });
    }
    await this.#lifecycle.recordLaunchIntervention(lookup.dispatch.localId, outcome);
    return Object.freeze({
      kind: "review_required",
      reason: "launch_terminal_unproven",
      dispatchId: current.orcaDispatchId ?? current.id
    });
  }

  async #inspectLaunchFailureWorker(lookup: DispatchLookup): Promise<ProviderInspectReceipt> {
    const orcaDispatchId = lookup.dispatch.orcaDispatchId;
    if (orcaDispatchId === undefined) {
      throw new Error(`Dispatch ${lookup.dispatch.localId} has no Orca receipt`);
    }
    if (lookup.task.orcaTaskId === undefined || lookup.run.orcaRunId === undefined) {
      throw new Error(`Dispatch ${lookup.dispatch.localId} has incomplete Orca ownership`);
    }
    const durableDispatch = this.#lifecycle.dispatch(lookup.dispatch.localId);
    if (durableDispatch.providerStartReceipt === undefined) {
      throw new Error(`Dispatch ${lookup.dispatch.localId} has no provider start receipt`);
    }
    const provider = this.#providerFor(lookup.dispatch.assignment);
    const receipt = this.#validatedInspectReceipt(
      provider.id,
      orcaDispatchId,
      lookup.task.orcaTaskId,
      lookup.run.orcaRunId,
      durableDispatch.providerStartReceipt,
      await provider.inspect(orcaDispatchId),
      "launch_failure_identity"
    );
    await this.#lifecycle.recordProviderInspection(lookup.dispatch.localId, receipt);
    return receipt;
  }

  async #lookupDispatch(dispatchId: string): Promise<DispatchLookup | undefined> {
    const existing = this.#dispatchLookup.get(dispatchId);
    if (existing !== undefined) return existing;
    await this.#hydrateRunGraph(dispatchId);
    return this.#dispatchLookup.get(dispatchId);
  }

  async #hydrateRunGraph(dispatchId: string): Promise<void> {
    const graph = await this.#lifecycle.recoverRunGraphForDispatch(dispatchId);
    if (graph === undefined) return;
    const recovery = graph.run.recoveryContext;
    if (typeof recovery !== "object" || recovery === null) {
      throw new TypeError(`Run ${graph.run.id} has no recovery context`);
    }
    const recoveryValue = recovery as {
      proposal?: unknown;
      project?: unknown;
      currentWorktreeApproval?: CurrentWorktreeApproval;
    };
    const proposal = ExecutionProposalSchema.parse(recoveryValue.proposal);
    const project = ProjectRegistryEntrySchema.parse(recoveryValue.project);
    if (graph.dispatches.length === 0) {
      throw new TypeError(`Run ${graph.run.id} has no durable Dispatch`);
    }
    const placement = recoveryPlacement(graph.dispatches, graph.activeLeaseDispatchIds);
    const authorized: AuthorizedProposal = Object.freeze({
      authorization: "authorized",
      proposal,
      project,
      ...(recoveryValue.currentWorktreeApproval === undefined
        ? {}
        : { currentWorktreeApproval: recoveryValue.currentWorktreeApproval })
    });
    const context = this.#context(
      authorized,
      proposal,
      project,
      topologicalTasks(proposal.tasks),
      placement
    );
    if (graph.run.orcaRunId !== undefined) context.orcaRunId = graph.run.orcaRunId;
    const durableTasks = new Map(graph.tasks.map((task) => [task.id, task]));
    const activeLeases = new Set(graph.activeLeaseDispatchIds);
    const dispatchesByTask = new Map<string, DispatchRecord[]>();
    for (const durableDispatch of graph.dispatches) {
      const values = dispatchesByTask.get(durableDispatch.taskId) ?? [];
      values.push(durableDispatch);
      dispatchesByTask.set(durableDispatch.taskId, values);
    }

    const hydrateDispatches = (task: TaskContext): void => {
      const durableDispatches = dispatchesByTask.get(task.localId) ?? [];
      for (const durable of durableDispatches) {
        const assignment = parseWorkerAssignment(durable.assignment);
        const dispatch: DispatchContext = {
          localId: durable.id,
          attempt: durable.attempt,
          assignment,
          placement: placementFromAssignment(assignment),
          ...(durable.orcaDispatchId === undefined
            ? {}
            : { orcaDispatchId: durable.orcaDispatchId }),
          ...(durable.assignmentArtifact === undefined
            ? {}
            : { assignmentArtifact: durable.assignmentArtifact }),
          editingLeaseHeld: activeLeases.has(durable.id),
          leaseReleaseBlocked: durable.fenceFailure !== undefined
            || durable.releaseFailure !== undefined
        };
        task.dispatches.push(dispatch);
        const lookup = { run: context, task, dispatch };
        this.#dispatchLookup.set(dispatch.localId, lookup);
        if (dispatch.orcaDispatchId !== undefined) {
          this.#dispatchLookup.set(dispatch.orcaDispatchId, lookup);
        }
        if (durable.workerCompletion !== undefined) {
          if (
            durable.workerCompletionAuditReference === undefined
            || durable.orcaDispatchId !== durable.workerCompletion.dispatchId
          ) {
            throw new TypeError(`Dispatch ${durable.id} has invalid completion evidence`);
          }
          const completion = Object.freeze({
            outcome: durable.workerCompletion.outcome,
            summary: durable.workerCompletion.summary,
            auditReference: durable.workerCompletionAuditReference
          });
          if (
            task.workerDone !== undefined
            && JSON.stringify(task.workerDone) !== JSON.stringify(completion)
          ) {
            throw new TypeError(`Task ${task.localId} has conflicting completion evidence`);
          }
          task.workerDone = completion;
        }
      }
    };

    for (const task of context.tasks) {
      const durable = durableTasks.get(task.localId);
      if (durable === undefined) {
        throw new TypeError(`Run ${graph.run.id} is missing original Task ${task.localId}`);
      }
      if (durable.orcaTaskId !== undefined) task.orcaTaskId = durable.orcaTaskId;
      hydrateDispatches(task);
    }

    const originalTaskIds = new Set(context.tasks.map(({ localId }) => localId));
    for (const durable of graph.tasks) {
      if (originalTaskIds.has(durable.id)) continue;
      const durableValue = durable as unknown as Record<string, unknown>;
      const role = durableValue.role;
      const durableDispatch = dispatchesByTask.get(durable.id)?.[0];
      const isVerifier = role === "verify";
      const verificationTask = isVerifier ? verificationTaskFromDurable(durable) : undefined;
      const isFix = role === "implement"
        && typeof durableValue.sourceVerificationTaskId === "string";
      const fixTask = isFix ? fixTaskFromDurable(durable) : undefined;
      if (verificationTask === undefined && fixTask === undefined) {
        throw new TypeError(`Generated Task ${durable.id} has unknown ancestry`);
      }
      const generatedPlacement: ReadyWorktreePlacement = Object.freeze({
        ...placement,
        permissions: isVerifier ? "read-only" as const : "read-write" as const,
        requiresEditingLease: !isVerifier
      });
      const assignment = durableDispatch === undefined
        ? parseWorkerAssignment({
            protocol: 1,
            project: {
              projectKey: project.projectKey,
              orcaProjectId: project.orcaProjectId
            },
            repo: {
              repoId: project.repoId ?? project.orcaProjectId,
              repositoryPath: project.absolutePath
            },
            worktree: generatedPlacement.worktree,
            base: {
              ref: generatedPlacement.baseRef,
              commit: generatedPlacement.baseCommit
            },
            title: durable.title,
            role: isVerifier ? "verify" : "implement",
            preferredAgent: durable.preferredAgent,
            fileScope: verificationTask?.requestedScope ?? fixTask?.requestedScope ?? [],
            acceptanceCommands: verificationTask?.testReceipts.map(({ command }) => command)
              ?? proposal.acceptanceCommands,
            prohibitedEffects: verificationTask?.prohibitedEffects
              ?? fixTask?.prohibitedEffects
              ?? proposal.prohibitedEffects,
            taskId: durable.id,
            dispatchId: `dispatch:${durable.id}:1`,
            permissions: generatedPlacement.permissions,
            nestedWorkers: "forbidden"
          })
        : parseWorkerAssignment(durableDispatch.assignment);
      const executionTask: ExecutionTask = Object.freeze({
        localId: durable.localId,
        title: durable.title,
        dependsOn: [],
        role: isVerifier ? "verify" : "implement",
        preferredAgent: durable.preferredAgent
      });
      const task: TaskContext = {
        task: executionTask,
        localId: durable.id,
        initialAssignment: assignment,
        assignmentArtifactReference: this.#assignmentArtifacts.referenceFor(durable.id),
        dispatches: [],
        ...(verificationTask === undefined ? {} : { verificationTask }),
        ...(fixTask === undefined ? {} : { fixTask }),
        ...(durable.orcaTaskId === undefined ? {} : { orcaTaskId: durable.orcaTaskId })
      };
      context.tasks.push(task);
      context.tasksByProposalId.set(executionTask.localId, task);
      hydrateDispatches(task);
    }
    this.#runs.set(proposal.proposalId, context);
  }

  #context(
    authorized: AuthorizedProposal,
    proposal: ExecutionProposal,
    project: ProjectRegistryEntry,
    tasks: readonly ExecutionTask[],
    placement: ReadyWorktreePlacement
  ): RunContext {
    const taskContexts = tasks.map((task): TaskContext => ({
      task,
      localId: taskLocalId(proposal.proposalId, task.localId),
      initialAssignment: assignmentFor(proposal, project, task, placement, 1),
      assignmentArtifactReference: this.#assignmentArtifacts.referenceFor(
        taskLocalId(proposal.proposalId, task.localId)
      ),
      dispatches: []
    }));
    return {
      authorized,
      proposal,
      project,
      localId: runLocalId(proposal.proposalId),
      tasks: taskContexts,
      tasksByProposalId: new Map(taskContexts.map((task) => [task.task.localId, task])),
      placement
    };
  }

  async #planRunAndTasks(context: RunContext): Promise<void> {
    const run: RunRecord = Object.freeze({
      id: context.localId,
      proposalId: context.proposal.proposalId,
      commandId: context.proposal.commandId,
      objective: objectiveFor(context.proposal),
      state: "planned",
      recoveryContext: Object.freeze({
        proposal: context.proposal,
        project: context.project,
        ...(context.authorized.currentWorktreeApproval === undefined
          ? {}
          : { currentWorktreeApproval: context.authorized.currentWorktreeApproval })
      })
    });
    await this.#lifecycle.planRun(run);
    for (const task of context.tasks) {
      const record: TaskRecord = Object.freeze({
        id: task.localId,
        runId: context.localId,
        localId: task.task.localId,
        title: task.task.title,
        role: task.task.role,
        preferredAgent: task.task.preferredAgent,
        dependsOn: immutableStrings(task.task.dependsOn.map((dependency) =>
          taskLocalId(context.proposal.proposalId, dependency)
        )),
        state: "planned"
      });
      await this.#lifecycle.planTask(record);
    }
  }

  #prepareDispatch(
    context: RunContext,
    task: TaskContext,
    placement: ReadyWorktreePlacement,
    attempt: number
  ): DispatchContext {
    const localId = dispatchLocalId(context.proposal.proposalId, task.task.localId, attempt);
    return {
      localId,
      attempt,
      assignment: attempt === 1 && placement === context.placement
        ? task.initialAssignment
        : assignmentFor(context.proposal, context.project, task.task, placement, attempt),
      placement,
      editingLeaseHeld: false,
      leaseReleaseBlocked: false
    };
  }

  async #persistDispatch(
    context: RunContext,
    task: TaskContext,
    dispatch: DispatchContext,
    retryOf?: string
  ): Promise<void> {
    const record: DispatchRecord = Object.freeze({
      id: dispatch.localId,
      taskId: task.localId,
      attempt: dispatch.attempt,
      state: "planned",
      assignment: dispatch.assignment,
      ...(retryOf === undefined ? {} : { retryOf })
    });
    await this.#lifecycle.planDispatch(record);
    task.dispatches.push(dispatch);
    this.#dispatchLookup.set(dispatch.localId, { run: context, task, dispatch });
  }

  async #createRunAndTasks(context: RunContext): Promise<void> {
    await this.#lifecycle.transitionRun(context.localId, "creating");
    const runReceipt = await this.#orca.execute({
      kind: "create_run",
      objective: objectiveFor(context.proposal)
    });
    context.orcaRunId = runIdFrom(runReceipt);
    await this.#lifecycle.transitionRun(context.localId, "active", {
      orcaRunId: context.orcaRunId,
      receipt: runReceipt
    });

    for (const task of context.tasks) {
      await this.#lifecycle.transitionTask(task.localId, "creating");
      const dependencyIds = task.task.dependsOn.map((dependency) => {
        const dependencyTask = context.tasksByProposalId.get(dependency);
        if (dependencyTask?.orcaTaskId === undefined) {
          throw new Error(`dependency Task ${dependency} has no Orca receipt`);
        }
        return dependencyTask.orcaTaskId;
      });
      const taskReceipt = await this.#orca.execute({
        kind: "create_task",
        spec: taskSpec(task),
        ...(dependencyIds.length === 0 ? {} : { dependencies: dependencyIds })
      });
      if (context.orcaRunId === undefined) throw new Error(`Run ${context.localId} has no Orca receipt`);
      task.orcaTaskId = taskIdFrom(taskReceipt, context.orcaRunId);
      await this.#lifecycle.transitionTask(task.localId, "ready", {
        orcaTaskId: task.orcaTaskId,
        receipt: taskReceipt
      });
    }
  }

  async #launch(
    context: RunContext,
    task: TaskContext,
    dispatch: DispatchContext,
    retryOf?: string
  ): Promise<string> {
    if (task.orcaTaskId === undefined) throw new Error(`Task ${task.localId} has no Orca receipt`);
    if (context.orcaRunId === undefined) throw new Error(`Run ${context.localId} has no Orca receipt`);
    if (task.verificationTask !== undefined) {
      if (this.#verification === undefined) throw new Error("verification is not configured");
      const snapshot = await this.#verification.evidence.captureRepositorySnapshot({
        run: this.#lifecycle.run(context.localId),
        task: this.#lifecycle.task(task.localId),
        dispatch: this.#lifecycle.dispatch(dispatch.localId),
        verificationTask: task.verificationTask,
        phase: "before_verifier"
      });
      await this.#lifecycle.recordVerifierRepositorySnapshotBefore(
        dispatch.localId,
        snapshot,
        task.verificationTask.gitDiff.sha256
      );
    }
    await this.#lifecycle.transitionDispatch(dispatch.localId, "launching");
    const provider = this.#providerFor(dispatch.assignment);
    const prompt = workerPrompt(dispatch.assignment);
    const assignmentArtifact = await this.#assignmentArtifacts.stage({
      reference: task.assignmentArtifactReference,
      version: dispatch.attempt,
      ownerDispatchId: dispatch.localId,
      content: prompt
    });
    dispatch.assignmentArtifact = assignmentArtifact;
    await this.#lifecycle.recordAssignmentArtifact(dispatch.localId, assignmentArtifact);
    const providerStartReceipt = this.#validatedStartReceipt(
      provider.id,
      dispatch.assignment,
      task.orcaTaskId,
      context.orcaRunId,
      assignmentArtifact,
      await provider.start(dispatch.assignment, {
        orcaTaskId: task.orcaTaskId,
        name: task.task.localId,
        setup: context.project.setupPolicy,
        assignmentArtifact,
        providerChildEnvironmentIsolationCapability:
          this.#providerCapabilities.providerChildEnvironmentIsolation,
        assignmentArtifactAccess: this.#providerCapabilities.assignmentArtifactAccess,
        workerLaunchPolicy: this.#workerLaunchPolicy,
        ...(retryOf === undefined ? {} : { retryOf })
      })
    );
    dispatch.orcaDispatchId = providerStartReceipt.orcaDispatchId;
    await this.#lifecycle.recordProviderStart(dispatch.localId, {
      orcaDispatchId: dispatch.orcaDispatchId,
      receipt: providerStartReceipt.orcaReceipt,
      providerId: provider.id,
      providerStartReceipt
    });
    const lookup = { run: context, task, dispatch };
    this.#dispatchLookup.set(dispatch.localId, lookup);
    this.#dispatchLookup.set(dispatch.orcaDispatchId, lookup);
    await this.inspectWorker(dispatch.orcaDispatchId);
    await this.#lifecycle.recordLaunchSuccess(dispatch.localId);
    return dispatch.orcaDispatchId;
  }

  #providerFor(assignment: WorkerAssignment): WorkerProvider {
    const selection = selectProvider({
      role: assignment.role,
      preferredAgent: assignment.preferredAgent
    }, this.#providerCapabilities, this.#workerLaunchPolicy);
    if (selection.kind === "unavailable") {
      const code = selection.reason === "provider_authentication_required"
        ? "provider_authentication_required"
        : selection.reason === "provider_environment_isolation_unavailable"
          ? "provider_environment_isolation_unavailable"
          : selection.reason === "provider_assignment_artifact_access_unavailable"
            ? "provider_assignment_artifact_access_unavailable"
          : "provider_unavailable";
      throw new WorkerProviderError(code, selection.provider, "start");
    }
    const provider = this.#providers.get(selection.provider);
    if (provider.id !== assignment.preferredAgent) {
      throw new WorkerProviderError("provider_mismatch", provider.id, "start");
    }
    return provider;
  }

  #validatedStartReceipt(
    provider: WorkerProviderId,
    assignment: WorkerAssignment,
    orcaTaskId: string,
    orcaRunId: string,
    assignmentArtifact: AssignmentArtifact,
    value: ProviderStartReceipt
  ): ProviderStartReceipt {
    const boundDispatchId = boundProviderStartDispatchId(value, orcaTaskId);
    let auditReceipt: OrcaReceipt;
    try {
      auditReceipt = providerStartOrcaAuditReceipt(
        value.orcaReceipt,
        value.boundary.providerChildEnvironmentIsolation
      );
    } catch {
      throw new WorkerProviderError("invalid_provider_receipt", provider, "start", {
        workerMayBeLive: true,
        ...(boundDispatchId === undefined ? {} : { trustedDispatchId: boundDispatchId })
      });
    }
    const parsed = ProviderStartReceiptSchema.safeParse({
      ...value,
      orcaReceipt: auditReceipt
    });
    const expectedPrompt = workerPrompt(assignment);
    const expectedSha256 = createHash("sha256").update(expectedPrompt).digest("hex");
    if (!parsed.success) {
      throw new WorkerProviderError("invalid_provider_receipt", provider, "start", {
        workerMayBeLive: true,
        ...(boundDispatchId === undefined ? {} : { trustedDispatchId: boundDispatchId })
      });
    }
    if (
      boundDispatchId === undefined
      ||
      !parsed.data.orcaReceipt.ok
      || parsed.data.provider !== provider
      || parsed.data.assignmentTaskId !== assignment.taskId
      || parsed.data.assignmentDispatchId !== assignment.dispatchId
      || parsed.data.orcaTaskId !== orcaTaskId
      || (parsed.data.orcaReceipt.result as { runId?: unknown }).runId !== orcaRunId
      || parsed.data.promptArtifact.content !== expectedPrompt
      || parsed.data.promptArtifact.sha256 !== expectedSha256
      || parsed.data.promptArtifact.artifactId !== assignmentArtifact.artifactId
      || parsed.data.promptArtifact.path !== assignmentArtifact.path
      || parsed.data.promptArtifact.version !== assignmentArtifact.version
      || parsed.data.promptArtifact.ownerDispatchId !== assignmentArtifact.ownerDispatchId
      || JSON.stringify(
        parsed.data.boundary.providerChildEnvironmentIsolation
      ) !== JSON.stringify(
        this.#workerLaunchPolicy.kind === "orca_supervised_private_pilot"
          ? { kind: "unverified_orca_supervised" }
          : this.#providerCapabilities.providerChildEnvironmentIsolation
      )
      || JSON.stringify(
        parsed.data.boundary.assignmentArtifactAccess
      ) !== JSON.stringify(
        this.#providerCapabilities.assignmentArtifactAccess
      )
    ) {
      throw new WorkerProviderError("invalid_provider_receipt", provider, "start", {
        workerMayBeLive: true,
        ...(boundDispatchId === undefined ? {} : { trustedDispatchId: boundDispatchId })
      });
    }
    return Object.freeze(ProviderStartReceiptSchema.parse({
      ...parsed.data,
      orcaReceipt: auditReceipt
    })) as ProviderStartReceipt;
  }

  #validatedInspectReceipt(
    provider: WorkerProviderId,
    dispatchId: string,
    orcaTaskId: string,
    orcaRunId: string,
    startReceipt: ProviderStartReceipt,
    value: ProviderInspectReceipt,
    mode: "active_start" | "launch_failure_identity" = "active_start"
  ): ProviderInspectReceipt {
    let auditReceipts: ReturnType<typeof providerInspectOrcaAuditReceipts>;
    try {
      auditReceipts = providerInspectOrcaAuditReceipts(
        value.showReceipt,
        value.readReceipt,
        dispatchId
      );
    } catch {
      throw new WorkerProviderError("invalid_provider_receipt", provider, "inspect");
    }
    const parsed = ProviderInspectReceiptSchema.safeParse({
      ...value,
      showReceipt: auditReceipts.showReceipt,
      readReceipt: auditReceipts.readReceipt
    });
    if (
      !parsed.success
      || !parsed.data.showReceipt.ok
      || !parsed.data.readReceipt.ok
      || parsed.data.provider !== provider
      || parsed.data.dispatchId !== dispatchId
    ) {
      throw new WorkerProviderError("invalid_provider_receipt", provider, "inspect");
    }
    if (parsed.data.workerState !== auditReceipts.workerState) {
      throw new WorkerProviderError("invalid_provider_receipt", provider, "inspect");
    }
    try {
      if (mode === "launch_failure_identity") {
        assertAuthoritativeWorkerIdentityInspection(
          auditReceipts.showReceipt,
          auditReceipts.readReceipt,
          { dispatchId, taskId: orcaTaskId, runId: orcaRunId }
        );
      } else {
        const startResult = startReceipt.orcaReceipt.result as {
          state?: unknown;
          stage?: unknown;
        };
        assertAuthoritativeActiveWorkerInspection(
          auditReceipts.showReceipt,
          auditReceipts.readReceipt,
          {
            dispatchId,
            taskId: orcaTaskId,
            runId: orcaRunId,
            workerState: String(startResult.state ?? ""),
            workerStage: String(startResult.stage ?? "")
          }
        );
      }
    } catch {
      throw new WorkerProviderError("invalid_provider_receipt", provider, "inspect", {
        workerMayBeLive: true,
        trustedDispatchId: dispatchId
      });
    }
    return Object.freeze(ProviderInspectReceiptSchema.parse({
      ...parsed.data,
      showReceipt: auditReceipts.showReceipt,
      readReceipt: auditReceipts.readReceipt
    })) as ProviderInspectReceipt;
  }

  async #launchWithIntervention(
    context: RunContext,
    task: TaskContext,
    dispatch: DispatchContext,
    retryOf?: string
  ): Promise<string> {
    try {
      return await this.#launch(context, task, dispatch, retryOf);
    } catch (error) {
      let safeToReleaseLease = dispatch.orcaDispatchId === undefined;
      const lookup = { run: context, task, dispatch };
      if (error instanceof WorkerProviderError && error.workerMayBeLive) {
        safeToReleaseLease = false;
        if (error.trustedDispatchId !== undefined) {
          dispatch.orcaDispatchId = error.trustedDispatchId;
          this.#dispatchLookup.set(dispatch.localId, lookup);
          this.#dispatchLookup.set(error.trustedDispatchId, lookup);
          const fenced = await this.#fenceUntrustedWorker(lookup);
          safeToReleaseLease = fenced;
          if (fenced) {
            const cleanupReview = await this.#cleanupAssignmentArtifact(lookup);
            if (cleanupReview !== undefined) safeToReleaseLease = false;
          }
        }
      } else if (safeToReleaseLease) {
        const artifact = dispatch.assignmentArtifact
          ?? this.#lifecycle.dispatch(dispatch.localId).assignmentArtifact;
        if (artifact !== undefined) {
          const cleanupReview = await this.#cleanupAssignmentArtifact(lookup);
          if (cleanupReview !== undefined) safeToReleaseLease = false;
        }
      }
      dispatch.leaseReleaseBlocked = !safeToReleaseLease;
      try {
        await this.#markIntervention(context, task, dispatch);
      } finally {
        if (dispatch.placement.requiresEditingLease && safeToReleaseLease) {
          await this.#release(context, dispatch);
        }
      }
      throw error;
    }
  }

  async #markIntervention(
    context: RunContext,
    task: TaskContext,
    dispatch: DispatchContext
  ): Promise<void> {
    await this.#lifecycle.transitionDispatch(dispatch.localId, "intervention_required");
    await this.#lifecycle.transitionTask(task.localId, "intervention_required");
    await this.#lifecycle.transitionRun(context.localId, "intervention_required");
  }

  async #markLaunchFailureIntervention(lookup: DispatchLookup): Promise<void> {
    const durable = this.#lifecycle.dispatch(lookup.dispatch.localId);
    if (durable.fenceReceipt === undefined) {
      throw new Error(`Dispatch ${lookup.dispatch.localId} has no durable launch-failure fence`);
    }
    await this.#lifecycle.recordLaunchIntervention(lookup.dispatch.localId, {
      fenceReceipt: durable.fenceReceipt
    });
  }

  #readyPendingTasks(context: RunContext): TaskContext[] {
    return context.tasks.filter((task) => {
      if (task.verificationTask !== undefined || task.fixTask !== undefined) return false;
      if (task.dispatches.length > 0) return false;
      return task.task.dependsOn.every((dependency) => {
        const dependencyTask = context.tasksByProposalId.get(dependency);
        return dependencyTask !== undefined
          && this.#lifecycle.task(dependencyTask.localId).state === "worker_done";
      });
    });
  }

  #allOriginalTasksDone(context: RunContext): boolean {
    return context.tasks
      .filter(({ verificationTask, fixTask }) => verificationTask === undefined && fixTask === undefined)
      .every((task) => this.#lifecycle.task(task.localId).state === "worker_done");
  }

  #completionWorkOutstanding(context: RunContext): boolean {
    return context.tasks.some((task) => {
      const state = this.#lifecycle.task(task.localId).state;
      if (task.verificationTask !== undefined) {
        return state !== "verified_success" && state !== "verification_failed";
      }
      if (task.fixTask !== undefined) return state !== "worker_done";
      return false;
    });
  }

  #taskForDispatch(context: RunContext, dispatch: DispatchContext): TaskContext {
    const task = context.tasks.find((candidate) => candidate.dispatches.includes(dispatch));
    if (task === undefined) throw new Error(`Dispatch ${dispatch.localId} has no Task`);
    return task;
  }

  #taskForPreparedDispatch(context: RunContext, dispatch: DispatchContext): TaskContext {
    const task = context.tasks.find((candidate) => candidate.localId === dispatch.assignment.taskId);
    if (task === undefined) throw new Error(`Prepared Dispatch ${dispatch.localId} has no Task`);
    return task;
  }

  #lease(context: RunContext, dispatch: DispatchContext): EditingLeaseRequest {
    return Object.freeze({
      lockKey: context.project.lockKey,
      commandId: context.proposal.commandId,
      taskId: dispatch.assignment.taskId,
      projectKey: context.project.projectKey,
      worktreePath: dispatch.placement.worktree.path,
      branch: lockBranch(dispatch.placement),
      dispatchId: dispatch.localId
    });
  }

  async #acquire(
    context: RunContext,
    dispatch: DispatchContext
  ): Promise<EditingLockAcquireResult> {
    const result = await this.#locks.acquire(this.#lease(context, dispatch));
    if (result.kind === "acquired") dispatch.editingLeaseHeld = true;
    return result;
  }

  async #release(
    context: RunContext,
    dispatch: DispatchContext
  ): Promise<EditingLockReleaseResult> {
    if (!dispatch.editingLeaseHeld) return Object.freeze({ kind: "not_found" });
    const result = await this.#locks.release({
      lockKey: context.project.lockKey,
      dispatchId: dispatch.localId
    });
    dispatch.editingLeaseHeld = false;
    return result;
  }

  async #releaseOrcaWorker(lookup: DispatchLookup): Promise<ExecutionReviewRequired | undefined> {
    const dispatchId = lookup.dispatch.orcaDispatchId;
    if (dispatchId === undefined) throw new Error(`Dispatch ${lookup.dispatch.localId} has no Orca receipt`);

    let receipt: OrcaReceipt;
    try {
      receipt = await this.#orca.execute({ kind: "release_worker", dispatchId });
      if (releaseDispatchIdFrom(receipt) !== dispatchId) {
        throw Object.assign(new Error("release receipt does not match the exact Dispatch"), {
          code: "orca_release_receipt_mismatch",
          retryable: false
        });
      }
    } catch (error) {
      await this.#lifecycle.recordWorkerRelease(lookup.dispatch.localId, {
        releaseFailure: releaseFailure(error)
      });
      await this.#lifecycle.transitionRun(lookup.run.localId, "intervention_required");
      return Object.freeze({
        kind: "review_required",
        reason: "worker_release_failed",
        dispatchId
      });
    }

    await this.#lifecycle.recordWorkerRelease(lookup.dispatch.localId, {
      releaseReceipt: receipt
    });
    return undefined;
  }

  async #fenceUntrustedWorker(lookup: DispatchLookup): Promise<boolean> {
    const dispatchId = lookup.dispatch.orcaDispatchId;
    if (dispatchId === undefined) return false;
    try {
      const receipt = await this.#orca.execute({ kind: "stop_worker", dispatchId });
      if (stopDispatchIdFrom(receipt) !== dispatchId) {
        throw Object.assign(new Error("stop receipt does not match the exact Dispatch"), {
          code: "orca_stop_receipt_mismatch",
          retryable: false
        });
      }
      await this.#lifecycle.recordWorkerFence(lookup.dispatch.localId, dispatchId, {
        fenceReceipt: receipt
      });
      return true;
    } catch (error) {
      await this.#lifecycle.recordWorkerFence(lookup.dispatch.localId, dispatchId, {
        fenceFailure: releaseFailure(error)
      });
      return false;
    }
  }

  async #cleanupAssignmentArtifact(
    lookup: DispatchLookup
  ): Promise<ExecutionReviewRequired | undefined> {
    const artifact = lookup.dispatch.assignmentArtifact
      ?? this.#lifecycle.dispatch(lookup.dispatch.localId).assignmentArtifact;
    if (artifact === undefined) {
      throw new Error(`Dispatch ${lookup.dispatch.localId} has no assignment artifact`);
    }
    let result: Awaited<ReturnType<AssignmentArtifactStore["cleanup"]>>;
    try {
      result = await this.#assignmentArtifacts.cleanup(artifact);
    } catch (error) {
      await this.#lifecycle.recordAssignmentArtifactCleanupFailure(
        lookup.dispatch.localId,
        artifact,
        assignmentArtifactCleanupFailure(error, "assignment_artifact_cleanup_failed")
      ).catch(() => undefined);
      return this.#assignmentArtifactCleanupReview(lookup);
    }
    try {
      await this.#lifecycle.recordAssignmentArtifactCleanup(
        lookup.dispatch.localId,
        artifact,
        result
      );
      return undefined;
    } catch (error) {
      await this.#lifecycle.recordAssignmentArtifactCleanupFailure(
        lookup.dispatch.localId,
        artifact,
        assignmentArtifactCleanupFailure(
          error,
          "assignment_artifact_cleanup_persistence_failed"
        )
      ).catch(() => undefined);
      return this.#assignmentArtifactCleanupReview(lookup);
    }
  }

  #assignmentArtifactCleanupReview(lookup: DispatchLookup): ExecutionReviewRequired {
    return Object.freeze({
      kind: "review_required",
      reason: "assignment_artifact_cleanup_failed",
      dispatchId: lookup.dispatch.orcaDispatchId ?? lookup.dispatch.localId
    });
  }
}
