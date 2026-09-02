import type { OrcaOperation, OrcaReceipt } from "../../orca-adapter/src/index.js";
import { describe, expect, it } from "vitest";

import {
  ClaudeWorkerProvider,
  CodexWorkerProvider,
  WorkerProviderRegistry,
  parseWorkerAssignment,
  selectProvider,
  workerPrompt,
  type ProviderCapabilities,
  type WorkerAssignment,
  type WorkerProviderId
} from "../src/index.js";

function assignment(preferredAgent: WorkerProviderId = "codex"): WorkerAssignment {
  return parseWorkerAssignment({
    protocol: 1,
    project: {
      projectKey: "synthetic-api",
      orcaProjectId: "orca-project-1"
    },
    repo: {
      repoId: "repo-1",
      repositoryPath: "/srv/orca/projects/synthetic-api"
    },
    worktree: {
      kind: "isolated",
      path: "/srv/orca/worktrees/proposal-1-implement-2",
      branch: "orca/proposal-1/implement/2",
      head: "0123456789abcdef0123456789abcdef01234567"
    },
    base: {
      ref: "main",
      commit: "0123456789abcdef0123456789abcdef01234567"
    },
    title: "Implement the requested API change",
    role: "implement",
    preferredAgent,
    fileScope: ["src/**", "test/**"],
    acceptanceCommands: ["pnpm test", "pnpm typecheck"],
    prohibitedEffects: ["push", "deployment", "secret access"],
    taskId: "task:proposal-1:implement",
    dispatchId: "dispatch:proposal-1:implement:2",
    permissions: "read-write",
    nestedWorkers: "forbidden"
  });
}

function receipt(id: string, result: unknown): OrcaReceipt {
  return { id, ok: true, result };
}

class FakeProviderOrca {
  readonly calls: OrcaOperation[] = [];
  failure: Error | undefined;
  malformedStart = false;
  staleObservation = false;

  async execute(operation: OrcaOperation): Promise<OrcaReceipt> {
    this.calls.push(structuredClone(operation));
    if (this.failure !== undefined) throw this.failure;
    switch (operation.kind) {
      case "dispatch_worker":
        return this.malformedStart
          ? receipt("malformed-start", {})
          : receipt("worker-start-1", {
              dispatchId: "orca-dispatch-2",
              taskId: operation.taskId,
              runId: "orca-run-1",
              state: "ready",
              stage: "ready",
              setup: { state: "running" },
              effects: []
            });
      case "show_worker":
        return receipt("worker-show-1", {
          dispatch: {
            id: operation.dispatchId,
            task_id: "orca-task-1",
            run_id: "orca-run-1",
            status: "dispatched"
          },
          worker: {
            dispatch_id: operation.dispatchId,
            state: "ready",
            stage: "ready",
            agent_terminal_handle: "terminal-1"
          },
          terminal: null,
          observation: {
            status: "ready",
            exactWorker: !this.staleObservation
          },
          terminalResource: {
            id: "resource-1",
            ownershipState: "owned",
            releaseState: "active"
          }
        });
      case "read_worker":
        return receipt("worker-read-1", {
          dispatchId: operation.dispatchId,
          source: "transcript",
          cursor: "cursor-1",
          status: { worker: "ready", terminal: "running" },
          transcript: {
            messages: [],
            limited: false,
            nextCursor: "cursor-1",
            returnedMessageCount: 0
          },
          warnings: [],
          archived: false
        });
      default:
        throw new Error(`unexpected operation ${operation.kind}`);
    }
  }
}

function providers(orca: FakeProviderOrca): WorkerProviderRegistry {
  return new WorkerProviderRegistry([
    new CodexWorkerProvider({ orca }),
    new ClaudeWorkerProvider({ orca })
  ]);
}

const availableCapabilities: ProviderCapabilities = {
  codex: { worker: "available", hq: "available" },
  claude: { worker: "available", hq: "unavailable" }
};

