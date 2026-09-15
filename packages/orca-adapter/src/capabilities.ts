import { satisfies, validRange } from "semver";
import { z } from "zod";

export const REQUIRED_ORCA_CAPABILITIES = Object.freeze([
  "orchestration.contract.v1",
  "orchestration.worker-stop-verdict.v1",
  "orchestration.worker-launch-preferences.v1"
] as const);

export const MINIMUM_ORCA_VERSION = "1.4.194" as const;

const NonEmptyStringSchema = z.string().min(1);
const OperationsIdSchema = z.string().min(1).max(512).refine((value) => value === value.trim(), "must not have surrounding whitespace");
const OperationsCursorSchema = z.string().min(1).max(2048).refine((value) => value === value.trim(), "must not have surrounding whitespace");
const OperationsBodySchema = z.string().max(8 * 1024).refine((value) => value.trim().length > 0, "body is required");
const OrcaOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("list_projects") }).strict(),
  z.object({
    kind: z.literal("create_run"),
    objective: NonEmptyStringSchema
  }).strict(),
  z.object({
    kind: z.literal("create_task"),
    spec: NonEmptyStringSchema,
    dependencies: z.array(NonEmptyStringSchema).optional(),
    parentTaskId: NonEmptyStringSchema.optional()
  }).strict(),
  z.object({
    kind: z.literal("dispatch_worker"),
    taskId: NonEmptyStringSchema,
    worktree: NonEmptyStringSchema,
    agent: z.enum(["codex", "claude"]),
    name: NonEmptyStringSchema.optional(),
    setup: z.enum(["run", "skip", "inherit"]).optional(),
    retryOf: NonEmptyStringSchema.optional()
  }).strict(),
  z.object({
    kind: z.literal("show_worker"),
    dispatchId: NonEmptyStringSchema
  }).strict(),
  z.object({
    kind: z.literal("read_worker"),
    dispatchId: NonEmptyStringSchema,
    limit: z.number().int().positive().max(1_000).optional(),
    cursor: NonEmptyStringSchema.optional()
  }).strict(),
  z.object({
    kind: z.literal("stop_worker"),
    dispatchId: NonEmptyStringSchema
  }).strict(),
  z.object({
    kind: z.literal("release_worker"),
    dispatchId: NonEmptyStringSchema
  }).strict(),
  z.object({ kind: z.literal("operations_show_worker"), dispatchId: OperationsIdSchema }).strict(),
  z.object({ kind: z.literal("operations_status") }).strict(),
  z.object({ kind: z.literal("operations_dispatch"), senderHandle: OperationsIdSchema.optional(), runId: OperationsIdSchema.optional(), taskId: OperationsIdSchema, terminalHandle: OperationsIdSchema, inject: z.boolean(), retryRequestId: OperationsIdSchema }).strict(),
  z.object({ kind: z.literal("operations_reply"), senderHandle: OperationsIdSchema.optional(), runId: OperationsIdSchema.optional(), messageId: OperationsIdSchema, body: OperationsBodySchema, retryRequestId: OperationsIdSchema }).strict(),
  z.object({ kind: z.literal("operations_send"), senderHandle: OperationsIdSchema.optional(), runId: OperationsIdSchema.optional(), dispatchId: OperationsIdSchema, body: OperationsBodySchema, retryRequestId: OperationsIdSchema }).strict(),
  z.object({ kind: z.literal("operations_stop"), dispatchId: OperationsIdSchema, retryRequestId: OperationsIdSchema }).strict(),
  z.object({ kind: z.literal("operations_retain"), dispatchId: OperationsIdSchema, retryRequestId: OperationsIdSchema }).strict(),
  z.object({ kind: z.literal("operations_release"), dispatchId: OperationsIdSchema, retryRequestId: OperationsIdSchema }).strict(),
  z.object({ kind: z.literal("list_runs"), limit: z.number().int().positive().max(100).optional(), cursor: OperationsCursorSchema.optional() }).strict(),
  z.object({ kind: z.literal("show_run"), runId: OperationsIdSchema }).strict(),
  z.object({ kind: z.literal("list_tasks"), runId: OperationsIdSchema }).strict(),
  z.object({ kind: z.literal("list_workers"), runId: OperationsIdSchema.optional(), limit: z.number().int().positive().max(100).optional(), cursor: OperationsCursorSchema.optional() }).strict(),
  z.object({ kind: z.literal("operations_worker_read"), dispatchId: OperationsIdSchema, source: z.enum(["transcript", "terminal"]), limit: z.number().int().positive().max(500).optional(), cursor: OperationsCursorSchema.optional() }).strict(),
  z.object({ kind: z.literal("operations_inbox"), limit: z.number().int().positive().max(100).optional() }).strict(),
  z.object({ kind: z.literal("operations_list_projects") }).strict(),
  z.object({ kind: z.literal("list_project_setups"), projectId: OperationsIdSchema }).strict(),
  z.object({ kind: z.literal("list_worktrees"), repoId: OperationsIdSchema, limit: z.number().int().positive().max(100).optional() }).strict(),
  z.object({ kind: z.literal("show_worktree"), worktreeId: OperationsIdSchema }).strict(),
  z.object({ kind: z.literal("list_terminals"), worktreeId: OperationsIdSchema }).strict(),
  z.object({ kind: z.literal("show_terminal"), terminalHandle: OperationsIdSchema }).strict(),
  z.object({ kind: z.literal("read_terminal"), terminalHandle: OperationsIdSchema, limit: z.number().int().positive().max(500).optional(), cursor: OperationsCursorSchema.optional() }).strict()
]);

