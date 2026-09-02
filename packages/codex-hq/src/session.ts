import {
  CommandEnvelopeSchema,
  ExecutionProposalSchema,
  type CommandEnvelope,
  type ExecutionProposal
} from "@orca-hq/core";
import {
  decideRankedRoute,
  ProjectRegistryEntrySchema,
  type ProjectRegistryEntry
} from "@orca-hq/project-registry";

import {
  CODEX_HQ_MODEL,
  CODEX_HQ_PROTOCOL_VERSION,
  CODEX_TERRA_MODEL,
  CodexEventSchema,
  CodexPortError,
  HQ_TOOL_NAMES,
  HqQueueClaimSchema,
  HqModelConfigurationSchema,
  PolicyPreviewResultSchema,
  TerraAssistanceSchema,
  type CodexCliPort,
  type CodexCliTurn,
  type CodexEvent,
  type CodexToolResponse,
  type HqFailureReason,
  type HqModelConfiguration,
  type HqQueueTerminalRecord,
  type HqResult,
  type OrderedCommandQueuePort,
  type PolicyPreviewPort,
  type RegistryQueryPort,
  type TerraAssistance,
  type TerraAssistancePort
} from "./protocol.js";
import {
  InspectProjectInputSchema,
  PreviewPolicyInputSchema,
  SearchProjectsInputSchema,
  hqTools
} from "./tools.js";

export interface CodexHqSessionOptions {
  readonly models: HqModelConfiguration;
  readonly codex: CodexCliPort;
  readonly queue: OrderedCommandQueuePort;
  readonly registry: RegistryQueryPort;
  readonly policy: PolicyPreviewPort;
  readonly terra?: TerraAssistancePort | undefined;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

interface PendingQueueRecord {
  readonly disposition: "complete" | "defer";
  readonly record: HqQueueTerminalRecord;
}

type ModelTerminal =
  | Readonly<{ kind: "proposal"; proposal: ExecutionProposal }>
  | Readonly<{ kind: "clarification"; clarification: unknown }>
  | Readonly<{ kind: "failure"; reason: HqFailureReason }>
  | Readonly<{ kind: "degraded"; reason: "codex_unavailable" }>;

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    }
  };
}

function failure(reason: HqFailureReason): HqResult {
  return { kind: "failure", reason };
}

function unavailableReason(reason: string): boolean {
  return reason === "authentication_required"
    || reason === "quota_unavailable"
    || reason === "runtime_unavailable";
}

function claimedDifferentModel(event: unknown): boolean {
  if (typeof event !== "object" || event === null || !("model" in event)) return false;
  const model = (event as { model?: unknown }).model;
  return typeof model === "string" && model !== CODEX_HQ_MODEL;
}

function rejectedToolCallId(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  if (
    !("type" in event)
    || event.type !== "tool_call"
    || !("callId" in event)
    || typeof event.callId !== "string"
    || event.callId.length === 0
  ) return undefined;
  return event.callId;
}

function terminalTool(tool: string): boolean {
  return tool === "submitProposal" || tool === "askClarification";
}

export class CodexHqSession {
  readonly #models: HqModelConfiguration;
  readonly #codex: CodexCliPort;
  readonly #queue: OrderedCommandQueuePort;
  readonly #registry: RegistryQueryPort;
  readonly #policy: PolicyPreviewPort;
  readonly #terra: TerraAssistancePort | undefined;
  readonly #waiting = new Map<string, Deferred<HqResult>>();
  readonly #submittedCommandIds = new Set<string>();
  #drainTail: Promise<void> = Promise.resolve();
  #pendingRecord: PendingQueueRecord | undefined;
  #codexUnavailable = false;

  constructor(options: CodexHqSessionOptions) {
    this.#models = HqModelConfigurationSchema.parse(options.models);
    if (options.terra !== undefined && this.#models.assistantModel === undefined) {
      throw new TypeError("Terra assistance requires the configured gpt-5.6-terra model");
    }
    this.#codex = options.codex;
    this.#queue = options.queue;
    this.#registry = options.registry;
    this.#policy = options.policy;
    this.#terra = options.terra;
  }

