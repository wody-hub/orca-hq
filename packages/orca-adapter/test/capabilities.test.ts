import { readFile } from "node:fs/promises";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createFakeOrca, type FakeOrca } from "../../test-support/src/index.js";
import { OrcaClient } from "../src/index.js";
import { boundedOrcaEnvironment, runOrca } from "../src/process.js";

const officialSkillText = {
  "orca-cli": "orca cli reference",
  orchestration: "orchestration reference"
} as const;

let statusFixture: Record<string, unknown>;
const fakes: FakeOrca[] = [];

beforeAll(async () => {
  statusFixture = JSON.parse(await readFile(
    new URL("./fixtures/status-1.4.194.json", import.meta.url),
    "utf8"
  )) as Record<string, unknown>;
});

afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.cleanup()));
});

async function fakeOrca(): Promise<FakeOrca> {
  const fake = await createFakeOrca();
  fakes.push(fake);
  return fake;
}

async function enqueueStartup(
  fake: FakeOrca,
  status: unknown = statusFixture
): Promise<void> {
  await fake.enqueueJson(["status", "--json"], status);
  for (const name of ["orca-cli", "orchestration"] as const) {
    await fake.enqueueJson(["skills", "get", name, "--json"], {
      name,
      full: false,
      markdown: officialSkillText[name]
    });
  }
}