export type OrcaOperation = z.input<typeof OrcaOperationSchema>;
export type ValidatedOrcaOperation = z.output<typeof OrcaOperationSchema>;

const mutationKinds: ReadonlySet<ValidatedOrcaOperation["kind"]> = new Set([
  "create_run",
  "create_task",
  "dispatch_worker",
  "stop_worker",
  "release_worker", "operations_dispatch", "operations_reply", "operations_send", "operations_stop", "operations_retain", "operations_release"
]);

export class OrcaIncompatibleError extends Error {
  readonly code = "orca_incompatible";
  readonly retryable = false;

  constructor() {
    super("Orca version or capabilities are incompatible");
    this.name = "OrcaIncompatibleError";
  }
}

export function assertVersionRange(versionRange: string): void {
  if (validRange(versionRange) === null) throw new TypeError("expectedVersionRange is invalid");
}

export function versionIsCompatible(version: string, versionRange: string): boolean {
  return satisfies(version, `>=${MINIMUM_ORCA_VERSION}`, { includePrerelease: false })
    && satisfies(version, versionRange, { includePrerelease: false });
}

export function missingCapabilities(capabilities: readonly string[]): readonly string[] {
  const advertised = new Set(capabilities);
  return REQUIRED_ORCA_CAPABILITIES.filter((capability) => !advertised.has(capability));
}

export function parseOrcaOperation(operation: OrcaOperation): ValidatedOrcaOperation {
  return OrcaOperationSchema.parse(operation);
}

export function isMutation(operation: ValidatedOrcaOperation): boolean {
  return mutationKinds.has(operation.kind);
}

