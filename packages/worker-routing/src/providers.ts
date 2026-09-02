import { createHash } from "node:crypto";

import {
  PreferredAgentSchema,
  TaskRoleSchema,
  type PreferredAgent,
  type TaskRole
} from "@orca-hq/core";
import {
  OrcaReceiptSchema,
  parseOrcaOperationReceipt,
  type OrcaOperation,
  type OrcaReceipt
} from "@orca-hq/orca-adapter";
import { z } from "zod";

import {
  AssignmentArtifactSchema,
  type AssignmentArtifact
} from "./assignment-artifacts.js";
import {
  WorkerAssignmentSchema,
  parseWorkerAssignment,
  type WorkerAssignment
} from "./lifecycle.js";

const NonBlankStringSchema = z.string().trim().min(1);

export const SAFE_PROVIDER_ENVIRONMENT_KEYS = Object.freeze([
  "HOME",
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TERM",
  "COLORTERM",
  "USER",
  "LOGNAME",
  "SHELL",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
  "__CF_USER_TEXT_ENCODING"
] as const);

const SafeProviderEnvironmentKeySchema = z.enum(SAFE_PROVIDER_ENVIRONMENT_KEYS);
const EffectiveEnvironmentKeysSchema = z.array(SafeProviderEnvironmentKeySchema)
  .min(1)
  .superRefine((keys, context) => {
    if (new Set(keys).size !== keys.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "environment keys must be unique" });
    }
  });

export const ProviderChildEnvironmentIsolationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unsupported") }).strict(),
  z.object({
    kind: z.literal("verified_effective_allowlist"),
    effectiveEnvironmentKeys: EffectiveEnvironmentKeysSchema
  }).strict()
]);

export type ProviderChildEnvironmentIsolation = Readonly<
  z.infer<typeof ProviderChildEnvironmentIsolationSchema>
>;

export const AssignmentArtifactAccessSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("same_host") }).strict(),
  z.object({ kind: z.literal("unsupported") }).strict()
]);

export type AssignmentArtifactAccess = Readonly<
  z.infer<typeof AssignmentArtifactAccessSchema>
>;

export const WorkerProviderIdSchema = PreferredAgentSchema;
export type WorkerProviderId = PreferredAgent;

const ProviderAvailabilitySchema = z.enum([
  "available",
  "unavailable",
  "authentication_required"
]);

export const ProviderCapabilitiesSchema = z.object({
  codex: z.object({
    worker: ProviderAvailabilitySchema,
    hq: ProviderAvailabilitySchema
  }).strict(),
  claude: z.object({
    worker: ProviderAvailabilitySchema,
    hq: ProviderAvailabilitySchema
  }).strict(),
  providerChildEnvironmentIsolation: ProviderChildEnvironmentIsolationSchema,
  assignmentArtifactAccess: AssignmentArtifactAccessSchema
}).strict();

export type ProviderAvailability = z.infer<typeof ProviderAvailabilitySchema>;
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

export const DEFAULT_PROVIDER_CAPABILITIES: ProviderCapabilities = Object.freeze({
  codex: Object.freeze({ worker: "available", hq: "available" }),
  claude: Object.freeze({ worker: "available", hq: "unavailable" }),
  providerChildEnvironmentIsolation: Object.freeze({ kind: "unsupported" }),
  assignmentArtifactAccess: Object.freeze({ kind: "unsupported" })
});

const ProviderSelectionInputSchema = z.object({
  role: z.union([TaskRoleSchema, z.literal("hq")]),
  preferredAgent: WorkerProviderIdSchema
}).strict();

export type ProviderSelectionInput = Readonly<{
  role: TaskRole | "hq";
  preferredAgent: WorkerProviderId;
}>;

export type ProviderSelection = Readonly<
  | { kind: "selected"; provider: WorkerProviderId }
  | {
      kind: "unavailable";
      provider: WorkerProviderId;
      reason:
        | "hq_requires_codex"
        | "provider_unavailable"
        | "provider_authentication_required"
        | "provider_environment_isolation_unavailable"
        | "provider_assignment_artifact_access_unavailable";
    }
>;

function unavailableSelection(
  provider: WorkerProviderId,
  availability: Exclude<ProviderAvailability, "available">
): ProviderSelection {
  return Object.freeze({
    kind: "unavailable",
    provider,
    reason: availability === "authentication_required"
      ? "provider_authentication_required"
      : "provider_unavailable"
  });
}

