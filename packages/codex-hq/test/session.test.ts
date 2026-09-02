import type { CommandEnvelope, ExecutionProposal } from "@orca-hq/core";
import { ExecutionProposalSchema } from "@orca-hq/core";
import { describe, expect, it, vi } from "vitest";

import {
  CODEX_HQ_MODEL,
  CODEX_TERRA_MODEL,
  CodexHqSession,
  CodexPortError,
  HqResultSchema,
  hqTools,
  type CodexCliPort,
  type CodexCliTurn,
  type CodexTurnRequest,
  type HqQueueClaim,
  type HqQueueTerminalRecord,
  type HqResult,
  type OrderedCommandQueuePort,
  type PolicyPreviewPort,
  type RegistryQueryPort
} from "../src/index.js";

const command: CommandEnvelope = {
  commandId: "command-1",
  idempotencyKey: "slack:workspace:message-1",
  channel: "slack",
  externalMessageId: "message-1",
  principalId: "principal-1",
  receivedAt: "2026-09-01T00:00:00.000Z",
  text: "Update the synthetic API"
};

const proposal: ExecutionProposal = {
  proposalId: "proposal-1",
  commandId: command.commandId,
  selectedProjectKey: "synthetic-api",
  routeCandidates: [
    { projectKey: "synthetic-api", score: 1, evidence: ["exact alias"] }
  ],
  baseRef: "main",
  allowedScope: ["src/**", "test/**"],
  prohibitedEffects: ["push", "deployment", "secret access"],
  acceptanceCommands: ["pnpm test"],
  riskLevel: "L1",
  tasks: [
    {
      localId: "task-1",
      title: "Implement the requested API change",
      dependsOn: [],
      role: "implement",
      preferredAgent: "codex"
    }
  ]
};

function commandFor(commandId: string): CommandEnvelope {
  return {
    ...command,
    commandId,
    idempotencyKey: `slack:workspace:${commandId}`,
    externalMessageId: commandId,
    text: `Coordinate ${commandId}`
  };
}

function proposalFor(value: CommandEnvelope): ExecutionProposal {
  return {
    ...proposal,
    proposalId: `proposal-${value.commandId}`,
    commandId: value.commandId
  };
}

const project = {
  projectKey: "synthetic-api",
  orcaProjectId: "orca-project-1",
  absolutePath: "/tmp/synthetic-api",
  aliases: ["synthetic api"],
  component: "backend" as const,
  instructionsFiles: ["AGENTS.md"],
  setupPolicy: "run" as const,
  allowedOperations: ["L0", "L1"] as const,
  requiredChecks: ["pnpm test"],
  sensitivePaths: [".env"],
  lockKey: "synthetic-api"
};

class MemoryQueue implements OrderedCommandQueuePort {
  readonly enqueued: CommandEnvelope[] = [];
  readonly completed: Array<{ commandId: string; result: HqResult }> = [];
  readonly deferred: Array<{ commandId: string; result: HqResult }> = [];
  readonly #ready: HqQueueClaim[] = [];
  readonly #settled = new Map<
    string,
    { disposition: "complete" | "defer"; record: HqQueueTerminalRecord }
  >();
  #active: HqQueueClaim | undefined;
  #nextClaim = 1;

  constructor(initialCommands: readonly unknown[] = []) {
    for (const initialCommand of initialCommands) this.#enqueueClaim(initialCommand);
  }

  async enqueue(value: CommandEnvelope): Promise<void> {
    this.enqueued.push(value);
    this.#enqueueClaim(value);
  }

  async claimNext(): Promise<HqQueueClaim | undefined> {
    this.#active ??= this.#ready[0];
    return this.#active;
  }

  async complete(record: HqQueueTerminalRecord): Promise<void> {
    this.#settle("complete", record);
  }

  async defer(record: HqQueueTerminalRecord): Promise<void> {
    this.#settle("defer", record);
  }

  #enqueueClaim(command: unknown): void {
    this.#ready.push(Object.freeze({
      claimToken: `claim-${this.#nextClaim++}`,
      command
    }));
  }

  #settle(
    disposition: "complete" | "defer",
    record: HqQueueTerminalRecord
  ): void {
    const existing = this.#settled.get(record.claimToken);
    if (existing !== undefined) {
      if (
        existing.disposition !== disposition
        || JSON.stringify(existing.record) !== JSON.stringify(record)
      ) throw new Error("conflicting terminal record for claim token");
      return;
    }
    if (this.#active?.claimToken !== record.claimToken) {
      throw new Error("terminal record does not match the active claim");
    }

    this.#settled.set(record.claimToken, { disposition, record });
    if (disposition === "complete") {
      this.completed.push({ commandId: record.commandId, result: record.result });
    } else {
      this.deferred.push({ commandId: record.commandId, result: record.result });
    }
    this.#ready.shift();
    this.#active = undefined;
  }
}