function clientFor(
  fake: FakeOrca,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    terminationGraceMs?: number;
    expectedVersionRange?: string;
  } = {}
): OrcaClient {
  return new OrcaClient({
    executablePath: fake.executablePath,
    signal: options.signal ?? new AbortController().signal,
    timeoutMs: options.timeoutMs ?? 5_000,
    ...(options.terminationGraceMs === undefined
      ? {}
      : { terminationGraceMs: options.terminationGraceMs }),
    expectedVersionRange: options.expectedVersionRange ?? ">=1.4.194"
  });
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function statusWith(change: { version?: string; capabilities?: readonly string[] }): unknown {
  const status = structuredClone(statusFixture) as {
    result: { runtime: { appVersion: string; capabilities: string[] } };
  };
  if (change.version !== undefined) status.result.runtime.appVersion = change.version;
  if (change.capabilities !== undefined) {
    status.result.runtime.capabilities = [...change.capabilities];
  }
  return status;
}

describe("Orca CLI capability adapter", () => {
  it("forwards only the bounded CLI environment required for normal authenticated profiles", () => {
    // Break caught: worker-start may otherwise expose HQ channel or voice secrets to a provider process.
    expect(boundedOrcaEnvironment({
      HOME: "/Users/operator",
      PATH: "/usr/local/bin:/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      TMPDIR: "/tmp/session/",
      TERM: "xterm-256color",
      XDG_CONFIG_HOME: "/Users/operator/.config",
      SLACK_BOT_TOKEN: "slack-secret",
      TELEGRAM_BOT_TOKEN: "telegram-secret",
      TAILSCALE_AUTH_KEY: "tailscale-secret",
      OPENAI_API_KEY: "voice-secret",
      ARBITRARY_MODEL_ENV: "must-not-pass"
    })).toEqual({
      HOME: "/Users/operator",
      PATH: "/usr/local/bin:/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      TMPDIR: "/tmp/session/",
      TERM: "xterm-256color",
      XDG_CONFIG_HOME: "/Users/operator/.config"
    });
  });

  it("accepts 1.4.194 and binds both official skill hashes to that version", async () => {
    // Break caught: a status-only probe could mutate through stale, unversioned command grammar.
    const fake = await fakeOrca();
    await enqueueStartup(fake);
    const client = clientFor(fake);

    await expect(client.health()).resolves.toEqual({
      compatible: true,
      version: "1.4.194",
      capabilities: expect.arrayContaining([
        "orchestration.contract.v1",
        "orchestration.worker-stop-verdict.v1",
        "orchestration.worker-launch-preferences.v1"
      ]),
      missingCapabilities: [],
      skills: [
        {
          name: "orca-cli",
          orcaVersion: "1.4.194",
          sha256: "066c86af2281ffa98087d6f7c11f3db1cd4b6925ca180e69f7f8e6030da6e99c"
        },
        {
          name: "orchestration",
          orcaVersion: "1.4.194",
          sha256: "ab42ffefdc109f5d6c85a9478e999120a32ae038d831f877c3fc6bc7b46be961"
        }
      ]
    });
    await expect(client.loadSkill("orchestration")).resolves.toMatchObject({
      name: "orchestration",
      text: "orchestration reference",
      orcaVersion: "1.4.194"
    });
    await expect(fake.calls()).resolves.toEqual([
      ["status", "--json"],
      ["skills", "get", "orca-cli", "--json"],
      ["skills", "get", "orchestration", "--json"]
    ]);
  });

  it("marks health incompatible when a current worker lifecycle capability is absent", async () => {
    // Break caught: version matching alone could permit mutations against an older worker lifecycle contract.
    const fake = await fakeOrca();
    await enqueueStartup(fake, statusWith({
      capabilities: [
        "orchestration.contract.v1",
        "orchestration.worker-stop-verdict.v1"
      ]
    }));
    const client = clientFor(fake);

    await expect(client.health()).resolves.toMatchObject({
      compatible: false,
      version: "1.4.194",
      missingCapabilities: ["orchestration.worker-launch-preferences.v1"]
    });
    await expect(client.execute({ kind: "create_run", objective: "must not run" }))
      .rejects.toMatchObject({ code: "orca_incompatible" });
    await expect(fake.calls()).resolves.toHaveLength(3);
  });

  it("rejects a skill response whose name does not match the requested official skill", async () => {
    // Break caught: binding orchestration text under the CLI skill name corrupts the versioned grammar audit.
    const fake = await fakeOrca();
    await fake.enqueueJson(["status", "--json"], statusFixture);
    await fake.enqueueJson(["skills", "get", "orca-cli", "--json"], {
      name: "orchestration",
      full: false,
      markdown: "wrong skill"
    });

    await expect(clientFor(fake).health()).rejects.toMatchObject({
      code: "invalid_orca_receipt"
    });
  });

  it("blocks mutations below 1.4.194 even when the injected range is broader", async () => {
    // Break caught: a broad caller range must not weaken the adapter's mandatory public-contract floor.
    const fake = await fakeOrca();
    await enqueueStartup(fake, statusWith({ version: "1.4.193" }));
    const client = clientFor(fake, { expectedVersionRange: "*" });

    await expect(client.execute({ kind: "create_run", objective: "test run" }))
      .rejects.toMatchObject({ code: "orca_incompatible" });
    await expect(fake.calls()).resolves.toHaveLength(3);
  });

  it("rejects prose where a JSON receipt is required", async () => {
    // Break caught: accepting a human-readable success message bypasses the receipt trust boundary.
    const fake = await fakeOrca();
    await enqueueStartup(fake);
    await fake.enqueue(["repo", "list", "--json"], { stdout: "worker started" });

    await expect(clientFor(fake).execute({ kind: "list_projects" }))
      .rejects.toMatchObject({ code: "invalid_orca_receipt" });
  });

  it("rejects JSON that does not match the public receipt envelope", async () => {
    // Break caught: JSON.parse success alone must not let an arbitrary object cross the receipt boundary.
    const fake = await fakeOrca();
    await enqueueStartup(fake);
    await fake.enqueueJson(["repo", "list", "--json"], { unexpected: true });

    await expect(clientFor(fake).execute({ kind: "list_projects" }))
      .rejects.toMatchObject({ code: "invalid_orca_receipt" });
  });

  it("classifies a nonzero CLI exit without exposing stderr", async () => {
    // Break caught: process failures must not masquerade as JSON success or leak arbitrary provider stderr.
    const fake = await fakeOrca();
    await enqueueStartup(fake);
    await fake.enqueue(["repo", "list", "--json"], {
      exitCode: 17,
      stderr: "secret-looking provider diagnostic"
    });

    const error = await clientFor(fake).execute({ kind: "list_projects" }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "orca_process_failed", exitCode: 17 });
    expect(JSON.stringify(error)).not.toContain("secret-looking");
  });

  it("classifies a bounded process timeout", async () => {
    // Break caught: an unresponsive CLI child can otherwise stall the coordinator indefinitely.
    const fake = await fakeOrca();
    await fake.enqueueJson(["repo", "list", "--json"], {
      id: "projects", ok: true, result: { repos: [] }
    }, { delayMs: 60_000 });

    await expect(runOrca(["repo", "list"], {
      executablePath: fake.executablePath,
      signal: new AbortController().signal,
      timeoutMs: 100,
      terminationGraceMs: 20
    })).rejects.toMatchObject({ code: "orca_timeout", timeoutMs: 100 });
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid termination grace period %s",
    async (terminationGraceMs) => {
      // Break caught: an invalid escalation deadline can disable bounded child cleanup.
      const fake = await fakeOrca();

      expect(() => clientFor(fake, { terminationGraceMs }))
        .toThrow("terminationGraceMs must be a positive safe integer");
    }
  );

  it("SIGKILLs a timeout child that ignores SIGTERM before returning", async () => {
    // Break caught: waiting forever after SIGTERM defeats the configured timeout and leaves an orphan.
    const fake = await fakeOrca();
    const args = ["repo", "list", "--json"] as const;
    await fake.enqueueJson(args, {
      id: "projects", ok: true, result: { repos: [] }
    }, { delayMs: 60_000, ignoreSigterm: true });

    const execution = runOrca(["repo", "list"], {
      executablePath: fake.executablePath,
      signal: new AbortController().signal,
      timeoutMs: 2_000,
      terminationGraceMs: 20
    }).catch((error: unknown) => error);

    await expect(execution).resolves.toMatchObject({ code: "orca_timeout", timeoutMs: 2_000 });
    const pid = await fake.waitForProcess(args);
    expect(processExists(pid)).toBe(false);
  });

  it("classifies an aborted operation before launching another process", async () => {
    // Break caught: an already-cancelled coordinator turn must not start an Orca subprocess.
    const fake = await fakeOrca();
    const controller = new AbortController();
    await enqueueStartup(fake);
    const client = clientFor(fake, { signal: controller.signal });
    await client.health();
    controller.abort();

    await expect(client.execute({ kind: "list_projects" }))
      .rejects.toMatchObject({ code: "orca_aborted" });
    await expect(fake.calls()).resolves.toHaveLength(3);
  });

  it("classifies an operation aborted while its CLI child is running", async () => {
    // Break caught: cancellation after spawn must terminate the child and remain distinct from timeout/failure.
    const fake = await fakeOrca();
    const controller = new AbortController();
    await enqueueStartup(fake);
    await fake.enqueueJson(["repo", "list", "--json"], {
      id: "projects", ok: true, result: { repos: [] }
    }, { delayMs: 200 });
    const client = clientFor(fake, { signal: controller.signal });
    await client.health();

    const execution = client.execute({ kind: "list_projects" });
    setTimeout(() => controller.abort(), 20);

    await expect(execution).rejects.toMatchObject({ code: "orca_aborted" });
  });

  it("SIGKILLs an aborted child that ignores SIGTERM before returning", async () => {
    // Break caught: abort must have a hard shutdown deadline and must not resolve while the child survives.
    const fake = await fakeOrca();
    const controller = new AbortController();
    const args = ["repo", "list", "--json"] as const;
    await fake.enqueueJson(args, {
      id: "projects", ok: true, result: { repos: [] }
    }, { delayMs: 60_000, ignoreSigterm: true });

    const execution = runOrca(["repo", "list"], {
      executablePath: fake.executablePath,
      signal: controller.signal,
      timeoutMs: 10_000,
      terminationGraceMs: 20
    });
    const pid = await fake.waitForProcess(args, 5_000);
    controller.abort();

    await expect(execution).rejects.toMatchObject({ code: "orca_aborted" });
    expect(processExists(pid)).toBe(false);
  }, 10_000);

  it("turns a stale worker handle receipt into a typed recovery error", async () => {
    // Break caught: treating stale runtime handles as generic process failures can trigger unsafe blind retries.
    const fake = await fakeOrca();
    await enqueueStartup(fake);
    await fake.enqueueJson(
      ["orchestration", "worker-show", "--dispatch", "dispatch-old", "--json"],
      {
        id: "worker-show",
        ok: false,
        error: { code: "terminal_handle_stale", message: "re-list the terminal" }
      },
      { exitCode: 1 }
    );

    await expect(clientFor(fake).execute({
      kind: "show_worker", dispatchId: "dispatch-old"
    })).rejects.toMatchObject({ code: "orca_stale_handle" });
  });

  it("validates and safely classifies the current public error envelope", async () => {
    // Break caught: current `{ok:false,error}` receipts must not collapse into malformed-receipt errors.
    const fake = await fakeOrca();
    await enqueueStartup(fake);
    await fake.enqueueJson(
      ["orchestration", "worker-show", "--dispatch", "missing", "--json"],
      {
        id: "worker-show",
        ok: false,
        error: { code: "dispatch_not_found", message: "not found" }
      },
      { exitCode: 1 }
    );

    await expect(clientFor(fake).execute({
      kind: "show_worker", dispatchId: "missing"
    })).rejects.toMatchObject({
      code: "orca_command_failed",
      orcaCode: "dispatch_not_found"
    });
  });

  it("maps lifecycle operations to fixed public argv and validates their current results", async () => {
    // Break caught: lifecycle command drift or shell-string construction can target the wrong public operation.
    const fake = await fakeOrca();
    await enqueueStartup(fake);
    const cases = [
      {
        operation: { kind: "create_run" as const, objective: "coordinate work" },
        args: [
          "orchestration", "run-create", "--objective", "coordinate work", "--json"
        ],
        result: { runId: "run-1" }
      },
      {
        operation: {
          kind: "create_task" as const,
          spec: "implement adapter",
          dependencies: ["task-0"],
          parentTaskId: "task-parent"
        },
        args: [
          "orchestration", "task-create", "--spec", "implement adapter",
          "--deps", "[\"task-0\"]", "--parent", "task-parent", "--json"
        ],
        result: { taskId: "task-1", runId: "run-1", status: "ready" }
      },
      {
        operation: {
          kind: "dispatch_worker" as const,
          taskId: "task-1",
          worktree: "new-top-level",
          agent: "codex" as const,
          name: "adapter-worker",
          setup: "run" as const,
          retryOf: "dispatch-0"
        },
        args: [
          "orchestration", "worker-start", "--task", "task-1",
          "--worktree", "new-top-level", "--agent", "codex",
          "--name", "adapter-worker", "--setup", "run",
          "--retry-of", "dispatch-0", "--json"
        ],
        result: {
          dispatchId: "dispatch-1",
          taskId: "task-1",
          runId: "run-1",
          state: "ready",
          stage: "ready",
          setup: { state: "running" },
          effects: []
        }
      },
      {
        operation: { kind: "show_worker" as const, dispatchId: "dispatch-1" },
        args: ["orchestration", "worker-show", "--dispatch", "dispatch-1", "--json"],
        result: {
          dispatch: {
            id: "dispatch-1",
            task_id: "task-1",
            run_id: "run-1",
            status: "dispatched"
          },
          worker: {
            dispatch_id: "dispatch-1",
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
      },
      {
        operation: {
          kind: "read_worker" as const,
          dispatchId: "dispatch-1",
          limit: 50,
          cursor: "cursor-1"
        },
        args: [
          "orchestration", "worker-read", "--dispatch", "dispatch-1",
          "--limit", "50", "--cursor", "cursor-1", "--json"
        ],
        result: {
          dispatchId: "dispatch-1",
          source: "transcript",
          cursor: "cursor-2",
          status: { worker: "ready", terminal: "running" },
          transcript: {
            messages: [],
            limited: false,
            nextCursor: "cursor-2",
            returnedMessageCount: 0
          },
          warnings: [],
          archived: false
        }
      },
      {
        operation: { kind: "stop_worker" as const, dispatchId: "dispatch-1" },
        args: ["orchestration", "worker-stop", "--dispatch", "dispatch-1", "--json"],
        result: { dispatchId: "dispatch-1", state: "stopped", verdict: "stopped" }
      },
      {
        operation: { kind: "release_worker" as const, dispatchId: "dispatch-1" },
        args: ["orchestration", "worker-release", "--dispatch", "dispatch-1", "--json"],
        result: { dispatchId: "dispatch-1", state: "released", verdict: "released" }
      }
    ] as const;
    for (const entry of cases) {
      await fake.enqueueJson(entry.args, {
        id: `receipt-${entry.operation.kind}`,
        ok: true,
        result: entry.result
      });
    }
    const client = clientFor(fake);

    for (const entry of cases) await client.execute(entry.operation);

    await expect(fake.calls()).resolves.toEqual([
      ["status", "--json"],
      ["skills", "get", "orca-cli", "--json"],
      ["skills", "get", "orchestration", "--json"],
      ...cases.map((entry) => [...entry.args])
    ]);
  });

  it("rejects an empty result for every exposed orchestration operation", async () => {
    // Break caught: validating only `{id,ok,result}` lets `{result:{}}` forge lifecycle success.
    const fake = await fakeOrca();
    await enqueueStartup(fake);
    const cases = [
      {
        operation: { kind: "create_run" as const, objective: "coordinate work" },
        args: ["orchestration", "run-create", "--objective", "coordinate work", "--json"]
      },
      {
        operation: { kind: "create_task" as const, spec: "implement adapter" },
        args: ["orchestration", "task-create", "--spec", "implement adapter", "--json"]
      },
      {
        operation: {
          kind: "dispatch_worker" as const,
          taskId: "task-1",
          worktree: "current",
          agent: "codex" as const
        },
        args: [
          "orchestration", "worker-start", "--task", "task-1",
          "--worktree", "current", "--agent", "codex", "--json"
        ]
      },
      {
        operation: { kind: "show_worker" as const, dispatchId: "dispatch-1" },
        args: ["orchestration", "worker-show", "--dispatch", "dispatch-1", "--json"]
      },
      {
        operation: { kind: "read_worker" as const, dispatchId: "dispatch-1" },
        args: ["orchestration", "worker-read", "--dispatch", "dispatch-1", "--json"]
      },
      {
        operation: { kind: "stop_worker" as const, dispatchId: "dispatch-1" },
        args: ["orchestration", "worker-stop", "--dispatch", "dispatch-1", "--json"]
      },
      {
        operation: { kind: "release_worker" as const, dispatchId: "dispatch-1" },
        args: ["orchestration", "worker-release", "--dispatch", "dispatch-1", "--json"]
      }
    ] as const;
    for (const entry of cases) {
      await fake.enqueueJson(entry.args, {
        id: `malformed-${entry.operation.kind}`,
        ok: true,
        result: {}
      });
    }
    const client = clientFor(fake);

    for (const entry of cases) {
      await expect(client.execute(entry.operation)).rejects.toMatchObject({
        code: "invalid_orca_receipt"
      });
    }
  });

  it("constructs mutation arguments from a validated typed operation", async () => {
    // Break caught: interpolating an objective into a shell string would make it executable command syntax.
    const fake = await fakeOrca();
    await enqueueStartup(fake);
    await fake.enqueueJson([
      "orchestration", "run-create", "--objective", "inspect; echo not-a-command", "--json"
    ], {
      id: "run-create", ok: true, result: { runId: "run-1" }
    });

    await expect(clientFor(fake).execute({
      kind: "create_run",
      objective: "inspect; echo not-a-command"
    })).resolves.toMatchObject({ ok: true });
    await expect(fake.calls()).resolves.toContainEqual([
      "orchestration", "run-create", "--objective", "inspect; echo not-a-command", "--json"
    ]);
  });

  it("discovers projects only from a schema-valid public repo-list receipt", async () => {
    // Break caught: returning an unchecked result lets malformed repo identity data enter routing.
    const fake = await fakeOrca();
    await enqueueStartup(fake);
    await fake.enqueueJson(["repo", "list", "--json"], {
      id: "repos",
      ok: true,
      result: {
        repos: [{
          id: "repo-1",
          path: "/tmp/project-a",
          displayName: "project-a",
          kind: "git",
          extraCurrentField: true
        }]
      }
    });

    await expect(clientFor(fake).discoverProjects()).resolves.toEqual([{
      id: "repo-1",
      path: "/tmp/project-a",
      displayName: "project-a",
      kind: "git"
    }]);
  });
});