export function selectProvider(
  inputValue: ProviderSelectionInput,
  capabilitiesValue: ProviderCapabilities
): ProviderSelection {
  const input = ProviderSelectionInputSchema.parse(inputValue);
  const capabilities = ProviderCapabilitiesSchema.parse(capabilitiesValue);
  if (input.role === "hq" && input.preferredAgent !== "codex") {
    return Object.freeze({
      kind: "unavailable",
      provider: input.preferredAgent,
      reason: "hq_requires_codex"
    });
  }
  if (
    input.role !== "hq"
    && capabilities.providerChildEnvironmentIsolation.kind === "unsupported"
  ) {
    return Object.freeze({
      kind: "unavailable",
      provider: input.preferredAgent,
      reason: "provider_environment_isolation_unavailable"
    });
  }
  if (input.role !== "hq" && capabilities.assignmentArtifactAccess.kind === "unsupported") {
    return Object.freeze({
      kind: "unavailable",
      provider: input.preferredAgent,
      reason: "provider_assignment_artifact_access_unavailable"
    });
  }
  const availability = input.role === "hq"
    ? capabilities.codex.hq
    : capabilities[input.preferredAgent].worker;
  return availability === "available"
    ? Object.freeze({ kind: "selected", provider: input.preferredAgent })
    : unavailableSelection(input.preferredAgent, availability);
}

export function providerFor(assignmentValue: WorkerAssignment): WorkerProviderId {
  return parseWorkerAssignment(assignmentValue).preferredAgent;
}

export const WorkerPromptSchema = z.object({
  protocol: z.literal(1),
  assignment: WorkerAssignmentSchema,
  nestedWorkers: z.literal("forbidden"),
  reportExactlyOnce: z.literal(true)
}).strict();

export type WorkerPrompt = z.infer<typeof WorkerPromptSchema>;

export function workerPrompt(assignmentValue: WorkerAssignment): string {
  const assignment = parseWorkerAssignment(assignmentValue);
  const prompt = WorkerPromptSchema.parse({
    protocol: 1,
    assignment,
    nestedWorkers: "forbidden",
    reportExactlyOnce: true
  });
  return JSON.stringify(prompt);
}

const ProviderStartContextSchema = z.object({
  orcaTaskId: NonBlankStringSchema,
  name: NonBlankStringSchema.optional(),
  setup: z.enum(["run", "skip", "inherit"]).optional(),
  retryOf: NonBlankStringSchema.optional(),
  assignmentArtifact: AssignmentArtifactSchema,
  providerEnvironmentIsolation: ProviderChildEnvironmentIsolationSchema,
  assignmentArtifactAccess: AssignmentArtifactAccessSchema
}).strict();

export type ProviderStartContext = Readonly<z.infer<typeof ProviderStartContextSchema>>;

const ProviderBoundarySchema = z.object({
  lifecycleAuthority: z.literal("orca_worker_start"),
  promptDelivery: z.literal("prestart_atomic_assignment_artifact"),
  attemptContext: z.literal("orca_injected_task_spec_and_prestart_assignment"),
  credentialSource: z.literal("provider_authenticated_cli"),
  postStartMail: z.literal(false),
  providerChildEnvironmentIsolation: ProviderChildEnvironmentIsolationSchema.refine(
    (value) => value.kind === "verified_effective_allowlist"
  ),
  assignmentArtifactAccess: z.object({ kind: z.literal("same_host") }).strict()
}).strict();

export const ProviderStartReceiptSchema = z.object({
  kind: z.literal("provider_start"),
  protocol: z.literal(1),
  provider: WorkerProviderIdSchema,
  assignmentTaskId: NonBlankStringSchema,
  assignmentDispatchId: NonBlankStringSchema,
  orcaTaskId: NonBlankStringSchema,
  orcaDispatchId: NonBlankStringSchema,
  promptArtifact: AssignmentArtifactSchema,
  boundary: ProviderBoundarySchema,
  orcaReceipt: OrcaReceiptSchema
}).strict();