class OneFailureRecoveryGate {
  readonly failed: Promise<void>;
  readonly retryBlocked: Promise<void>;
  #signalFailed: (() => void) | undefined;
  #signalRetryBlocked: (() => void) | undefined;
  #releaseRetry: (() => void) | undefined;
  readonly #recovery: Promise<void>;
  #attempts = 0;

  constructor() {
    this.failed = new Promise<void>((resolve) => {
      this.#signalFailed = resolve;
    });
    this.retryBlocked = new Promise<void>((resolve) => {
      this.#signalRetryBlocked = resolve;
    });
    this.#recovery = new Promise<void>((resolve) => {
      this.#releaseRetry = resolve;
    });
  }

  recover(): void {
    this.#releaseRetry?.();
  }

  async beforeOperation(): Promise<void> {
    this.#attempts += 1;
    if (this.#attempts === 1) {
      this.#signalFailed?.();
      throw new Error("queue temporarily unavailable");
    }
    this.#signalRetryBlocked?.();
    await this.#recovery;
  }
}

function turnFor(events: readonly unknown[]): CodexCliTurn {
  return {
    events: (async function* () {
      yield* events;
    })(),
    respond: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined)
  };
}

function dependencies(codex: CodexCliPort, queue = new MemoryQueue()) {
  const registry: RegistryQueryPort = {
    searchProjects: vi.fn(async () => [project]),
    inspectProject: vi.fn(async () => project)
  };
  const policy: PolicyPreviewPort = {
    previewPolicy: vi.fn(async () => ({ kind: "auto" as const }))
  };

  return { codex, queue, registry, policy };
}

