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
  reason: "assignment_artifact_cleanup_failed";
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
        | "assignment_artifact_cleanup_failed";
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

interface TaskContext {
  readonly task: ExecutionTask;
  readonly localId: string;
  readonly initialAssignment: WorkerAssignment;
  readonly assignmentArtifactReference: AssignmentArtifactReference;
  readonly dispatches: DispatchContext[];
  orcaTaskId?: string;
}

interface RunContext {
  readonly authorized: AuthorizedProposal;
  readonly proposal: ExecutionProposal;
  readonly project: ProjectRegistryEntry;
  readonly localId: string;
  readonly tasks: readonly TaskContext[];
  readonly tasksByProposalId: ReadonlyMap<string, TaskContext>;
  placement: ReadyWorktreePlacement;
  orcaRunId?: string;
}

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

function runIdFrom(receipt: OrcaReceipt): string {
  const result = receipt.result as { runId?: unknown; run?: { id?: unknown } };
  const value = typeof result.runId === "string" ? result.runId : result.run?.id;
  if (typeof value !== "string" || value.length === 0) throw new Error("validated Run receipt has no Run ID");
  return value;
}

function taskIdFrom(receipt: OrcaReceipt): string {
  const result = receipt.result as { taskId?: unknown; task?: { id?: unknown } };
  const value = typeof result.taskId === "string" ? result.taskId : result.task?.id;
  if (typeof value !== "string" || value.length === 0) throw new Error("validated Task receipt has no Task ID");
  return value;
}

function releaseDispatchIdFrom(receipt: OrcaReceipt): string {
  const result = receipt.result as { dispatchId?: unknown };
  if (typeof result.dispatchId !== "string" || result.dispatchId.length === 0) {
    throw Object.assign(new Error("validated release receipt has no Dispatch ID"), {
      code: "orca_release_receipt_invalid",
      retryable: false
    });
  }
  return result.dispatchId;
}