export const ProviderInspectReceiptSchema = z.object({
  kind: z.literal("provider_inspect"),
  protocol: z.literal(1),
  provider: WorkerProviderIdSchema,
  dispatchId: NonBlankStringSchema,
  workerState: NonBlankStringSchema,
  showReceipt: OrcaReceiptSchema,
  readReceipt: OrcaReceiptSchema
}).strict();

type ParsedProviderStartReceipt = z.infer<typeof ProviderStartReceiptSchema>;
type ParsedProviderInspectReceipt = z.infer<typeof ProviderInspectReceiptSchema>;

export type ProviderStartReceipt = Readonly<
  Omit<ParsedProviderStartReceipt, "orcaReceipt"> & { readonly orcaReceipt: OrcaReceipt }
>;
export type ProviderInspectReceipt = Readonly<
  Omit<ParsedProviderInspectReceipt, "showReceipt" | "readReceipt"> & {
    readonly showReceipt: OrcaReceipt;
    readonly readReceipt: OrcaReceipt;
  }
>;

export type WorkerProviderFailureCode =
  | "provider_mismatch"
  | "provider_unavailable"
  | "provider_authentication_required"
  | "provider_process_failed"
  | "provider_environment_isolation_unavailable"
  | "provider_assignment_artifact_access_unavailable"
  | "stale_dispatch"
  | "invalid_provider_receipt";

export class WorkerProviderError extends Error {
  readonly code: WorkerProviderFailureCode;
  readonly provider: WorkerProviderId;
  readonly phase: "start" | "inspect";
  readonly retryable = false;
  readonly workerMayBeLive: boolean;
  readonly trustedDispatchId?: string | undefined;

  constructor(
    code: WorkerProviderFailureCode,
    provider: WorkerProviderId,
    phase: "start" | "inspect",
    options: Readonly<{
      workerMayBeLive?: boolean;
      trustedDispatchId?: string;
    }> = {}
  ) {
    super(`Worker provider ${phase} failed`);
    this.name = "WorkerProviderError";
    this.code = code;
    this.provider = provider;
    this.phase = phase;
    this.workerMayBeLive = options.workerMayBeLive === true;
    if (options.trustedDispatchId !== undefined) {
      this.trustedDispatchId = options.trustedDispatchId;
    }
  }
}

function classifiedProviderError(
  provider: WorkerProviderId,
  phase: "start" | "inspect",
  error: unknown
): WorkerProviderError {
  if (error instanceof WorkerProviderError) return error;
  const value = error as {
    code?: unknown;
    orcaCode?: unknown;
    workerMayBeLive?: unknown;
    trustedDispatchId?: unknown;
  };
  if (value?.code === "orca_stale_handle") {
    return new WorkerProviderError("stale_dispatch", provider, phase);
  }
  if (value?.code === "invalid_orca_receipt") {
    return new WorkerProviderError("invalid_provider_receipt", provider, phase, {
      workerMayBeLive: value.workerMayBeLive === true,
      ...(typeof value.trustedDispatchId === "string" && value.trustedDispatchId.length > 0
        ? { trustedDispatchId: value.trustedDispatchId }
        : {})
    });
  }
  if (value?.code === "orca_command_failed") {
    if (
      value.orcaCode === "authentication_required"
      || value.orcaCode === "auth_required"
      || value.orcaCode === "provider_authentication_required"
    ) {
      return new WorkerProviderError("provider_authentication_required", provider, phase);
    }
    if (
      value.orcaCode === "provider_unavailable"
      || value.orcaCode === "agent_unavailable"
      || value.orcaCode === "agent_not_found"
    ) {
      return new WorkerProviderError("provider_unavailable", provider, phase);
    }
  }
  return new WorkerProviderError("provider_process_failed", provider, phase);
}

function explicitOrcaRejection(error: unknown): boolean {
  return (error as { code?: unknown })?.code === "orca_command_failed";
}

