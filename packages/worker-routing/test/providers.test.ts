import { createHash } from "node:crypto";

import type { OrcaOperation, OrcaReceipt } from "../../orca-adapter/src/index.js";
import { describe, expect, it } from "vitest";

import {
  ClaudeWorkerProvider,
  CodexWorkerProvider,
  STRICT_WORKER_LAUNCH_POLICY,
  WorkerProviderRegistry,
  parseWorkerAssignment,
  selectProvider,
  workerPrompt,
  type AssignmentArtifact,
  type ProviderCapabilities,
  type ProviderStartContext,
  type WorkerAssignment,
  type WorkerLaunchPolicy,
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
  malformedStartWithDispatch = false;
  staleObservation = false;
  startTaskId: string | undefined;
  effectiveEnvironmentKeys: string[] = ["HOME", "PATH"];
  includeProviderEnvironment = true;
  inspectionReadSource: "transcript" | "terminal" = "transcript";
  inspectionSecrets: Readonly<{
    slack: string;
    telegram: string;
    tailscale: string;
    openAiVoice: string;
  }> | undefined;

  async execute(operation: OrcaOperation): Promise<OrcaReceipt> {
    this.calls.push(structuredClone(operation));
    if (this.failure !== undefined) throw this.failure;
    switch (operation.kind) {
      case "dispatch_worker":
        return this.malformedStart
          ? receipt("malformed-start", this.malformedStartWithDispatch
              ? { dispatchId: "orca-dispatch-2" }
              : {})
          : receipt("worker-start-1", {
              dispatchId: "orca-dispatch-2",
              taskId: this.startTaskId ?? operation.taskId,
              runId: "orca-run-1",
              state: "ready",
              stage: "ready",
              setup: { state: "running" },
              effects: [],
              ...(this.includeProviderEnvironment
                ? {
                    launch: {
                      providerEnvironment: {
                        kind: "verified_effective_allowlist",
                        effectiveEnvironmentKeys: this.effectiveEnvironmentKeys
                      }
                    }
                  }
                : {})
            });
      case "show_worker": {
        const secrets = this.inspectionSecrets;
        return {
          id: "worker-show-1",
          ok: true,
          result: {
            dispatch: {
              id: operation.dispatchId,
              task_id: "orca-task-1",
              run_id: "orca-run-1",
              status: "dispatched",
              ...(secrets === undefined ? {} : { diagnostic: secrets.slack })
            },
            worker: {
              dispatch_id: operation.dispatchId,
              state: "ready",
              stage: "ready",
              agent_terminal_handle: "terminal-1",
              ...(secrets === undefined ? {} : { diagnostic: secrets.telegram })
            },
            terminal: secrets === undefined
              ? null
              : { lines: [secrets.tailscale], diagnostic: secrets.openAiVoice },
            observation: {
              status: "ready",
              exactWorker: !this.staleObservation,
              ...(secrets === undefined ? {} : { diagnostic: secrets.openAiVoice })
            },
            terminalResource: {
              id: "resource-1",
              ownershipState: "owned",
              releaseState: "active",
              ...(secrets === undefined ? {} : { diagnostic: secrets.slack })
            },
            ...(secrets === undefined ? {} : { diagnostic: secrets.telegram })
          },
          ...(secrets === undefined ? {} : { _meta: { diagnostic: secrets.tailscale } })
        };
      }
      case "read_worker": {
        const secrets = this.inspectionSecrets;
        const base = {
          dispatchId: operation.dispatchId,
          source: this.inspectionReadSource,
          cursor: "cursor-1",
          status: {
            worker: "ready",
            terminal: "running",
            ...(secrets === undefined ? {} : { diagnostic: secrets.slack })
          },
          warnings: secrets === undefined ? [] : [secrets.telegram],
          archived: false,
          ...(secrets === undefined ? {} : { diagnostic: secrets.tailscale })
        };
        const content = this.inspectionReadSource === "transcript"
          ? {
              transcript: {
                messages: secrets === undefined
                  ? []
                  : [{
                      id: "message-1",
                      role: "assistant",
                      blocks: [{ type: "text", text: secrets.openAiVoice }],
                      timestamp: 1,
                      source: "worker",
                      diagnostic: secrets.slack
                    }],
                limited: false,
                nextCursor: "cursor-1",
                returnedMessageCount: secrets === undefined ? 0 : 1,
                ...(secrets === undefined ? {} : { diagnostic: secrets.telegram })
              }
            }
          : {
              terminal: {
                lines: secrets === undefined ? [] : [secrets.openAiVoice],
                limited: false,
                nextCursor: "cursor-1",
                ...(secrets === undefined ? {} : { diagnostic: secrets.telegram })
              }
            };
        return {
          id: "worker-read-1",
          ok: true,
          result: { ...base, ...content },
          ...(secrets === undefined ? {} : { _meta: { diagnostic: secrets.tailscale } })
        };
      }
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
  claude: { worker: "available", hq: "unavailable" },
  providerChildEnvironmentIsolation: {
    kind: "verified_effective_allowlist",
    effectiveEnvironmentKeys: ["HOME", "PATH"]
  },
  assignmentArtifactAccess: { kind: "same_host" }
};

const verifiedEnvironmentIsolation = availableCapabilities.providerChildEnvironmentIsolation;

const privatePilotPolicy: WorkerLaunchPolicy = {
  kind: "orca_supervised_private_pilot",
  secretBoundaryAttestation: {
    channelAndVoiceSecrets: "keychain_or_runtime_only",
    absentFromAssignment: true,
    absentFromPromptArtifact: true,
    absentFromLogsAndAudit: true,
    absentFromConfiguredProviderEnvironment: true,
    inheritedProviderChildEnvironmentInspection: "not_available"
  }
};

function artifactFor(currentAssignment: WorkerAssignment): AssignmentArtifact {
  const content = workerPrompt(currentAssignment);
  const artifactDigest = createHash("sha256")
    .update(currentAssignment.taskId)
    .digest("hex");
  return {
    protocol: 1,
    artifactId: `assignment:${artifactDigest}`,
    path: `/var/run/orca-hq/assignments/${artifactDigest}.json`,
    version: 2,
    ownerDispatchId: currentAssignment.dispatchId,
    content,
    sha256: createHash("sha256").update(content).digest("hex")
  };
}

function startContext(
  currentAssignment: WorkerAssignment,
  overrides: Partial<ProviderStartContext> = {}
): ProviderStartContext {
  return {
    orcaTaskId: "orca-task-1",
    setup: "run",
    assignmentArtifact: artifactFor(currentAssignment),
    providerChildEnvironmentIsolationCapability: verifiedEnvironmentIsolation,
    assignmentArtifactAccess: { kind: "same_host" },
    workerLaunchPolicy: STRICT_WORKER_LAUNCH_POLICY,
    ...overrides
  };
}

describe("Orca-backed worker providers", () => {
  it.each(["codex", "claude"] as const)(
    "starts the exact %s provider with the complete immutable attempt assignment",
    async (providerId) => {
      // Break caught: reconstructing attempt context from the static Task can launch stale attempt-one scope.
      const orca = new FakeProviderOrca();
      const currentAssignment = assignment(providerId);

      const started = await providers(orca).get(providerId).start(currentAssignment, startContext(
        currentAssignment,
        {
        name: "implement",
        retryOf: "orca-dispatch-1"
        }
      ));

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
        promptDelivery: "prestart_atomic_assignment_artifact",
        attemptContext: "orca_injected_task_spec_and_prestart_assignment",
        credentialSource: "provider_authenticated_cli",
        postStartMail: false,
        providerChildEnvironmentIsolation: {
          kind: "verified_effective_allowlist",
          effectiveEnvironmentKeys: ["HOME", "PATH"]
        },
        assignmentArtifactAccess: { kind: "same_host" }
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

  it.each(["transcript", "terminal"] as const)(
    "projects %s inspection receipts to metadata-only audit records",
    async (source) => {
      // Break caught: public inspection payloads can contain channel, network, or voice secrets.
      const orca = new FakeProviderOrca();
      const secrets = {
        slack: "xoxb-inspection-slack-705cfc04",
        telegram: "inspection-telegram-5b89e7bb",
        tailscale: "tskey-inspection-c4ef57f1",
        openAiVoice: "sk-inspection-voice-e204c472"
      } as const;
      orca.inspectionReadSource = source;
      orca.inspectionSecrets = secrets;

      const inspected = await providers(orca).get("codex").inspect("orca-dispatch-2");

      expect(inspected.showReceipt).toEqual({
        id: "worker-show-1",
        ok: true,
        result: {
          dispatch: {
            id: "orca-dispatch-2",
            task_id: "orca-task-1",
            run_id: "orca-run-1",
            status: "dispatched"
          },
          worker: {
            dispatch_id: "orca-dispatch-2",
            state: "ready",
            stage: "ready",
            agent_terminal_handle: "terminal-1"
          },
          terminal: null,
          observation: { status: "ready", exactWorker: true },
          terminalResource: {
            id: "resource-1",
            ownershipState: "owned",
            releaseState: "active"
          }
        }
      });
      expect(inspected.readReceipt).toEqual({
        id: "worker-read-1",
        ok: true,
        result: {
          dispatchId: "orca-dispatch-2",
          source,
          cursor: "cursor-1",
          status: { worker: "ready", terminal: "running" },
          ...(source === "transcript"
            ? {
                transcript: {
                  messages: [],
                  limited: false,
                  nextCursor: "cursor-1",
                  returnedMessageCount: 1
                }
              }
            : { terminal: { lines: [], limited: false, nextCursor: "cursor-1" } }),
          warnings: [],
          archived: false
        }
      });
      expect(inspected.workerState).toBe("ready");
      const audit = JSON.stringify(inspected);
      for (const value of Object.values(secrets)) expect(audit).not.toContain(value);
      expect(audit).not.toContain("blocks");
      expect(audit).not.toContain("_meta");
      expect(audit).not.toContain("diagnostic");
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

    await expect(providers(orca).get("codex").start(
      nestedRequest,
      startContext(assignment())
    )).rejects.toThrow();
    expect(orca.calls).toEqual([]);
  });

  it("rejects a provider that differs from the immutable preferred agent", async () => {
    // Break caught: a registry lookup bug must not silently turn a Codex assignment into Claude work.
    const orca = new FakeProviderOrca();

    const currentAssignment = assignment("codex");
    await expect(providers(orca).get("claude").start(
      currentAssignment,
      startContext(currentAssignment)
    )).rejects.toMatchObject({ code: "provider_mismatch", provider: "claude" });
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

    const currentAssignment = assignment();
    await expect(providers(orca).get("codex").start(
      currentAssignment,
      startContext(currentAssignment)
    )).rejects.toMatchObject({
      code: "invalid_provider_receipt",
      provider: "codex",
      workerMayBeLive: true
    });
  });

  it("does not trust a raw Dispatch ID from a malformed post-start receipt", async () => {
    // Break caught: field presence before operation-specific parsing cannot authorize stop_worker.
    const orca = new FakeProviderOrca();
    orca.malformedStart = true;
    orca.malformedStartWithDispatch = true;
    const currentAssignment = assignment();

    const caught = await providers(orca).get("codex").start(
      currentAssignment,
      startContext(currentAssignment)
    ).catch((error: unknown) => error);
    expect(caught).toMatchObject({
      code: "invalid_provider_receipt",
      provider: "codex",
      workerMayBeLive: true
    });
    expect((caught as { trustedDispatchId?: string }).trustedDispatchId).toBeUndefined();
    expect((caught as { orcaDispatchId?: string }).orcaDispatchId).toBeUndefined();
  });

  it("does not trust a fully parsed start receipt whose Task differs from the request", async () => {
    // Break caught: a valid receipt for another Task must not authorize fencing its Dispatch.
    const orca = new FakeProviderOrca();
    orca.startTaskId = "orca-task-unrelated";
    const currentAssignment = assignment();

    const caught = await providers(orca).get("codex").start(
      currentAssignment,
      startContext(currentAssignment)
    ).catch((error: unknown) => error);
    expect(caught).toMatchObject({
      code: "invalid_provider_receipt",
      provider: "codex",
      workerMayBeLive: true
    });
    expect((caught as { trustedDispatchId?: string }).trustedDispatchId).toBeUndefined();
    expect((caught as { orcaDispatchId?: string }).orcaDispatchId).toBeUndefined();
  });

  it("rejects a worker-start receipt whose effective environment differs from preflight", async () => {
    // Break caught: capability configuration without a matching launch receipt is not attestation.
    const orca = new FakeProviderOrca();
    orca.effectiveEnvironmentKeys = ["HOME"];
    const currentAssignment = assignment();

    await expect(providers(orca).get("codex").start(
      currentAssignment,
      startContext(currentAssignment)
    )).rejects.toMatchObject({
      code: "invalid_provider_receipt",
      provider: "codex",
      workerMayBeLive: true,
      trustedDispatchId: "orca-dispatch-2"
    });
  });

  it.each(["codex", "claude"] as const)(
    "starts the exact %s provider under the explicit private-pilot policy without a public environment claim",
    async (providerId) => {
      // Break caught: Orca 1.4.195 omits child-environment evidence, so the pilot must record uncertainty.
      const orca = new FakeProviderOrca();
      orca.includeProviderEnvironment = false;
      const currentAssignment = assignment(providerId);

      const started = await providers(orca).get(providerId).start(currentAssignment, {
        ...startContext(currentAssignment),
        providerChildEnvironmentIsolationCapability: { kind: "unsupported" },
        workerLaunchPolicy: privatePilotPolicy
      });

      expect(started.boundary.providerChildEnvironmentIsolation).toEqual({
        kind: "unverified_orca_supervised"
      });
      expect(started.orcaReceipt.result).not.toHaveProperty("launch.providerEnvironment");
      expect(JSON.stringify(started)).not.toContain("verified_effective_allowlist");
      expect(orca.calls).toEqual([{
        kind: "dispatch_worker",
        taskId: "orca-task-1",
        worktree: currentAssignment.worktree.path,
        agent: providerId,
        setup: "run"
      }]);
    }
  );

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
        ? provider.start(assignment(), startContext(assignment()))
        : provider.inspect("orca-dispatch-2")).catch((error: unknown) => error);

      expect(caught).toMatchObject({ code: entry.want, provider: "codex", phase: entry.phase });
      if (entry.error.code === "orca_process_failed" && entry.phase === "start") {
        expect(caught).toMatchObject({ workerMayBeLive: true });
      }
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

  it("fails closed before worker-start when child environment isolation is unsupported", async () => {
    // Break caught: filtering only the Orca CLI process must not be reported as provider isolation.
    const orca = new FakeProviderOrca();
    const currentAssignment = assignment();

    await expect(providers(orca).get("codex").start(currentAssignment, {
      ...startContext(currentAssignment),
      providerChildEnvironmentIsolationCapability: { kind: "unsupported" }
    })).rejects.toMatchObject({
      code: "provider_environment_isolation_unavailable",
      provider: "codex",
      phase: "start"
    });
    expect(orca.calls).toEqual([]);
  });

  it("fails closed when the assignment artifact is not readable on the worker host", async () => {
    // Break caught: a saved-runtime worker cannot consume an HQ-local absolute artifact path.
    const orca = new FakeProviderOrca();
    const currentAssignment = assignment();

    await expect(providers(orca).get("codex").start(currentAssignment, {
      ...startContext(currentAssignment),
      assignmentArtifactAccess: { kind: "unsupported" }
    })).rejects.toMatchObject({
      code: "provider_assignment_artifact_access_unavailable",
      provider: "codex",
      phase: "start"
    });
    expect(orca.calls).toEqual([]);
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

  it("rejects a worker whose assignment artifact has no same-host access contract", () => {
    // Break caught: explicit saved-runtime connectivity is not an artifact transport.
    const capabilities: ProviderCapabilities = {
      ...availableCapabilities,
      assignmentArtifactAccess: { kind: "unsupported" }
    };

    expect(selectProvider({ role: "implement", preferredAgent: "codex" }, capabilities)).toEqual({
      kind: "unavailable",
      provider: "codex",
      reason: "provider_assignment_artifact_access_unavailable"
    });
  });

  it("selects an available worker with unsupported isolation only under the explicit private pilot", () => {
    // Break caught: an implicit fallback would silently weaken the default worker boundary.
    const capabilities: ProviderCapabilities = {
      ...availableCapabilities,
      providerChildEnvironmentIsolation: { kind: "unsupported" }
    };

    expect(selectProvider(
      { role: "implement", preferredAgent: "codex" },
      capabilities
    )).toEqual({
      kind: "unavailable",
      provider: "codex",
      reason: "provider_environment_isolation_unavailable"
    });
    expect(selectProvider(
      { role: "implement", preferredAgent: "codex" },
      capabilities,
      privatePilotPolicy
    )).toEqual({ kind: "selected", provider: "codex" });
  });
});
