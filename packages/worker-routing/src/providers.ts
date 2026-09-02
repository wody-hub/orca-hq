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
  WorkerAssignmentSchema,
  parseWorkerAssignment,
  type WorkerAssignment
} from "./lifecycle.js";

const NonBlankStringSchema = z.string().trim().min(1);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

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
  }).strict()
}).strict();

export type ProviderAvailability = z.infer<typeof ProviderAvailabilitySchema>;
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

export const DEFAULT_PROVIDER_CAPABILITIES: ProviderCapabilities = Object.freeze({
  codex: Object.freeze({ worker: "available", hq: "available" }),
  claude: Object.freeze({ worker: "available", hq: "unavailable" })
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
      reason: "hq_requires_codex" | "provider_unavailable" | "provider_authentication_required";
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
  retryOf: NonBlankStringSchema.optional()
}).strict();

export type ProviderStartContext = Readonly<z.infer<typeof ProviderStartContextSchema>>;

const ProviderPromptArtifactSchema = z.object({
  content: NonBlankStringSchema,
  sha256: Sha256Schema
}).strict();

const ProviderBoundarySchema = z.object({
  lifecycleAuthority: z.literal("orca_worker_start"),
  promptDelivery: z.literal("persisted_launch_artifact"),
  attemptContext: z.literal("orca_injected_preamble_and_persisted_assignment"),
  credentialSource: z.literal("provider_authenticated_cli"),
  postStartMail: z.literal(false),
  forwardedEnvironmentKeys: z.tuple([])
}).strict();

export const ProviderStartReceiptSchema = z.object({
  kind: z.literal("provider_start"),
  protocol: z.literal(1),
  provider: WorkerProviderIdSchema,
  assignmentTaskId: NonBlankStringSchema,
  assignmentDispatchId: NonBlankStringSchema,
  orcaTaskId: NonBlankStringSchema,
  orcaDispatchId: NonBlankStringSchema,
  promptArtifact: ProviderPromptArtifactSchema,
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
  | "stale_dispatch"
  | "invalid_provider_receipt";

export class WorkerProviderError extends Error {
  readonly code: WorkerProviderFailureCode;
  readonly provider: WorkerProviderId;
  readonly phase: "start" | "inspect";
  readonly retryable = false;

  constructor(
    code: WorkerProviderFailureCode,
    provider: WorkerProviderId,
    phase: "start" | "inspect"
  ) {
    super(`Worker provider ${phase} failed`);
    this.name = "WorkerProviderError";
    this.code = code;
    this.provider = provider;
    this.phase = phase;
  }
}

function classifiedProviderError(
  provider: WorkerProviderId,
  phase: "start" | "inspect",
  error: unknown
): WorkerProviderError {
  if (error instanceof WorkerProviderError) return error;
  const value = error as { code?: unknown; orcaCode?: unknown };
  if (value?.code === "orca_stale_handle") {
    return new WorkerProviderError("stale_dispatch", provider, phase);
  }
  if (value?.code === "invalid_orca_receipt") {
    return new WorkerProviderError("invalid_provider_receipt", provider, phase);
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

function startResult(receipt: OrcaReceipt): Readonly<{
  dispatchId: string;
  taskId: string;
}> {
  const result = receipt.result as { dispatchId?: unknown; taskId?: unknown };
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
  return Object.freeze({ dispatchId: result.dispatchId, taskId: result.taskId });
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
    const prompt = workerPrompt(assignment);
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
      const orcaReceipt = parseOrcaOperationReceipt(
        "dispatch_worker",
        await this.#orca.execute(operation)
      );
      const result = startResult(orcaReceipt);
      if (result.taskId !== context.orcaTaskId) {
        throw new WorkerProviderError("invalid_provider_receipt", this.id, "start");
      }
      return Object.freeze(ProviderStartReceiptSchema.parse({
        kind: "provider_start",
        protocol: 1,
        provider: this.id,
        assignmentTaskId: assignment.taskId,
        assignmentDispatchId: assignment.dispatchId,
        orcaTaskId: context.orcaTaskId,
        orcaDispatchId: result.dispatchId,
        promptArtifact: {
          content: prompt,
          sha256: createHash("sha256").update(prompt).digest("hex")
        },
        boundary: {
          lifecycleAuthority: "orca_worker_start",
          promptDelivery: "persisted_launch_artifact",
          attemptContext: "orca_injected_preamble_and_persisted_assignment",
          credentialSource: "provider_authenticated_cli",
          postStartMail: false,
          forwardedEnvironmentKeys: []
        },
        orcaReceipt
      })) as ProviderStartReceipt;
    } catch (error) {
      throw classifiedProviderError(this.id, "start", error);
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
