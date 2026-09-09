import { isDeepStrictEqual } from "node:util";

import {
  NativeWorkItemSchema,
  NativeWorkerReceiptSchema,
  type LaunchProfile,
  type NativeWorkItem,
  type NativeWorkerReceipt
} from "@orca-hq/core";

import type { AuthoritativeNoLaunchProof } from "./worker-admission.js";

export interface NativeWorkerStartContext {
  runId: string;
  taskId: string;
  timeoutMs?: number;
}

export interface NativeTerminalReuseEvidence {
  terminalHandle: string;
  worktreeId: string;
  contextId: string;
  priorAttemptId: string;
  priorDispatchId: string;
  sessionId: string;
  state: "idle" | "busy" | "unknown";
  ownership: "hq_retained" | "user_owned" | "unknown";
  connected: boolean;
  writable: boolean;
  requested: LaunchProfile;
  effective: {
    agent: string;
    model?: string;
    effort?: string;
  };
}

export type NativeRetentionPolicy = "retain" | "release";
export type NativeLaunchPhase =
  | "prepared"
  | "task_sent"
  | "task_created"
  | "worker_sent"
  | "recovery_required"
  | "proven_no_launch"
  | "ready";

export interface NativeLaunchJournalEntry {
  attemptId: string;
  item: NativeWorkItem;
  phase: NativeLaunchPhase;
  mutationIntentIds: {
    task: string;
    worker: string;
  };
  mutationRequestIds: {
    task: string | null;
    worker: string | null;
  };
  runId: string;
  taskId: string | null;
  dispatchId: string | null;
  terminalHandle: string | null;
  terminalSessionId: string | null;
  worktreeId: string;
  requested: LaunchProfile;
  effective: NativeWorkerReceipt["effective"] | null;
  retentionPolicy: NativeRetentionPolicy;
  receipt: NativeWorkerReceipt | null;
  noLaunchProof: AuthoritativeNoLaunchProof | null;
  warning: string | null;
  residualResources: unknown[];
}

export type NativeLaunchResult =
  | { state: "ready"; receipt: NativeWorkerReceipt }
  | { state: "proven_no_launch"; proof: AuthoritativeNoLaunchProof }
  | {
      state: "recovery_required";
      attemptId: string;
      runId: string;
      taskId?: string;
      dispatchId?: string;
      mutationRequestId?: string;
      residualResources: unknown[];
      reason: string;
    };

export function buildWorkerStartArgs(
  rawItem: NativeWorkItem,
  context: NativeWorkerStartContext
): string[] {
  const item = NativeWorkItemSchema.parse(rawItem);
  if (!context.runId.trim() || !context.taskId.trim()) {
    throw new Error("native_launch_identity_required");
  }
  const args = [
    "worker-start",
    "--task", context.taskId,
    "--run", context.runId,
    "--worktree", `id:${item.worktreeId}`
  ];
  if (item.resumeTerminalHandle) {
    args.push("--terminal", item.resumeTerminalHandle);
  } else {
    args.push("--agent", item.profile.agent, "--model", item.profile.model);
    if (item.profile.effort) args.push("--effort", item.profile.effort);
  }
  args.push("--timeout-ms", String(context.timeoutMs ?? 60_000));
  return args;
}

export function validateTerminalReuse(
  rawItem: NativeWorkItem,
  evidence: NativeTerminalReuseEvidence
): void {
  const item = NativeWorkItemSchema.parse(rawItem);
  if (!item.resumeTerminalHandle) throw new Error("terminal_reuse_not_requested");
  const profileChanged =
    !isDeepStrictEqual(evidence.requested, item.profile) ||
    evidence.effective.agent !== item.profile.agent ||
    evidence.effective.model !== item.profile.model ||
    evidence.effective.effort !== item.profile.effort;
  if (profileChanged) {
    throw new Error("terminal_reuse_profile_changed_requires_fresh_context_handoff");
  }
  if (
    evidence.terminalHandle !== item.resumeTerminalHandle ||
    evidence.worktreeId !== item.worktreeId ||
    evidence.contextId !== item.contextId ||
    evidence.priorAttemptId === item.attemptId ||
    evidence.priorDispatchId.trim().length === 0 ||
    evidence.sessionId.trim().length === 0 ||
    evidence.state !== "idle" ||
    evidence.ownership !== "hq_retained" ||
    !evidence.connected ||
    !evidence.writable
  ) {
    throw new Error("terminal_reuse_not_authorized");
  }
}

