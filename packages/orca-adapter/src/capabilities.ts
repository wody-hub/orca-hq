import { satisfies, validRange } from "semver";
import { z } from "zod";

export const REQUIRED_ORCA_CAPABILITIES = Object.freeze([
  "orchestration.contract.v1",
  "orchestration.worker-stop-verdict.v1",
  "orchestration.worker-launch-preferences.v1"
] as const);

export const MINIMUM_ORCA_VERSION = "1.4.194" as const;

const NonEmptyStringSchema = z.string().min(1);
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
  }).strict()
]);

export type OrcaOperation = z.input<typeof OrcaOperationSchema>;
export type ValidatedOrcaOperation = z.output<typeof OrcaOperationSchema>;

const mutationKinds: ReadonlySet<ValidatedOrcaOperation["kind"]> = new Set([
  "create_run",
  "create_task",
  "dispatch_worker",
  "stop_worker",
  "release_worker"
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
  }
}