export function operationArguments(operation: ValidatedOrcaOperation): readonly string[] {
  switch (operation.kind) {
    case "list_projects":
      return ["repo", "list"];
    case "create_run":
      return ["orchestration", "run-create", "--objective", operation.objective];
    case "create_task": {
      const args = ["orchestration", "task-create", "--spec", operation.spec];
      if (operation.dependencies !== undefined) {
        args.push("--deps", JSON.stringify(operation.dependencies));
      }
      if (operation.parentTaskId !== undefined) args.push("--parent", operation.parentTaskId);
      return args;
    }
    case "dispatch_worker": {
      const args = [
        "orchestration", "worker-start", "--task", operation.taskId,
        "--worktree", operation.worktree, "--agent", operation.agent
      ];
      if (operation.name !== undefined) args.push("--name", operation.name);
      if (operation.setup !== undefined) args.push("--setup", operation.setup);
      if (operation.retryOf !== undefined) args.push("--retry-of", operation.retryOf);
      return args;
    }
    case "show_worker":
      return ["orchestration", "worker-show", "--dispatch", operation.dispatchId];
    case "read_worker": {
      const args = ["orchestration", "worker-read", "--dispatch", operation.dispatchId];
      if (operation.limit !== undefined) args.push("--limit", String(operation.limit));
      if (operation.cursor !== undefined) args.push("--cursor", operation.cursor);
      return args;
    }
    case "stop_worker":
      return ["orchestration", "worker-stop", "--dispatch", operation.dispatchId];
    case "release_worker":
      return ["orchestration", "worker-release", "--dispatch", operation.dispatchId];
    case "operations_show_worker": return ["orchestration", "worker-show", "--dispatch", operation.dispatchId];
    case "operations_status": return ["status"];
    case "operations_dispatch": return ["orchestration", "dispatch", "--task", operation.taskId, "--to", operation.terminalHandle, ...(operation.inject ? ["--inject"] : []), "--retry-request", operation.retryRequestId, ...(operation.senderHandle ? ["--from", operation.senderHandle] : []), ...(operation.runId ? ["--run", operation.runId] : [])];
    case "operations_reply": return ["orchestration", "reply", "--id", operation.messageId, "--body", operation.body, "--retry-request", operation.retryRequestId, ...(operation.senderHandle ? ["--from", operation.senderHandle] : []), ...(operation.runId ? ["--run", operation.runId] : [])];
    case "operations_send": return ["orchestration", "send", "--subject", "HQ operator follow-up", "--to", `dispatch:${operation.dispatchId}`, "--type", "status", "--body", operation.body, "--retry-request", operation.retryRequestId, ...(operation.senderHandle ? ["--from", operation.senderHandle] : []), ...(operation.runId ? ["--run", operation.runId] : [])];
    case "operations_stop": return ["orchestration", "worker-stop", "--dispatch", operation.dispatchId, "--retry-request", operation.retryRequestId];
    case "operations_retain": return ["orchestration", "worker-retain", "--dispatch", operation.dispatchId, "--retry-request", operation.retryRequestId];
    case "operations_release": return ["orchestration", "worker-release", "--dispatch", operation.dispatchId, "--retry-request", operation.retryRequestId];
    case "list_runs": return pageArgs(["orchestration", "run-list"], operation);
    case "show_run": return ["orchestration", "run-show", "--id", operation.runId];
    case "list_tasks": return ["orchestration", "task-list", "--run", operation.runId, "--brief"];
    case "list_workers": return pageArgs(operation.runId === undefined ? ["orchestration", "worker-list"] : ["orchestration", "worker-list", "--run", operation.runId], operation);
    case "operations_worker_read": return pageArgs(["orchestration", "worker-read", "--dispatch", operation.dispatchId, "--source", operation.source], operation);
    case "operations_inbox": return pageArgs(["orchestration", "inbox"], operation);
    case "operations_list_projects": return ["project", "list"];
    case "list_project_setups": return ["project", "setups", "--project", operation.projectId];
    case "list_worktrees": return pageArgs(["worktree", "list", "--repo", `id:${operation.repoId}`], operation);
    case "show_worktree": return ["worktree", "show", "--worktree", operation.worktreeId];
    case "list_terminals": return ["terminal", "list", "--worktree", operation.worktreeId];
    case "show_terminal": return ["terminal", "show", "--terminal", operation.terminalHandle];
    case "read_terminal": return pageArgs(["terminal", "read", "--terminal", operation.terminalHandle], operation);
  }
}

function pageArgs(args: string[], page: { readonly limit?: number | undefined; readonly cursor?: string | undefined }): readonly string[] {
  if (page.limit !== undefined) args.push("--limit", String(page.limit));
  if (page.cursor !== undefined) args.push("--cursor", page.cursor);
  return args;
}