describe("Codex HQ session", () => {
  it("accepts one valid proposal and closes the turn", async () => {
    // Break caught: a coordinator could return unchecked model prose or leave its turn open.
    const turn = turnFor([
      {
        type: "tool_call",
        model: CODEX_HQ_MODEL,
        callId: "call-1",
        tool: "submitProposal",
        input: proposal
      }
    ]);
    const codex: CodexCliPort = {
      openTurn: vi.fn(async (_request: CodexTurnRequest) => turn)
    };
    const deps = dependencies(codex);
    const session = new CodexHqSession({
      ...deps,
      models: { authorityModel: CODEX_HQ_MODEL }
    });

    const result = await session.plan(command);

    expect(result.kind).toBe("proposal");
    if (result.kind !== "proposal") throw new Error("expected proposal");
    expect(ExecutionProposalSchema.parse(result.proposal)).toEqual(proposal);
    expect(turn.close).toHaveBeenCalledOnce();
    expect(deps.queue.completed).toEqual([{ commandId: command.commandId, result }]);
  });

  it("durably defers a command when Codex authentication is unavailable", async () => {
    // Break caught: authentication failure could drop work or promote Claude to HQ authority.
    const claude = { invoke: vi.fn() };
    const codex: CodexCliPort = {
      openTurn: vi.fn(async () => {
        throw new CodexPortError("authentication_required");
      })
    };
    const deps = dependencies(codex);
    const session = new CodexHqSession({
      ...deps,
      models: { authorityModel: CODEX_HQ_MODEL }
    });

    await expect(session.plan(command)).resolves.toEqual({
      kind: "degraded",
      reason: "codex_unavailable"
    });
    expect(deps.queue.enqueued).toEqual([command]);
    expect(deps.queue.deferred).toEqual([
      {
        commandId: command.commandId,
        result: { kind: "degraded", reason: "codex_unavailable" }
      }
    ]);
    expect(claude.invoke).not.toHaveBeenCalled();
  });

  it("fails closed when the Codex turn cannot be closed", async () => {
    // Break caught: a live turn could submit again after HQ has exposed a proposal as final.
    const turn: CodexCliTurn = {
      ...turnFor([
        {
          type: "tool_call",
          model: CODEX_HQ_MODEL,
          callId: "call-1",
          tool: "submitProposal",
          input: proposal
        }
      ]),
      close: vi.fn(async () => {
        throw new Error("close failed");
      })
    };
    const codex: CodexCliPort = { openTurn: vi.fn(async () => turn) };
    const session = new CodexHqSession({
      ...dependencies(codex),
      models: { authorityModel: CODEX_HQ_MODEL }
    });

    await expect(session.plan(command)).resolves.toEqual({
      kind: "failure",
      reason: "codex_runtime_failed"
    });
  });

  it("gives the Codex port an immutable fixed tool allowlist", async () => {
    // Break caught: a provider adapter could append an unrestricted tool for later HQ turns.
    let mutationBlocked = false;
    const codex: CodexCliPort = {
      openTurn: vi.fn(async (request) => {
        try {
          (request.tools as string[]).push("runShell");
        } catch (error) {
          mutationBlocked = error instanceof TypeError;
        }
        if (!mutationBlocked) (request.tools as string[]).pop();
        return turnFor([
          {
            type: "tool_call",
            model: CODEX_HQ_MODEL,
            callId: "call-1",
            tool: "submitProposal",
            input: proposal
          }
        ]);
      })
    };
    const session = new CodexHqSession({
      ...dependencies(codex),
      models: { authorityModel: CODEX_HQ_MODEL }
    });

    await session.plan(command);

    expect(mutationBlocked).toBe(true);
    expect(Object.keys(hqTools)).toEqual([
      "searchProjects",
      "inspectProject",
      "previewPolicy",
      "submitProposal",
      "askClarification"
    ]);
  });

  it("does not open a second coordinator turn for a completed command replay", async () => {
    // Break caught: a redelivered commandId could produce two authoritative terminal results.
    const codex: CodexCliPort = {
      openTurn: vi.fn(async () => turnFor([
        {
          type: "tool_call",
          model: CODEX_HQ_MODEL,
          callId: "call-1",
          tool: "submitProposal",
          input: proposal
        }
      ]))
    };
    const session = new CodexHqSession({
      ...dependencies(codex),
      models: { authorityModel: CODEX_HQ_MODEL }
    });

    await expect(session.plan(command)).resolves.toMatchObject({ kind: "proposal" });
    await expect(session.plan(command)).resolves.toEqual({
      kind: "failure",
      reason: "duplicate_command"
    });
    expect(codex.openTurn).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "a malformed proposal",
      events: [
        {
          type: "tool_call",
          model: CODEX_HQ_MODEL,
          callId: "call-1",
          tool: "submitProposal",
          input: { ...proposal, proposalId: "" }
        }
      ],
      reason: "invalid_model_output"
    },
    {
      name: "multiple terminal submissions",
      events: [
        {
          type: "tool_call",
          model: CODEX_HQ_MODEL,
          callId: "call-1",
          tool: "submitProposal",
          input: proposal
        },
        {
          type: "tool_call",
          model: CODEX_HQ_MODEL,
          callId: "call-2",
          tool: "askClarification",
          input: { commandId: command.commandId, question: "Which component?" }
        }
      ],
      reason: "multiple_terminal_results"
    },
    {
      name: "an event claiming Terra authority",
      events: [
        {
          type: "tool_call",
          model: CODEX_TERRA_MODEL,
          callId: "call-1",
          tool: "submitProposal",
          input: proposal
        }
      ],
      reason: "invalid_model_authority"
    },
    {
      name: "no terminal submission",
      events: [],
      reason: "missing_terminal_result"
    }
  ])("fails closed for $name", async ({ events, reason }) => {
    // Break caught: malformed, conflicting, or non-Sol output could escape as an HQ decision.
    const turn = turnFor(events);
    const codex: CodexCliPort = { openTurn: vi.fn(async () => turn) };
    const session = new CodexHqSession({
      ...dependencies(codex),
      models: { authorityModel: CODEX_HQ_MODEL }
    });

    const result = await session.plan(command);

    expect(result).toEqual({ kind: "failure", reason });
    expect(HqResultSchema.parse(result)).toEqual(result);
    expect(turn.close).toHaveBeenCalledOnce();
  });

  it("rejects any non-Sol authority or fallback model configuration", () => {
    // Break caught: configuration drift could silently install Terra or Claude as HQ authority.
    const codex: CodexCliPort = { openTurn: vi.fn() };
    const deps = dependencies(codex);

    expect(() => new CodexHqSession({
      ...deps,
      models: { authorityModel: CODEX_TERRA_MODEL } as never
    })).toThrow();
    expect(() => new CodexHqSession({
      ...deps,
      models: {
        authorityModel: CODEX_HQ_MODEL,
        fallbackModel: "claude"
      } as never
    })).toThrow();
  });

  it("converts a submitted proposal with low route confidence into clarification", async () => {
    // Break caught: model confidence below the deterministic threshold could dispatch the wrong project.
    const uncertainProposal: ExecutionProposal = {
      ...proposal,
      routeCandidates: [
        { projectKey: "synthetic-api", score: 0.849, evidence: ["model guess"] }
      ]
    };
    const codex: CodexCliPort = {
      openTurn: vi.fn(async () => turnFor([
        {
          type: "tool_call",
          model: CODEX_HQ_MODEL,
          callId: "call-1",
          tool: "submitProposal",
          input: uncertainProposal
        }
      ]))
    };
    const deps = dependencies(codex);
    const session = new CodexHqSession({
      ...deps,
      models: { authorityModel: CODEX_HQ_MODEL }
    });

    await expect(session.plan(command)).resolves.toEqual({
      kind: "clarification",
      clarification: {
        commandId: command.commandId,
        question: "Which project should handle this command?",
        candidates: uncertainProposal.routeCandidates
      }
    });
    expect(deps.registry.inspectProject).not.toHaveBeenCalled();
    expect(deps.policy.previewPolicy).not.toHaveBeenCalled();
  });

  it("rejects a selected project that differs from deterministic route ranking", async () => {
    // Break caught: model prose could name a project other than the route winner.
    const conflictingProposal: ExecutionProposal = {
      ...proposal,
      selectedProjectKey: "other-project"
    };
    const codex: CodexCliPort = {
      openTurn: vi.fn(async () => turnFor([
        {
          type: "tool_call",
          model: CODEX_HQ_MODEL,
          callId: "call-1",
          tool: "submitProposal",
          input: conflictingProposal
        }
      ]))
    };
    const session = new CodexHqSession({
      ...dependencies(codex),
      models: { authorityModel: CODEX_HQ_MODEL }
    });

    await expect(session.plan(command)).resolves.toEqual({
      kind: "failure",
      reason: "invalid_project_route"
    });
  });

  it("lets deterministic project policy reject the final exact proposal", async () => {
    // Break caught: a model-provided risk decision could bypass the policy preview port.
    const codex: CodexCliPort = {
      openTurn: vi.fn(async () => turnFor([
        {
          type: "tool_call",
          model: CODEX_HQ_MODEL,
          callId: "call-1",
          tool: "submitProposal",
          input: proposal
        }
      ]))
    };
    const deps = dependencies(codex);
    deps.policy.previewPolicy = vi.fn(async () => ({
      kind: "rejected" as const,
      reason: "risk_mismatch" as const
    }));
    const session = new CodexHqSession({
      ...deps,
      models: { authorityModel: CODEX_HQ_MODEL }
    });

    await expect(session.plan(command)).resolves.toEqual({
      kind: "failure",
      reason: "policy_rejected"
    });
    expect(deps.policy.previewPolicy).toHaveBeenCalledWith({ command, proposal });
  });

  it("executes only schema-checked registry and policy preview tool calls", async () => {
    // Break caught: model-authored tool arguments or provider output could cross a typed boundary unchecked.
    const turn = turnFor([
      {
        type: "tool_call",
        model: CODEX_HQ_MODEL,
        callId: "search-call",
        tool: "searchProjects",
        input: { query: "synthetic", limit: 5 }
      },
      {
        type: "tool_call",
        model: CODEX_HQ_MODEL,
        callId: "inspect-call",
        tool: "inspectProject",
        input: { projectKey: project.projectKey }
      },
      {
        type: "tool_call",
        model: CODEX_HQ_MODEL,
        callId: "policy-call",
        tool: "previewPolicy",
        input: { proposal }
      },
      {
        type: "tool_call",
        model: CODEX_HQ_MODEL,
        callId: "terminal-call",
        tool: "submitProposal",
        input: proposal
      }
    ]);
    const codex: CodexCliPort = { openTurn: vi.fn(async () => turn) };
    const deps = dependencies(codex);
    const session = new CodexHqSession({
      ...deps,
      models: { authorityModel: CODEX_HQ_MODEL }
    });

    await expect(session.plan(command)).resolves.toMatchObject({ kind: "proposal" });

    expect(deps.registry.searchProjects).toHaveBeenCalledWith({ query: "synthetic", limit: 5 });
    expect(deps.registry.inspectProject).toHaveBeenCalledWith({
      projectKey: project.projectKey
    });
    expect(turn.respond).toHaveBeenNthCalledWith(1, {
      callId: "search-call",
      ok: true,
      output: [project]
    });
    expect(turn.respond).toHaveBeenNthCalledWith(2, {
      callId: "inspect-call",
      ok: true,
      output: project
    });
    expect(turn.respond).toHaveBeenNthCalledWith(3, {
      callId: "policy-call",
      ok: true,
      output: { kind: "auto" }
    });
  });

  it("passes Terra labels and summaries without giving Terra a decision surface", async () => {
    // Break caught: optional assistance could gain tools or authoritative proposal fields.
    let request: CodexTurnRequest | undefined;
    const codex: CodexCliPort = {
      openTurn: vi.fn(async (input) => {
        request = input;
        return turnFor([
          {
            type: "tool_call",
            model: CODEX_HQ_MODEL,
            callId: "call-1",
            tool: "submitProposal",
            input: proposal
          }
        ]);
      })
    };
    const terra = {
      assist: vi.fn(async () => ({
        model: CODEX_TERRA_MODEL,
        labels: ["backend", "change"],
        summary: "Update the backend API"
      }))
    };
    const session = new CodexHqSession({
      ...dependencies(codex),
      models: {
        authorityModel: CODEX_HQ_MODEL,
        assistantModel: CODEX_TERRA_MODEL
      },
      terra
    });

    await expect(session.plan(command)).resolves.toMatchObject({ kind: "proposal" });

    expect(terra.assist).toHaveBeenCalledWith({
      model: CODEX_TERRA_MODEL,
      text: command.text
    });
    expect(request?.assistance).toEqual({
      model: CODEX_TERRA_MODEL,
      labels: ["backend", "change"],
      summary: "Update the backend API"
    });
    expect(Object.keys(request?.assistance ?? {})).toEqual(["model", "labels", "summary"]);
  });

  it("drops Terra output that attempts to select a project or change risk", async () => {
    // Break caught: extra Terra fields could become authoritative coordination input.
    let request: CodexTurnRequest | undefined;
    const codex: CodexCliPort = {
      openTurn: vi.fn(async (input) => {
        request = input;
        return turnFor([
          {
            type: "tool_call",
            model: CODEX_HQ_MODEL,
            callId: "call-1",
            tool: "submitProposal",
            input: proposal
          }
        ]);
      })
    };
    const session = new CodexHqSession({
      ...dependencies(codex),
      models: {
        authorityModel: CODEX_HQ_MODEL,
        assistantModel: CODEX_TERRA_MODEL
      },
      terra: {
        assist: vi.fn(async () => ({
          model: CODEX_TERRA_MODEL,
          labels: ["backend"],
          summary: "Attempted override",
          selectedProjectKey: "attacker-project",
          riskLevel: "L0",
          approved: true
        }))
      }
    });

    const result = await session.plan(command);

    expect(request?.assistance).toBeUndefined();
    expect(result).toEqual({ kind: "proposal", proposal });
  });

  it("serializes busy commands through the durable queue in FIFO order", async () => {
    // Break caught: concurrent plan calls could overlap turns or overtake a durably queued command.
    const firstCommand = commandFor("command-a");
    const secondCommand = commandFor("command-b");
    const thirdCommand = commandFor("command-c");
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstOpened: (() => void) | undefined;
    const firstOpened = new Promise<void>((resolve) => {
      markFirstOpened = resolve;
    });
    const openOrder: string[] = [];
    let activeTurns = 0;
    let maximumActiveTurns = 0;
    const codex: CodexCliPort = {
      openTurn: vi.fn(async (request) => {
        openOrder.push(request.command.commandId);
        activeTurns += 1;
        maximumActiveTurns = Math.max(maximumActiveTurns, activeTurns);
        if (request.command.commandId === firstCommand.commandId) markFirstOpened?.();
        return {
          events: (async function* () {
            if (request.command.commandId === firstCommand.commandId) await firstGate;
            yield {
              type: "tool_call",
              model: CODEX_HQ_MODEL,
              callId: `call-${request.command.commandId}`,
              tool: "submitProposal",
              input: proposalFor(request.command)
            };
          })(),
          respond: vi.fn(async () => undefined),
          close: vi.fn(async () => {
            activeTurns -= 1;
          })
        };
      })
    };
    const queue = new MemoryQueue();
    const session = new CodexHqSession({
      ...dependencies(codex, queue),
      models: { authorityModel: CODEX_HQ_MODEL }
    });

    const first = session.plan(firstCommand);
    await firstOpened;
    const second = session.plan(secondCommand);
    const third = session.plan(thirdCommand);
    await vi.waitFor(() => {
      expect(queue.enqueued.map((item) => item.commandId)).toEqual([
        firstCommand.commandId,
        secondCommand.commandId,
        thirdCommand.commandId
      ]);
    });
    expect(openOrder).toEqual([firstCommand.commandId]);

    releaseFirst?.();
    await expect(Promise.all([first, second, third])).resolves.toMatchObject([
      { kind: "proposal" },
      { kind: "proposal" },
      { kind: "proposal" }
    ]);
    expect(openOrder).toEqual([
      firstCommand.commandId,
      secondCommand.commandId,
      thirdCommand.commandId
    ]);
    expect(queue.completed.map((item) => item.commandId)).toEqual(openOrder);
    expect(maximumActiveTurns).toBe(1);
  });

  it("treats an authentication failure event as degraded and retains the command", async () => {
    // Break caught: stream-reported authentication loss could be misread as generic model output.
    const turn = turnFor([
      {
        type: "failure",
        model: CODEX_HQ_MODEL,
        reason: "authentication_required"
      }
    ]);
    const codex: CodexCliPort = { openTurn: vi.fn(async () => turn) };
    const queue = new MemoryQueue();
    const session = new CodexHqSession({
      ...dependencies(codex, queue),
      models: { authorityModel: CODEX_HQ_MODEL }
    });

    await expect(session.plan(command)).resolves.toEqual({
      kind: "degraded",
      reason: "codex_unavailable"
    });
    expect(queue.deferred).toEqual([
      {
        commandId: command.commandId,
        result: { kind: "degraded", reason: "codex_unavailable" }
      }
    ]);
    expect(turn.close).toHaveBeenCalledOnce();
  });

  it("records a malformed persisted queue value and continues to the next command", async () => {
    // Break caught: corrupt durable JSON could crash the drain and strand every later FIFO command.
    const codex: CodexCliPort = {
      openTurn: vi.fn(async () => turnFor([
        {
          type: "tool_call",
          model: CODEX_HQ_MODEL,
          callId: "call-1",
          tool: "submitProposal",
          input: proposal
        }
      ]))
    };
    const queue = new MemoryQueue([null]);
    const session = new CodexHqSession({
      ...dependencies(codex, queue),
      models: { authorityModel: CODEX_HQ_MODEL }
    });

    const result = await Promise.race([
      session.plan(command),
      new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 50))
    ]);

    expect(result).not.toBe("timed_out");
    expect(result).toMatchObject({ kind: "proposal" });
    expect(queue.completed[0]).toEqual({
      commandId: "invalid-command",
      result: { kind: "failure", reason: "invalid_command" }
    });
  });

  it("denies a forbidden tool call so an interactive stream cannot deadlock", async () => {
    // Break caught: an adapter waiting for a tool response could hang forever on a rejected shell call.
    let releaseStream: (() => void) | undefined;
    const responseGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const respond = vi.fn(async () => {
      releaseStream?.();
    });
    const turn: CodexCliTurn = {
      events: (async function* () {
        yield {
          type: "tool_call",
          model: CODEX_HQ_MODEL,
          callId: "forbidden-call",
          tool: "runShell",
          input: { command: "rm -rf project" }
        };
        await responseGate;
        yield {
          type: "tool_call",
          model: CODEX_HQ_MODEL,
          callId: "terminal-call",
          tool: "submitProposal",
          input: proposal
        };
      })(),
      respond,
      close: vi.fn(async () => undefined)
    };
    const codex: CodexCliPort = { openTurn: vi.fn(async () => turn) };
    const session = new CodexHqSession({
      ...dependencies(codex),
      models: { authorityModel: CODEX_HQ_MODEL }
    });

    const result = await Promise.race([
      session.plan(command),
      new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 50))
    ]);

    expect(result).toEqual({ kind: "failure", reason: "invalid_model_event" });
    expect(respond).toHaveBeenCalledWith({
      callId: "forbidden-call",
      ok: false,
      error: { code: "invalid_tool_input" }
    });
  });

  it("denies a second terminal call before failing the turn closed", async () => {
    // Break caught: a duplicate terminal awaiting its tool result could hide the protocol conflict in a hang.
    let releaseDuplicate: (() => void) | undefined;
    const duplicateGate = new Promise<void>((resolve) => {
      releaseDuplicate = resolve;
    });
    const respond = vi.fn(async (response) => {
      if (response.callId === "duplicate-call") releaseDuplicate?.();
    });
    const turn: CodexCliTurn = {
      events: (async function* () {
        yield {
          type: "tool_call",
          model: CODEX_HQ_MODEL,
          callId: "first-call",
          tool: "submitProposal",
          input: proposal
        };
        yield {
          type: "tool_call",
          model: CODEX_HQ_MODEL,
          callId: "duplicate-call",
          tool: "askClarification",
          input: { commandId: command.commandId, question: "Duplicate result" }
        };
        await duplicateGate;
      })(),
      respond,
      close: vi.fn(async () => undefined)
    };
    const codex: CodexCliPort = { openTurn: vi.fn(async () => turn) };
    const session = new CodexHqSession({
      ...dependencies(codex),
      models: { authorityModel: CODEX_HQ_MODEL }
    });

    const result = await Promise.race([
      session.plan(command),
      new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 50))
    ]);

    expect(result).toEqual({ kind: "failure", reason: "multiple_terminal_results" });
    expect(respond).toHaveBeenCalledWith({
      callId: "duplicate-call",
      ok: false,
      error: { code: "invalid_tool_input" }
    });
  });

  it("denies an interactive event that claims a non-Sol model", async () => {
    // Break caught: a wrong-model tool call could deadlock instead of producing the authority failure.
    let releaseStream: (() => void) | undefined;
    const responseGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const respond = vi.fn(async () => {
      releaseStream?.();
    });
    const turn: CodexCliTurn = {
      events: (async function* () {
        yield {
          type: "tool_call",
          model: CODEX_TERRA_MODEL,
          callId: "wrong-model-call",
          tool: "submitProposal",
          input: proposal
        };
        await responseGate;
      })(),
      respond,
      close: vi.fn(async () => undefined)
    };
    const codex: CodexCliPort = { openTurn: vi.fn(async () => turn) };
    const session = new CodexHqSession({
      ...dependencies(codex),
      models: { authorityModel: CODEX_HQ_MODEL }
    });

    const result = await Promise.race([
      session.plan(command),
      new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 50))
    ]);

    expect(result).toEqual({ kind: "failure", reason: "invalid_model_authority" });
    expect(respond).toHaveBeenCalledWith({
      callId: "wrong-model-call",
      ok: false,
      error: { code: "invalid_tool_input" }
    });
  });

  it("keeps a command pending when claim fails and resumes it without reordering", async () => {
    // Break caught: a transient claim failure could publish queue_unavailable while the durable row stays pending.
    class RecoverableClaimQueue extends MemoryQueue {
      readonly recovery = new OneFailureRecoveryGate();

      override async claimNext(): Promise<HqQueueClaim | undefined> {
        await this.recovery.beforeOperation();
        return super.claimNext();
      }
    }

    const codex: CodexCliPort = {
      openTurn: vi.fn(async () => turnFor([
        {
          type: "tool_call",
          model: CODEX_HQ_MODEL,
          callId: "call-1",
          tool: "submitProposal",
          input: proposal
        }
      ]))
    };
    const queue = new RecoverableClaimQueue();
    const session = new CodexHqSession({
      ...dependencies(codex, queue),
      models: { authorityModel: CODEX_HQ_MODEL }
    });
    let resolved = false;

    const resultPromise = session.plan(command).then((result) => {
      resolved = true;
      return result;
    });
    await queue.recovery.failed;

    const resumePromise = session.resume();
    await queue.recovery.retryBlocked;
    expect(resolved).toBe(false);
    expect(codex.openTurn).not.toHaveBeenCalled();

    queue.recovery.recover();
    await resumePromise;
    await expect(resultPromise).resolves.toEqual({ kind: "proposal", proposal });
    expect(codex.openTurn).toHaveBeenCalledOnce();
    expect(queue.completed).toEqual([
      { commandId: command.commandId, result: { kind: "proposal", proposal } }
    ]);
  });

  it("retries the same proposal record before resolving or advancing FIFO", async () => {
    // Break caught: a failed complete could lose a computed proposal, resolve a false failure, then run later work.
    class RecoverableCompleteQueue extends MemoryQueue {
      readonly completeAttempts: HqQueueTerminalRecord[] = [];
      readonly recovery = new OneFailureRecoveryGate();

      override async complete(record: HqQueueTerminalRecord): Promise<void> {
        this.completeAttempts.push(record);
        await this.recovery.beforeOperation();
        await super.complete(record);
      }
    }

    const firstCommand = commandFor("command-complete-a");
    const secondCommand = commandFor("command-complete-b");
    const opened: string[] = [];
    const codex: CodexCliPort = {
      openTurn: vi.fn(async (request) => {
        opened.push(request.command.commandId);
        return turnFor([
          {
            type: "tool_call",
            model: CODEX_HQ_MODEL,
            callId: `call-${request.command.commandId}`,
            tool: "submitProposal",
            input: proposalFor(request.command)
          }
        ]);
      })
    };
    const queue = new RecoverableCompleteQueue();
    const session = new CodexHqSession({
      ...dependencies(codex, queue),
      models: { authorityModel: CODEX_HQ_MODEL }
    });
    let firstResolved = false;
    let secondResolved = false;

    const firstResult = session.plan(firstCommand).then((result) => {
      firstResolved = true;
      return result;
    });
    await queue.recovery.failed;
    const secondResult = session.plan(secondCommand).then((result) => {
      secondResolved = true;
      return result;
    });
    const resumePromise = session.resume();
    await queue.recovery.retryBlocked;

    expect(firstResolved).toBe(false);
    expect(secondResolved).toBe(false);
    expect(opened).toEqual([firstCommand.commandId]);
    expect(queue.completed).toEqual([]);

    queue.recovery.recover();
    await resumePromise;
    await expect(Promise.all([firstResult, secondResult])).resolves.toEqual([
      { kind: "proposal", proposal: proposalFor(firstCommand) },
      { kind: "proposal", proposal: proposalFor(secondCommand) }
    ]);
    expect(opened).toEqual([firstCommand.commandId, secondCommand.commandId]);
    expect(opened.filter((commandId) => commandId === firstCommand.commandId)).toHaveLength(1);
    const firstAttempts = queue.completeAttempts.filter(
      (attempt) => attempt.commandId === firstCommand.commandId
    );
    expect(firstAttempts).toHaveLength(2);
    expect(firstAttempts[0]?.claimToken).toMatch(/^claim-/);
    expect(firstAttempts[1]).toBe(firstAttempts[0]);
    expect(firstAttempts[1]?.result).toBe(firstAttempts[0]?.result);
    expect(queue.completed.map((item) => item.commandId)).toEqual([
      firstCommand.commandId,
      secondCommand.commandId
    ]);
  });

  it("retries the same degraded record before resolving or advancing FIFO", async () => {
    // Break caught: a failed defer could publish queue_unavailable and lose the exact degraded outcome.
    class RecoverableDeferQueue extends MemoryQueue {
      readonly deferAttempts: HqQueueTerminalRecord[] = [];
      readonly recovery = new OneFailureRecoveryGate();

      override async defer(record: HqQueueTerminalRecord): Promise<void> {
        this.deferAttempts.push(record);
        await this.recovery.beforeOperation();
        await super.defer(record);
      }
    }

    const firstCommand = commandFor("command-defer-a");
    const secondCommand = commandFor("command-defer-b");
    const codex: CodexCliPort = {
      openTurn: vi.fn(async () => {
        throw new CodexPortError("authentication_required");
      })
    };
    const queue = new RecoverableDeferQueue();
    const session = new CodexHqSession({
      ...dependencies(codex, queue),
      models: { authorityModel: CODEX_HQ_MODEL }
    });
    let firstResolved = false;
    let secondResolved = false;

    const firstResult = session.plan(firstCommand).then((result) => {
      firstResolved = true;
      return result;
    });
    await queue.recovery.failed;
    const secondResult = session.plan(secondCommand).then((result) => {
      secondResolved = true;
      return result;
    });
    const resumePromise = session.resume();
    await queue.recovery.retryBlocked;

    expect(firstResolved).toBe(false);
    expect(secondResolved).toBe(false);
    expect(codex.openTurn).toHaveBeenCalledOnce();
    expect(queue.deferred).toEqual([]);

    queue.recovery.recover();
    await resumePromise;
    const degraded = { kind: "degraded", reason: "codex_unavailable" } as const;
    await expect(Promise.all([firstResult, secondResult])).resolves.toEqual([
      degraded,
      degraded
    ]);
    expect(codex.openTurn).toHaveBeenCalledOnce();
    const firstAttempts = queue.deferAttempts.filter(
      (attempt) => attempt.commandId === firstCommand.commandId
    );
    expect(firstAttempts).toHaveLength(2);
    expect(firstAttempts[0]?.claimToken).toMatch(/^claim-/);
    expect(firstAttempts[1]).toBe(firstAttempts[0]);
    expect(firstAttempts[1]?.result).toBe(firstAttempts[0]?.result);
    expect(queue.deferred).toEqual([
      { commandId: firstCommand.commandId, result: degraded },
      { commandId: secondCommand.commandId, result: degraded }
    ]);
  });
});