function stopDispatchIdFrom(receipt: OrcaReceipt): string {
  const result = receipt.result as { dispatchId?: unknown; verdict?: unknown };
  if (
    typeof result.dispatchId !== "string"
    || result.dispatchId.length === 0
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
    const lookup = this.#dispatchLookup.get(message.dispatchId);
    if (lookup === undefined) throw new Error(`Dispatch ${message.dispatchId} is not known`);
    const recorded = await this.#lifecycle.recordWorkerMessage(message, lookup.dispatch.localId);
    if (recorded.kind === "duplicate") return recorded;
    if (message.kind !== "worker_done") return recorded;

    const workerReleaseReview = await this.#releaseOrcaWorker(lookup);
    if (workerReleaseReview !== undefined) return workerReleaseReview;
    const artifactCleanupReview = await this.#cleanupAssignmentArtifact(lookup);
    if (artifactCleanupReview !== undefined) {
      await this.#lifecycle.transitionRun(lookup.run.localId, "intervention_required");
      return artifactCleanupReview;
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

    if (this.#allTasksDone(lookup.run)) {
      await this.#lifecycle.transitionRun(lookup.run.localId, "awaiting_verification");
    }
    return Object.freeze({
      kind: "recorded",
      verificationRequired: true,
      ...(dispatched.length === 0 ? {} : { dispatched: immutableStrings(dispatched) })
    });
  }

  async recordLaunchFailure(input: LaunchFailureInput): Promise<LaunchFailureResult> {
    const lookup = this.#dispatchLookup.get(input.dispatchId);
    if (lookup === undefined) throw new Error(`Dispatch ${input.dispatchId} is not known`);
    if (this.#lifecycle.dispatch(lookup.dispatch.localId).state !== "running") {
      return Object.freeze({ kind: "duplicate" });
    }
    const message: LaunchFailureMessage = Object.freeze({
      kind: "launch_failure",
      messageId: input.failureId,
      dispatchId: input.dispatchId,
      evidence: Object.freeze({ ...input.evidence })
    });
    const recorded = await this.#lifecycle.recordLaunchFailure(message, lookup.dispatch.localId);
    if (recorded === "duplicate") return Object.freeze({ kind: "duplicate" });
    const artifactCleanupReview = await this.#cleanupAssignmentArtifact(lookup);
    if (artifactCleanupReview !== undefined) {
      await this.#markIntervention(lookup.run, lookup.task, lookup.dispatch);
      return Object.freeze({
        kind: "intervention_required",
        reason: "assignment_artifact_cleanup_failed",
        dispatchId: input.dispatchId
      });
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
    const lookup = this.#dispatchLookup.get(dispatchId);
    if (lookup === undefined) throw new Error(`Dispatch ${dispatchId} is not known`);
    const orcaDispatchId = lookup.dispatch.orcaDispatchId;
    if (orcaDispatchId === undefined) {
      throw new Error(`Dispatch ${lookup.dispatch.localId} has no Orca receipt`);
    }
    const provider = this.#providerFor(lookup.dispatch.assignment);
    const receipt = this.#validatedInspectReceipt(
      provider.id,
      orcaDispatchId,
      await provider.inspect(orcaDispatchId)
    );
    await this.#lifecycle.recordProviderInspection(lookup.dispatch.localId, receipt);
    return receipt;
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
      state: "planned"
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
      task.orcaTaskId = taskIdFrom(taskReceipt);
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
    await this.#lifecycle.transitionDispatch(dispatch.localId, "running", {
      orcaDispatchId: dispatch.orcaDispatchId,
      receipt: providerStartReceipt.orcaReceipt,
      providerId: provider.id,
      providerStartReceipt
    });
    await this.#lifecycle.transitionTask(task.localId, "running");
    const lookup = { run: context, task, dispatch };
    this.#dispatchLookup.set(dispatch.localId, lookup);
    this.#dispatchLookup.set(dispatch.orcaDispatchId, lookup);
    await this.inspectWorker(dispatch.orcaDispatchId);
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
    assignmentArtifact: AssignmentArtifact,
    value: ProviderStartReceipt
  ): ProviderStartReceipt {
    const boundDispatchId = boundProviderStartDispatchId(value, orcaTaskId);
    const parsed = ProviderStartReceiptSchema.safeParse(value);
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
    let auditReceipt: OrcaReceipt;
    try {
      auditReceipt = providerStartOrcaAuditReceipt(
        parsed.data.orcaReceipt,
        parsed.data.boundary.providerChildEnvironmentIsolation
      );
    } catch {
      throw new WorkerProviderError("invalid_provider_receipt", provider, "start", {
        workerMayBeLive: true,
        trustedDispatchId: parsed.data.orcaDispatchId
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
    value: ProviderInspectReceipt
  ): ProviderInspectReceipt {
    const parsed = ProviderInspectReceiptSchema.safeParse(value);
    if (
      !parsed.success
      || !parsed.data.showReceipt.ok
      || !parsed.data.readReceipt.ok
      || parsed.data.provider !== provider
      || parsed.data.dispatchId !== dispatchId
    ) {
      throw new WorkerProviderError("invalid_provider_receipt", provider, "inspect");
    }
    let auditReceipts: ReturnType<typeof providerInspectOrcaAuditReceipts>;
    try {
      auditReceipts = providerInspectOrcaAuditReceipts(
        parsed.data.showReceipt,
        parsed.data.readReceipt,
        dispatchId
      );
    } catch {
      throw new WorkerProviderError("invalid_provider_receipt", provider, "inspect");
    }
    if (parsed.data.workerState !== auditReceipts.workerState) {
      throw new WorkerProviderError("invalid_provider_receipt", provider, "inspect");
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

  #readyPendingTasks(context: RunContext): TaskContext[] {
    return context.tasks.filter((task) => {
      if (task.dispatches.length > 0) return false;
      return task.task.dependsOn.every((dependency) => {
        const dependencyTask = context.tasksByProposalId.get(dependency);
        return dependencyTask !== undefined
          && this.#lifecycle.task(dependencyTask.localId).state === "worker_done";
      });
    });
  }

  #allTasksDone(context: RunContext): boolean {
    return context.tasks.every((task) => this.#lifecycle.task(task.localId).state === "worker_done");
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