  async plan(commandInput: CommandEnvelope): Promise<HqResult> {
    const parsedCommand = CommandEnvelopeSchema.safeParse(commandInput);
    if (!parsedCommand.success) return failure("invalid_command");
    const command = parsedCommand.data;
    if (
      this.#waiting.has(command.commandId)
      || this.#submittedCommandIds.has(command.commandId)
    ) return failure("duplicate_command");

    const waiting = deferred<HqResult>();
    this.#waiting.set(command.commandId, waiting);
    try {
      await this.#queue.enqueue(command);
      this.#submittedCommandIds.add(command.commandId);
    } catch {
      this.#waiting.delete(command.commandId);
      return failure("queue_unavailable");
    }

    void this.#scheduleDrain();
    return waiting.promise;
  }

  /** Retries a paused durable queue drain after the queue adapter reports recovery. */
  async resume(): Promise<void> {
    await this.#scheduleDrain();
  }

  #scheduleDrain(): Promise<void> {
    const nextDrain = this.#drainTail.then(async () => this.#drain());
    this.#drainTail = nextDrain.catch(() => undefined);
    return this.#drainTail;
  }

  async #drain(): Promise<void> {
    while (true) {
      const pendingRecord = this.#pendingRecord;
      if (pendingRecord !== undefined) {
        if (!await this.#persist(pendingRecord)) return;
        this.#pendingRecord = undefined;
        this.#resolve(pendingRecord.record.commandId, pendingRecord.record.result);
        continue;
      }

      let claimInput: unknown;
      try {
        claimInput = await this.#queue.claimNext();
      } catch {
        return;
      }
      if (claimInput === undefined) return;
      const parsedClaim = HqQueueClaimSchema.safeParse(claimInput);
      if (!parsedClaim.success) return;
      const claim = parsedClaim.data;
      const commandInput = claim.command;

      const parsedCommand = CommandEnvelopeSchema.safeParse(commandInput);
      if (!parsedCommand.success) {
        const invalid = failure("invalid_command");
        const commandId = typeof commandInput === "object"
          && commandInput !== null
          && "commandId" in commandInput
          && typeof commandInput.commandId === "string"
          ? commandInput.commandId
          : "invalid-command";
        this.#pendingRecord = {
          disposition: "complete",
          record: Object.freeze({ claimToken: claim.claimToken, commandId, result: invalid })
        };
        continue;
      }

      const command = parsedCommand.data;
      const result = this.#codexUnavailable
        ? { kind: "degraded", reason: "codex_unavailable" } as const
        : await this.#coordinate(command);
      if (result.kind === "degraded") this.#codexUnavailable = true;

      this.#pendingRecord = {
        disposition: result.kind === "degraded" ? "defer" : "complete",
        record: Object.freeze({
          claimToken: claim.claimToken,
          commandId: command.commandId,
          result
        })
      };
    }
  }

  async #persist(record: PendingQueueRecord): Promise<boolean> {
    try {
      if (record.disposition === "defer") await this.#queue.defer(record.record);
      else await this.#queue.complete(record.record);
      return true;
    } catch {
      return false;
    }
  }

  #resolve(commandId: string, result: HqResult): void {
    const waiting = this.#waiting.get(commandId);
    this.#waiting.delete(commandId);
    waiting?.resolve(result);
  }

  async #coordinate(command: CommandEnvelope): Promise<HqResult> {
    const assistance = await this.#terraAssistance(command);
    let turn: CodexCliTurn;
    try {
      turn = await this.#codex.openTurn(Object.freeze({
        protocol: CODEX_HQ_PROTOCOL_VERSION,
        model: CODEX_HQ_MODEL,
        command,
        tools: HQ_TOOL_NAMES,
        ...(assistance === undefined ? {} : { assistance })
      }));
    } catch (error) {
      if (error instanceof CodexPortError && unavailableReason(error.code)) {
        return { kind: "degraded", reason: "codex_unavailable" };
      }
      return failure("codex_runtime_failed");
    }

    let terminal: ModelTerminal;
    let closeFailed = false;
    try {
      terminal = await this.#readTurn(command, turn);
    } finally {
      try {
        await turn.close();
      } catch {
        closeFailed = true;
      }
    }

    if (closeFailed) return failure("codex_runtime_failed");

    if (terminal.kind === "failure" || terminal.kind === "degraded") return terminal;
    if (terminal.kind === "clarification") {
      const parsed = hqTools.askClarification.safeParse(terminal.clarification);
      if (!parsed.success || parsed.data.commandId !== command.commandId) {
        return failure("invalid_model_output");
      }
      return { kind: "clarification", clarification: parsed.data };
    }
    return this.#validateProposal(command, terminal.proposal);
  }

  async #terraAssistance(command: CommandEnvelope): Promise<TerraAssistance | undefined> {
    if (
      this.#models.assistantModel !== CODEX_TERRA_MODEL
      || this.#terra === undefined
    ) return undefined;

    try {
      const output = await this.#terra.assist({
        model: CODEX_TERRA_MODEL,
        text: command.text
      });
      const parsed = TerraAssistanceSchema.safeParse(output);
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  async #readTurn(command: CommandEnvelope, turn: CodexCliTurn): Promise<ModelTerminal> {
    let terminal: ModelTerminal | undefined;
    let terminalCount = 0;
    let protocolFailure: HqFailureReason | undefined;

    try {
      for await (const eventInput of turn.events) {
        const parsedEvent = CodexEventSchema.safeParse(eventInput);
        if (!parsedEvent.success) {
          protocolFailure ??= claimedDifferentModel(eventInput)
            ? "invalid_model_authority"
            : "invalid_model_event";
          const callId = rejectedToolCallId(eventInput);
          if (callId !== undefined) {
            await this.#respond(turn, {
              callId,
              ok: false,
              error: { code: "invalid_tool_input" }
            });
          }
          continue;
        }
        const event = parsedEvent.data;

        if (event.type === "failure") {
          terminalCount += 1;
          if (terminal === undefined) {
            terminal = unavailableReason(event.reason)
              ? { kind: "degraded", reason: "codex_unavailable" }
              : { kind: "failure", reason: "codex_runtime_failed" };
          }
          continue;
        }

        if (terminalTool(event.tool)) {
          terminalCount += 1;
          if (terminal === undefined) {
            terminal = await this.#terminalFrom(event, turn);
          } else {
            await this.#invalidToolInput(turn, event.callId);
          }
          continue;
        }

        if (terminalCount > 0) {
          protocolFailure ??= "invalid_model_event";
          await this.#invalidToolInput(turn, event.callId);
          continue;
        }
        await this.#executeTool(command, event, turn);
      }
    } catch (error) {
      if (terminalCount > 0) {
        terminalCount += 1;
      } else if (error instanceof CodexPortError && unavailableReason(error.code)) {
        terminal = { kind: "degraded", reason: "codex_unavailable" };
        terminalCount = 1;
      } else {
        terminal = { kind: "failure", reason: "codex_runtime_failed" };
        terminalCount = 1;
      }
    }

    if (terminalCount > 1) return { kind: "failure", reason: "multiple_terminal_results" };
    if (protocolFailure !== undefined) return { kind: "failure", reason: protocolFailure };
    return terminal ?? { kind: "failure", reason: "missing_terminal_result" };
  }

  async #terminalFrom(event: Extract<CodexEvent, { type: "tool_call" }>, turn: CodexCliTurn): Promise<ModelTerminal> {
    const schema = hqTools[event.tool];
    const parsed = schema.safeParse(event.input);
    if (!parsed.success) {
      await this.#respond(turn, {
        callId: event.callId,
        ok: false,
        error: { code: "invalid_tool_input" }
      });
      return { kind: "failure", reason: "invalid_model_output" };
    }

    await this.#respond(turn, {
      callId: event.callId,
      ok: true,
      output: { accepted: true }
    });
    return event.tool === "submitProposal"
      ? { kind: "proposal", proposal: ExecutionProposalSchema.parse(parsed.data) }
      : { kind: "clarification", clarification: parsed.data };
  }

  async #executeTool(
    command: CommandEnvelope,
    event: Extract<CodexEvent, { type: "tool_call" }>,
    turn: CodexCliTurn
  ): Promise<void> {
    try {
      switch (event.tool) {
        case "searchProjects": {
          const input = SearchProjectsInputSchema.safeParse(event.input);
          if (!input.success) return this.#invalidToolInput(turn, event.callId);
          const output = ProjectRegistryEntrySchema.array().safeParse(
            await this.#registry.searchProjects(input.data)
          );
          if (!output.success) return this.#invalidToolResult(turn, event.callId);
          return this.#respond(turn, { callId: event.callId, ok: true, output: output.data });
        }
        case "inspectProject": {
          const input = InspectProjectInputSchema.safeParse(event.input);
          if (!input.success) return this.#invalidToolInput(turn, event.callId);
          const output = ProjectRegistryEntrySchema.nullable().safeParse(
            await this.#registry.inspectProject(input.data)
          );
          if (!output.success) return this.#invalidToolResult(turn, event.callId);
          return this.#respond(turn, { callId: event.callId, ok: true, output: output.data });
        }
        case "previewPolicy": {
          const input = PreviewPolicyInputSchema.safeParse(event.input);
          if (!input.success) return this.#invalidToolInput(turn, event.callId);
          const output = PolicyPreviewResultSchema.safeParse(
            await this.#policy.previewPolicy({ command, proposal: input.data.proposal })
          );
          if (!output.success) return this.#invalidToolResult(turn, event.callId);
          return this.#respond(turn, { callId: event.callId, ok: true, output: output.data });
        }
        case "submitProposal":
        case "askClarification":
          return;
      }
    } catch {
      await this.#respond(turn, {
        callId: event.callId,
        ok: false,
        error: { code: "tool_failed" }
      });
    }
  }

  async #invalidToolInput(turn: CodexCliTurn, callId: string): Promise<void> {
    return this.#respond(turn, {
      callId,
      ok: false,
      error: { code: "invalid_tool_input" }
    });
  }

  async #invalidToolResult(turn: CodexCliTurn, callId: string): Promise<void> {
    return this.#respond(turn, {
      callId,
      ok: false,
      error: { code: "invalid_tool_result" }
    });
  }

  async #respond(turn: CodexCliTurn, response: CodexToolResponse): Promise<void> {
    await turn.respond(response);
  }

  async #validateProposal(command: CommandEnvelope, proposalInput: ExecutionProposal): Promise<HqResult> {
    const parsedProposal = ExecutionProposalSchema.safeParse(proposalInput);
    if (!parsedProposal.success || parsedProposal.data.commandId !== command.commandId) {
      return failure("invalid_model_output");
    }
    const proposal = parsedProposal.data;
    const route = decideRankedRoute(proposal.routeCandidates);
    if (route.kind === "clarification_required") {
      return {
        kind: "clarification",
        clarification: {
          commandId: command.commandId,
          question: "Which project should handle this command?",
          candidates: route.candidates
        }
      };
    }
    if (route.projectKey !== proposal.selectedProjectKey) {
      return failure("invalid_project_route");
    }

    let project: ProjectRegistryEntry;
    try {
      const inspected = ProjectRegistryEntrySchema.safeParse(
        await this.#registry.inspectProject({ projectKey: route.projectKey })
      );
      if (!inspected.success || inspected.data.projectKey !== route.projectKey) {
        return failure("invalid_registry_response");
      }
      project = inspected.data;
    } catch {
      return failure("registry_unavailable");
    }
    if (!project.allowedOperations.includes(proposal.riskLevel)) {
      return failure("policy_rejected");
    }

    try {
      const preview = PolicyPreviewResultSchema.safeParse(
        await this.#policy.previewPolicy({ command, proposal })
      );
      if (!preview.success) return failure("invalid_policy_response");
      if (preview.data.kind === "rejected") return failure("policy_rejected");
    } catch {
      return failure("policy_unavailable");
    }
    return { kind: "proposal", proposal };
  }
}