describe("Orca-backed worker providers", () => {
  it.each(["codex", "claude"] as const)(
    "starts the exact %s provider with the complete immutable attempt assignment",
    async (providerId) => {
      // Break caught: reconstructing attempt context from the static Task can launch stale attempt-one scope.
      const orca = new FakeProviderOrca();
      const currentAssignment = assignment(providerId);

      const started = await providers(orca).get(providerId).start(currentAssignment, {
        orcaTaskId: "orca-task-1",
        name: "implement",
        setup: "run",
        retryOf: "orca-dispatch-1"
      });

      expect(orca.calls).toEqual([{
        kind: "dispatch_worker",
        taskId: "orca-task-1",
        worktree: currentAssignment.worktree.path,
        agent: providerId,
        name: "implement",
        setup: "run",
        retryOf: "orca-dispatch-1"
      }]);
      expect(started).toMatchObject({
        kind: "provider_start",
        protocol: 1,
        provider: providerId,
        assignmentTaskId: currentAssignment.taskId,
        assignmentDispatchId: currentAssignment.dispatchId,
        orcaTaskId: "orca-task-1",
        orcaDispatchId: "orca-dispatch-2",
        orcaReceipt: { id: "worker-start-1", ok: true },
        boundary: {
          lifecycleAuthority: "orca_worker_start",
          promptDelivery: "persisted_launch_artifact",
          attemptContext: "orca_injected_preamble_and_persisted_assignment",
          credentialSource: "provider_authenticated_cli",
          postStartMail: false,
          forwardedEnvironmentKeys: []
        }
      });
      expect(JSON.parse(started.promptArtifact.content)).toEqual({
        protocol: 1,
        assignment: currentAssignment,
        nestedWorkers: "forbidden",
        reportExactlyOnce: true
      });
    }
  );

  it.each(["codex", "claude"] as const)(
    "inspects the exact %s dispatch through worker-show and worker-read",
    async (providerId) => {
      // Break caught: inspecting an ambient terminal can attribute another worker's output to this Dispatch.
      const orca = new FakeProviderOrca();

      const inspected = await providers(orca).get(providerId).inspect("orca-dispatch-2");

      expect(orca.calls).toEqual([
        { kind: "show_worker", dispatchId: "orca-dispatch-2" },
        { kind: "read_worker", dispatchId: "orca-dispatch-2", limit: 100 }
      ]);
      expect(inspected).toMatchObject({
        kind: "provider_inspect",
        protocol: 1,
        provider: providerId,
        dispatchId: "orca-dispatch-2",
        workerState: "ready",
        showReceipt: { id: "worker-show-1", ok: true },
        readReceipt: { id: "worker-read-1", ok: true }
      });
    }
  );

  it("rejects nested-worker authority before any Orca operation", async () => {
    // Break caught: a model-authored nested launch can escape the one-attempt supervised lifecycle.
    const orca = new FakeProviderOrca();
    const nestedRequest = {
      ...assignment(),
      nestedWorkers: "allowed"
    } as unknown as WorkerAssignment;

    await expect(providers(orca).get("codex").start(nestedRequest, {
      orcaTaskId: "orca-task-1",
      setup: "run"
    })).rejects.toThrow();
    expect(orca.calls).toEqual([]);
  });

  it("rejects a provider that differs from the immutable preferred agent", async () => {
    // Break caught: a registry lookup bug must not silently turn a Codex assignment into Claude work.
    const orca = new FakeProviderOrca();

    await expect(providers(orca).get("claude").start(assignment("codex"), {
      orcaTaskId: "orca-task-1",
      setup: "run"
    })).rejects.toMatchObject({ code: "provider_mismatch", provider: "claude" });
    expect(orca.calls).toEqual([]);
  });

  it("validates a protocol-v1 prompt before returning it", () => {
    // Break caught: dropping scope or exactly-once reporting from the launch artifact weakens authorization.
    const currentAssignment = assignment("claude");

    expect(JSON.parse(workerPrompt(currentAssignment))).toEqual({
      protocol: 1,
      assignment: currentAssignment,
      nestedWorkers: "forbidden",
      reportExactlyOnce: true
    });
  });

  it("rejects a malformed worker-start receipt", async () => {
    // Break caught: accepting an empty public receipt can persist a worker that Orca never created.
    const orca = new FakeProviderOrca();
    orca.malformedStart = true;

    await expect(providers(orca).get("codex").start(assignment(), {
      orcaTaskId: "orca-task-1",
      setup: "run"
    })).rejects.toMatchObject({ code: "invalid_provider_receipt", provider: "codex" });
  });

  it("classifies authentication, process, and stale-dispatch failures without leaking diagnostics", async () => {
    // Break caught: collapsing failures or echoing provider stderr can retry auth errors and expose secrets.
    const cases = [
      {
        phase: "start" as const,
        error: Object.assign(new Error("secret auth diagnostic"), {
          code: "orca_command_failed",
          orcaCode: "authentication_required"
        }),
        want: "provider_authentication_required"
      },
      {
        phase: "start" as const,
        error: Object.assign(new Error("secret process diagnostic"), {
          code: "orca_process_failed"
        }),
        want: "provider_process_failed"
      },
      {
        phase: "inspect" as const,
        error: Object.assign(new Error("secret stale diagnostic"), {
          code: "orca_stale_handle"
        }),
        want: "stale_dispatch"
      }
    ];

    for (const entry of cases) {
      const orca = new FakeProviderOrca();
      orca.failure = entry.error;
      const provider = providers(orca).get("codex");
      const caught = await (entry.phase === "start"
        ? provider.start(assignment(), { orcaTaskId: "orca-task-1", setup: "run" })
        : provider.inspect("orca-dispatch-2")).catch((error: unknown) => error);

      expect(caught).toMatchObject({ code: entry.want, provider: "codex", phase: entry.phase });
      expect(JSON.stringify(caught)).not.toContain("secret");
    }
  });

  it("classifies a non-exact Orca observation as a stale Dispatch", async () => {
    // Break caught: a recycled terminal handle must never be accepted as the requested worker.
    const orca = new FakeProviderOrca();
    orca.staleObservation = true;

    await expect(providers(orca).get("claude").inspect("orca-dispatch-2"))
      .rejects.toMatchObject({ code: "stale_dispatch", provider: "claude" });
  });
});