function startResult(receipt: OrcaReceipt, expectedTaskId: string): Readonly<{
  dispatchId: string;
  taskId: string;
  providerEnvironmentIsolation: Extract<
    ProviderChildEnvironmentIsolation,
    { kind: "verified_effective_allowlist" }
  >;
}> {
  const result = receipt.result as {
    dispatchId?: unknown;
    taskId?: unknown;
    launch?: {
      providerEnvironment?: unknown;
    };
  };
  if (
    typeof result.dispatchId !== "string"
    || result.dispatchId.length === 0
    || typeof result.taskId !== "string"
    || result.taskId.length === 0
  ) {
    throw Object.assign(new Error("invalid provider start receipt"), {
      code: "invalid_orca_receipt"
    });
  }
  if (result.taskId !== expectedTaskId) {
    throw Object.assign(new Error("provider start receipt Task mismatch"), {
      code: "invalid_orca_receipt",
      workerMayBeLive: true
    });
  }
  const isolation = ProviderChildEnvironmentIsolationSchema.safeParse(
    result.launch?.providerEnvironment
  );
  if (!isolation.success || isolation.data.kind !== "verified_effective_allowlist") {
    throw Object.assign(new Error("invalid provider start environment attestation"), {
      code: "invalid_orca_receipt",
      workerMayBeLive: true,
      trustedDispatchId: result.dispatchId
    });
  }
  return Object.freeze({
    dispatchId: result.dispatchId,
    taskId: result.taskId,
    providerEnvironmentIsolation: isolation.data
  });
}

function showResult(receipt: OrcaReceipt): Readonly<{
  dispatchId: string;
  workerDispatchId: string;
  workerState: string;
  exactWorker: boolean;
}> {
  const result = receipt.result as {
    dispatch?: { id?: unknown };
    worker?: { dispatch_id?: unknown; state?: unknown };
    observation?: { exactWorker?: unknown };
  };
  if (
    typeof result.dispatch?.id !== "string"
    || typeof result.worker?.dispatch_id !== "string"
    || typeof result.worker.state !== "string"
    || typeof result.observation?.exactWorker !== "boolean"
  ) {
    throw Object.assign(new Error("invalid provider inspect receipt"), {
      code: "invalid_orca_receipt"
    });
  }
  return Object.freeze({
    dispatchId: result.dispatch.id,
    workerDispatchId: result.worker.dispatch_id,
    workerState: result.worker.state,
    exactWorker: result.observation.exactWorker
  });
}

function readDispatchId(receipt: OrcaReceipt): string {
  const result = receipt.result as { dispatchId?: unknown };
  if (typeof result.dispatchId !== "string" || result.dispatchId.length === 0) {
    throw Object.assign(new Error("invalid provider read receipt"), {
      code: "invalid_orca_receipt"
    });
  }
  return result.dispatchId;
}

export interface WorkerProviderOrcaPort {
  execute(operation: OrcaOperation): Promise<OrcaReceipt>;
}

export interface OrcaWorkerProviderOptions {
  readonly orca: WorkerProviderOrcaPort;
}

export interface WorkerProvider {
  readonly id: WorkerProviderId;
  start(
    assignment: WorkerAssignment,
    context: ProviderStartContext
  ): Promise<ProviderStartReceipt>;
  inspect(dispatchId: string): Promise<ProviderInspectReceipt>;
}

export class OrcaWorkerProvider implements WorkerProvider {
  readonly id: WorkerProviderId;
  readonly #orca: WorkerProviderOrcaPort;

  constructor(id: WorkerProviderId, options: OrcaWorkerProviderOptions) {
    this.id = WorkerProviderIdSchema.parse(id);
    this.#orca = options.orca;
  }