export function authoritativeNoLaunchProof(
  item: NativeWorkItem,
  journal: NativeLaunchJournalEntry,
  value: unknown,
  observedAt: string
): AuthoritativeNoLaunchProof | undefined {
  if (item.resumeTerminalHandle) return undefined;
  const result = record(value);
  const effects = Array.isArray(result.effects) ? result.effects.map(record) : undefined;
  const residualResources = Array.isArray(result.residualResources)
    ? result.residualResources
    : undefined;
  const failedStage = text(result.failedStage ?? result.failed_stage);
  const provenPreLaunchStages = new Set(["terminal_create"]);
  const responseTaskId = text(result.taskId);
  const responseRunId = text(result.runId);
  const responseWorktreeId = text(result.worktreeId);
  const responseMutationId = text(
    result.orchestrationRequestId ?? record(result.mutation).requestId
  );
  if (
    result.state !== "failed" ||
    !failedStage ||
    !provenPreLaunchStages.has(failedStage) ||
    !journal.mutationRequestIds.worker ||
    responseTaskId !== journal.taskId ||
    responseRunId !== journal.runId ||
    responseWorktreeId !== item.worktreeId ||
    responseMutationId !== journal.mutationRequestIds.worker ||
    effects === undefined ||
    residualResources === undefined ||
    residualResources.length > 0 ||
    effects.some(effect =>
      !(
        (effect.kind === "worktree" && effect.action === "reused" && effect.id === item.worktreeId) ||
        (effect.kind === "setup" && ["not_applicable", "skipped"].includes(String(effect.action)))
      )
    ) ||
    text(result.terminalHandle ?? result.agentTerminalHandle)
  ) {
    return undefined;
  }
  return {
    kind: "orca_authoritative_no_launch",
    attemptId: item.attemptId,
    launchMutationRequestId: journal.mutationRequestIds.worker,
    runId: journal.runId,
    taskId: journal.taskId!,
    ...(text(result.dispatchId) ? { dispatchId: text(result.dispatchId)! } : {}),
    worktreeId: item.worktreeId,
    requested: item.profile,
    failedStage,
    observedAt,
    effects: effects as AuthoritativeNoLaunchProof["effects"],
    residualResources: []
  };
}

export function observedNativeWorkerReceipt(
  item: NativeWorkItem,
  journal: NativeLaunchJournalEntry,
  value: unknown
): NativeWorkerReceipt {
  const observed = record(value);
  const dispatch = record(observed.dispatch);
  const worker = record(observed.worker);
  const terminal = record(observed.terminal);
  const observation = record(observed.observation);
  const terminalResource = record(observed.terminalResource);
  const startOptions = parseRecord(worker.startOptions ?? worker.start_options);
  const launch = record(startOptions.launch);
  const requested = record(launch.requested);
  const effective = record(launch.effective);
  const verifiedRequested = item.resumeTerminalHandle ? record(journal.requested) : requested;
  const verifiedEffective = item.resumeTerminalHandle ? record(journal.effective) : effective;
  const dispatchId = text(dispatch.id);
  const terminalHandle = text(worker.agent_terminal_handle ?? terminal.handle);
  if (
    !journal.taskId ||
    !dispatchId ||
    dispatchId !== journal.dispatchId ||
    text(dispatch.task_id) !== journal.taskId ||
    (text(dispatch.run_id) !== undefined && text(dispatch.run_id) !== journal.runId) ||
    worker.state !== "ready" ||
    worker.stage !== "input_accepted" ||
    worker.worktree_id !== item.worktreeId ||
    !terminalHandle ||
    terminal.handle !== terminalHandle ||
    terminal.worktreeId !== item.worktreeId ||
    terminal.connected !== true ||
    terminal.writable !== true ||
    terminal.agentIdentity !== item.profile.agent ||
    observation.exactWorker !== true ||
    terminalResource.ownershipState !== "owned" ||
    terminalResource.terminalHandle !== terminalHandle ||
    terminalResource.ownerDispatchId !== dispatchId ||
    (item.resumeTerminalHandle
      ? startOptions.terminal !== item.resumeTerminalHandle || journal.effective === null
      : startOptions.terminal !== null && startOptions.terminal !== undefined)
  ) {
    throw new Error("native_launch_observation_mismatch");
  }
  if (
    verifiedRequested.agent !== item.profile.agent ||
    verifiedRequested.model !== item.profile.model ||
    text(verifiedRequested.effort) !== item.profile.effort ||
    verifiedEffective.agent !== item.profile.agent ||
    verifiedEffective.model !== item.profile.model ||
    text(verifiedEffective.effort) !== item.profile.effort
  ) {
    throw new Error("native_launch_profile_mismatch");
  }
  return NativeWorkerReceiptSchema.parse({
    attemptId: item.attemptId,
    runId: journal.runId,
    taskId: journal.taskId,
    dispatchId,
    terminalHandle,
    worktreeId: item.worktreeId,
    requested: item.profile,
    effective: {
      agent: verifiedEffective.agent,
      ...(text(verifiedEffective.model) ? { model: text(verifiedEffective.model) } : {}),
      ...(text(verifiedEffective.effort) ? { effort: text(verifiedEffective.effort) } : {})
    }
  });
}

function record(value: unknown): Record<string, any> {
  return value !== null && typeof value === "object"
    ? value as Record<string, any>
    : {};
}

function parseRecord(value: unknown): Record<string, any> {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return record(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}