describe("provider selection", () => {
  it("does not substitute Claude for an unavailable Codex HQ", () => {
    // Break caught: degraded HQ must queue rather than transferring coordination authority to Claude.
    const capabilities: ProviderCapabilities = {
      ...availableCapabilities,
      codex: { worker: "available", hq: "unavailable" }
    };

    expect(selectProvider({ role: "hq", preferredAgent: "codex" }, capabilities)).toEqual({
      kind: "unavailable",
      provider: "codex",
      reason: "provider_unavailable"
    });
  });

  it("never permits Claude to become HQ even if a probe claims availability", () => {
    // Break caught: an erroneous capability probe must not override the sole-HQ authority rule.
    const capabilities: ProviderCapabilities = {
      ...availableCapabilities,
      claude: { worker: "available", hq: "available" }
    };

    expect(selectProvider({ role: "hq", preferredAgent: "claude" }, capabilities)).toEqual({
      kind: "unavailable",
      provider: "claude",
      reason: "hq_requires_codex"
    });
  });

  it("does not substitute a peer when the preferred worker is unavailable", () => {
    // Break caught: fallback can assign work to a model family that was never authorized.
    const capabilities: ProviderCapabilities = {
      ...availableCapabilities,
      codex: { worker: "unavailable", hq: "available" }
    };

    expect(selectProvider({ role: "implement", preferredAgent: "codex" }, capabilities)).toEqual({
      kind: "unavailable",
      provider: "codex",
      reason: "provider_unavailable"
    });
  });
});