  async start(
    assignmentValue: WorkerAssignment,
    contextValue: ProviderStartContext
  ): Promise<ProviderStartReceipt> {
    const assignment = parseWorkerAssignment(assignmentValue);
    const context = ProviderStartContextSchema.parse(contextValue);
    if (assignment.preferredAgent !== this.id) {
      throw new WorkerProviderError("provider_mismatch", this.id, "start");
    }
    if (context.providerEnvironmentIsolation.kind === "unsupported") {
      throw new WorkerProviderError(
        "provider_environment_isolation_unavailable",
        this.id,
        "start"
      );
    }
    if (context.assignmentArtifactAccess.kind === "unsupported") {
      throw new WorkerProviderError(
        "provider_assignment_artifact_access_unavailable",
        this.id,
        "start"
      );
    }
    const prompt = workerPrompt(assignment);
    const promptSha256 = createHash("sha256").update(prompt).digest("hex");
    const promptArtifact: AssignmentArtifact = context.assignmentArtifact;
    if (
      promptArtifact.ownerDispatchId !== assignment.dispatchId
      || promptArtifact.content !== prompt
      || promptArtifact.sha256 !== promptSha256
    ) {
      throw new WorkerProviderError("invalid_provider_receipt", this.id, "start");
    }
    const operation: OrcaOperation = {
      kind: "dispatch_worker",
      taskId: context.orcaTaskId,
      worktree: assignment.worktree.path,
      agent: this.id,
      ...(context.name === undefined ? {} : { name: context.name }),
      ...(context.setup === undefined ? {} : { setup: context.setup }),
      ...(context.retryOf === undefined ? {} : { retryOf: context.retryOf })
    };

    try {
      const rawReceipt = await this.#orca.execute(operation);
      const orcaReceipt = parseOrcaOperationReceipt("dispatch_worker", rawReceipt);
      const result = startResult(orcaReceipt, context.orcaTaskId);
      if (
        JSON.stringify(result.providerEnvironmentIsolation.effectiveEnvironmentKeys)
          !== JSON.stringify(context.providerEnvironmentIsolation.effectiveEnvironmentKeys)
      ) {
        throw new WorkerProviderError("invalid_provider_receipt", this.id, "start", {
          workerMayBeLive: true,
          trustedDispatchId: result.dispatchId
        });
      }
      return Object.freeze(ProviderStartReceiptSchema.parse({
        kind: "provider_start",
        protocol: 1,
        provider: this.id,
        assignmentTaskId: assignment.taskId,
        assignmentDispatchId: assignment.dispatchId,
        orcaTaskId: context.orcaTaskId,
        orcaDispatchId: result.dispatchId,
        promptArtifact,
        boundary: {
          lifecycleAuthority: "orca_worker_start",
          promptDelivery: "prestart_atomic_assignment_artifact",
          attemptContext: "orca_injected_task_spec_and_prestart_assignment",
          credentialSource: "provider_authenticated_cli",
          postStartMail: false,
          providerChildEnvironmentIsolation: result.providerEnvironmentIsolation,
          assignmentArtifactAccess: context.assignmentArtifactAccess
        },
        orcaReceipt
      })) as ProviderStartReceipt;
    } catch (error) {
      const classified = classifiedProviderError(this.id, "start", error);
      if (classified.workerMayBeLive || explicitOrcaRejection(error)) throw classified;
      throw new WorkerProviderError(classified.code, this.id, "start", {
        workerMayBeLive: true
      });
    }
  }

  async inspect(dispatchIdValue: string): Promise<ProviderInspectReceipt> {
    const dispatchId = NonBlankStringSchema.parse(dispatchIdValue);
    try {
      const showReceipt = parseOrcaOperationReceipt(
        "show_worker",
        await this.#orca.execute({ kind: "show_worker", dispatchId })
      );
      const shown = showResult(showReceipt);
      if (
        !shown.exactWorker
        || shown.dispatchId !== dispatchId
        || shown.workerDispatchId !== dispatchId
      ) {
        throw new WorkerProviderError("stale_dispatch", this.id, "inspect");
      }
      const readReceipt = parseOrcaOperationReceipt(
        "read_worker",
        await this.#orca.execute({ kind: "read_worker", dispatchId, limit: 100 })
      );
      if (readDispatchId(readReceipt) !== dispatchId) {
        throw new WorkerProviderError("stale_dispatch", this.id, "inspect");
      }
      return Object.freeze(ProviderInspectReceiptSchema.parse({
        kind: "provider_inspect",
        protocol: 1,
        provider: this.id,
        dispatchId,
        workerState: shown.workerState,
        showReceipt,
        readReceipt
      })) as ProviderInspectReceipt;
    } catch (error) {
      throw classifiedProviderError(this.id, "inspect", error);
    }
  }
}

export class WorkerProviderRegistry {
  readonly #providers = new Map<WorkerProviderId, WorkerProvider>();

  constructor(providers: Iterable<WorkerProvider>) {
    for (const provider of providers) {
      const id = WorkerProviderIdSchema.parse(provider.id);
      if (this.#providers.has(id)) throw new TypeError(`duplicate worker provider: ${id}`);
      this.#providers.set(id, provider);
    }
  }

  get(idValue: WorkerProviderId): WorkerProvider {
    const id = WorkerProviderIdSchema.parse(idValue);
    const provider = this.#providers.get(id);
    if (provider === undefined) {
      throw new WorkerProviderError("provider_unavailable", id, "start");
    }
    return provider;
  }
}
