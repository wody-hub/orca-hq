import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ControlStore, openDatabase } from "@orca-hq/persistence";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  VerificationReportSchema,
  VerificationService,
  completionDecision,
  createVerifierTask,
  selectVerifier,
  type VerificationCommit,
  type VerificationLifecycleStore,
  type VerificationReport,
  type VerificationTask,
  type WorkerProviderId
} from "../src/index.js";

const input = {
  runId: "run:proposal-1",
  implementationTaskId: "task:proposal-1:implement",
  implementationDispatchId: "dispatch:proposal-1:implement:1",
  implementationProvider: "codex" as const,
  cycle: 0,
  projectRoute: {
    projectKey: "synthetic-api",
    orcaProjectId: "orca-project-1",
    repositoryPath: "/srv/orca/projects/synthetic-api"
  },
  requestedScope: ["src/**", "test/**"],
  changedFiles: ["src/change.ts", "test/change.test.ts"],
  gitDiff: {
    sha256: "a".repeat(64),
    summary: "Adds the requested behavior and its regression test."
  },
  testReceipts: [{
    command: "pnpm test",
    exitCode: 0,
    outcome: "passed" as const,
    auditReference: "audit:test:1"
  }],
  prohibitedEffects: ["push", "deployment", "secret access"],
  workerResult: {
    outcome: "completed" as const,
    summary: "Implementation process exited cleanly",
    auditReference: "audit:worker:1"
  },
  auditReferences: ["audit:route:1", "audit:dispatch:1"]
};

const completionTarget = {
  commandId: "command-1",
  channel: "slack" as const,
  destination: "C123",
  nextAttemptAt: "2026-09-02T00:00:00.000Z"
};

function report(
  task: VerificationTask,
  verdict: "pass" | "fail",
  overrides: Partial<VerificationReport> = {}
): VerificationReport {
  return VerificationReportSchema.parse({
    reportId: `report:${task.taskId}`,
    runId: task.runId,
    verificationTaskId: task.taskId,
    implementationTaskId: task.implementationTaskId,
    implementationDispatchId: task.implementationDispatchId,
    cycle: task.cycle,
    verdict,
    projectRoute: task.projectRoute,
    changedFiles: task.changedFiles,
    diffSha256: task.gitDiff.sha256,
    diffSummary: task.gitDiff.summary,
    commands: task.testReceipts,
    implementationProvider: task.implementationProvider,
    verifierProvider: task.preferredAgent,
    findings: verdict === "pass" ? [] : ["Acceptance behavior is incomplete"],
    evidence: verdict === "pass" ? ["audit:test:1"] : [],
    auditReferences: [...task.auditReferences, "audit:verification:1"],
    verifierEffects: {
      filesModified: false,
      committed: false,
      pushed: false,
      pullRequestChanged: false,
      merged: false,
      deployed: false,
      secretsAccessed: false,
      productionAccessed: false
    },
    ...overrides
  });
}

class MemoryVerificationStore implements VerificationLifecycleStore {
  readonly tasks: VerificationTask[] = [];
  readonly commits: VerificationCommit[] = [];

  saveVerificationTask(task: VerificationTask): void {
    this.tasks.push(structuredClone(task));
  }

  commitVerification(commit: VerificationCommit): void {
    this.commits.push(structuredClone(commit));
    if (commit.fixTask !== undefined) this.tasks.push(structuredClone(commit.fixTask));
  }
}

const temporaryDirectories: string[] = [];
const openDatabases: Database.Database[] = [];

function persistentStore(): { store: ControlStore; database: Database.Database } {
  const directory = mkdtempSync(join(tmpdir(), "orca-hq-verification-"));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, "control.sqlite"));
  openDatabases.push(database);
  const now = "2026-09-02T00:00:00.000Z";
  database.prepare(`
    INSERT INTO principals (id, payload_json, created_at, updated_at)
    VALUES ('owner', '{}', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO commands (
      id, idempotency_key, channel, external_message_id, principal_id,
      received_at, payload_json, created_at
    ) VALUES ('command-1', 'test:verification', 'slack', '171.001', 'owner', ?, '{}', ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO runs (id, command_id, state, payload_json, created_at, updated_at)
    VALUES (?, 'command-1', 'awaiting_verification', ?, ?, ?)
  `).run(input.runId, JSON.stringify({
    orcaRunId: "orca-run-verification",
    verificationObligations: [{
      rootImplementationTaskId: input.implementationTaskId,
      currentImplementationTaskId: input.implementationTaskId,
      implementationDispatchId: input.implementationDispatchId,
      cycle: 0,
      status: "verifier_running",
      verificationTaskId: `${input.implementationTaskId}:verify:0`
    }]
  }), now, now);
  database.prepare(`
    INSERT INTO tasks (id, run_id, state, payload_json, created_at, updated_at)
    VALUES (?, ?, 'worker_done', ?, ?, ?)
  `).run(
    input.implementationTaskId,
    input.runId,
    JSON.stringify({
      id: input.implementationTaskId,
      runId: input.runId,
      localId: "implement",
      title: "Implement the requested change",
      role: "implement",
      preferredAgent: input.implementationProvider,
      orcaTaskId: "orca-task-implementation",
      dependsOn: []
    }),
    now,
    now
  );
  return { store: new ControlStore(database), database };
}

function persistCompletedVerificationDispatches(
  database: Database.Database,
  task: VerificationTask,
  commands = task.testReceipts
): void {
  const now = "2026-09-02T00:00:00.000Z";
  const receiptPayload = (
    provider: "codex" | "claude",
    taskId: string,
    dispatchId: string,
    orcaTaskId: string,
    orcaDispatchId: string
  ) => {
    const promptArtifact = {
      protocol: 1,
      artifactId: `assignment:${"c".repeat(64)}`,
      path: "/var/run/orca-hq/assignments/test.json",
      version: 1,
      ownerDispatchId: dispatchId,
      content: "bounded assignment",
      sha256: "d".repeat(64)
    };
    return {
    id: dispatchId,
    taskId,
    orcaDispatchId,
    assignmentArtifact: promptArtifact,
    providerId: provider,
    providerStartReceipt: {
      kind: "provider_start",
      protocol: 1,
      provider,
      assignmentTaskId: taskId,
      assignmentDispatchId: dispatchId,
      orcaTaskId,
      orcaDispatchId,
      promptArtifact,
      boundary: {
        lifecycleAuthority: "orca_worker_start",
        promptDelivery: "prestart_atomic_assignment_artifact",
        attemptContext: "orca_injected_task_spec_and_prestart_assignment",
        credentialSource: "provider_authenticated_cli",
        postStartMail: false,
        providerChildEnvironmentIsolation: { kind: "verified_effective_allowlist" },
        assignmentArtifactAccess: { kind: "same_host" }
      },
      orcaReceipt: {
        id: `start:${orcaDispatchId}`,
        ok: true,
        result: {
          dispatchId: orcaDispatchId,
          taskId: orcaTaskId,
          runId: "orca-run-verification",
          state: "ready",
          stage: "ready",
          setup: { state: "running" },
          effects: []
        }
      }
    },
    providerInspectReceipts: [{
      kind: "provider_inspect",
      protocol: 1,
      provider,
      dispatchId: orcaDispatchId,
      workerState: "ready",
      showReceipt: {
        id: `show:${orcaDispatchId}`,
        ok: true,
        result: {
          dispatch: {
            id: orcaDispatchId,
            task_id: orcaTaskId,
            run_id: "orca-run-verification",
            status: "dispatched"
          },
          worker: {
            dispatch_id: orcaDispatchId,
            state: "ready",
            stage: "ready",
            agent_terminal_handle: `terminal:${orcaDispatchId}`
          },
          terminal: null,
          observation: { status: "ready", exactWorker: true },
          terminalResource: {
            id: `terminal:${orcaDispatchId}`,
            ownershipState: "owned",
            releaseState: "active"
          }
        }
      },
      readReceipt: {
        id: `read:${orcaDispatchId}`,
        ok: true,
        result: {
          dispatchId: orcaDispatchId,
          source: "transcript",
          cursor: "cursor:1",
          status: { worker: "ready", terminal: "running" },
          transcript: {
            messages: [],
            limited: false,
            nextCursor: "cursor:1",
            returnedMessageCount: 0
          },
          warnings: [],
          archived: false
        }
      }
    }],
    releaseReceipt: {
      id: `release:${orcaDispatchId}`,
      ok: true,
      result: { dispatchId: orcaDispatchId, state: "released", verdict: "released" }
    }
  };
  };
  database.prepare(`
    INSERT INTO dispatches (id, task_id, state, payload_json, created_at, updated_at)
    VALUES (?, ?, 'worker_done', ?, ?, ?)
  `).run(
    task.implementationDispatchId,
    task.implementationTaskId,
    JSON.stringify({
      id: task.implementationDispatchId,
      taskId: task.implementationTaskId,
      assignment: {
        role: "implement",
        preferredAgent: task.implementationProvider,
        acceptanceCommands: task.testReceipts.map(({ command }) => command),
        taskId: task.implementationTaskId,
        dispatchId: task.implementationDispatchId
      },
      ...receiptPayload(
        task.implementationProvider,
        task.implementationTaskId,
        task.implementationDispatchId,
        "orca-task-implementation",
        "orca-dispatch-implementation"
      )
    }),
    now,
    now
  );
  const verifierDispatchId = `dispatch:${task.taskId}:1`;
  database.prepare(`
    INSERT INTO dispatches (id, task_id, state, payload_json, created_at, updated_at)
    VALUES (?, ?, 'worker_done', ?, ?, ?)
  `).run(
    verifierDispatchId,
    task.taskId,
    JSON.stringify({
      id: verifierDispatchId,
      taskId: task.taskId,
      assignment: {
        role: "verify",
        preferredAgent: task.preferredAgent,
        acceptanceCommands: task.testReceipts.map(({ command }) => command),
        permissions: "read-only",
        nestedWorkers: "forbidden",
        taskId: task.taskId,
        dispatchId: verifierDispatchId
      },
      verificationCommands: commands,
      ...receiptPayload(
        task.preferredAgent,
        task.taskId,
        verifierDispatchId,
        "orca-task-verifier",
        "orca-dispatch-verifier"
      )
    }),
    now,
    now
  );
  database.prepare(`
    UPDATE tasks SET state = 'worker_done', updated_at = ? WHERE id = ?
  `).run(now, task.taskId);
  database.prepare(`
    UPDATE tasks
    SET payload_json = json_set(payload_json, '$.orcaTaskId', 'orca-task-verifier')
    WHERE id = ?
  `).run(task.taskId);
}

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("cross-model verification", () => {
  it.each([["codex", "claude"], ["claude", "codex"]] as const)(
    "pairs %s implementation with %s verifier",
    (worker, verifier) => {
      // Break caught: selecting the implementer's own family defeats independent verification.
      expect(selectVerifier(worker)).toBe(verifier);
    }
  );

  it("creates an opposite-family verifier Task with an immutable read-only boundary", () => {
    // Break caught: a verifier that can edit or launch children can alter the evidence it is judging.
    const task = createVerifierTask(input);

    expect(task).toMatchObject({
      role: "verify",
      preferredAgent: "claude",
      permissions: "read-only",
      nestedWorkers: "forbidden",
      allowedActions: ["repository_read", "acceptance_commands"]
    });
    expect(task.prohibitedEffects).toEqual(expect.arrayContaining([
      "file writes",
      "commit",
      "push",
      "pull request",
      "merge",
      "deployment",
      "secret access",
      "production access"
    ]));
    expect(Object.isFrozen(task)).toBe(true);
  });

  it("never reports success after failed verification and creates a separate Fix Task", async () => {
    // Break caught: treating a failed report as success bypasses the verification gate.
    const store = new MemoryVerificationStore();
    const service = new VerificationService({ store, completionTarget });
    const task = await service.start(input);

    await expect(service.complete(report(task, "fail"))).resolves.toEqual({
      kind: "create_fix_task",
      findings: ["Acceptance behavior is incomplete"],
      nextCycle: 1
    });

    expect(store.commits[0]?.outboxMessage).toBeUndefined();
    expect(store.tasks).toContainEqual(expect.objectContaining({
      role: "implement",
      title: expect.stringContaining("Fix"),
      preferredAgent: "codex",
      cycle: 1,
      prohibitedEffects: ["push", "deployment", "secret access"]
    }));
    expect(store.tasks[1]?.taskId).not.toBe(task.taskId);
  });

  it("requires intervention after two failed fix-and-verify cycles", async () => {
    // Break caught: an unbounded fix loop can run workers forever without user authority.
    const store = new MemoryVerificationStore();
    const service = new VerificationService({ store, completionTarget });
    const task = await service.start({ ...input, cycle: 2 });

    await expect(service.complete(report(task, "fail"))).resolves.toEqual({
      kind: "intervention_required",
      findings: ["Acceptance behavior is incomplete"]
    });
    expect(store.tasks).toHaveLength(1);
    expect(store.commits[0]?.outboxMessage).toMatchObject({
      template: "intervention_required"
    });
  });

  it("publishes verified_success only with complete opposite-family evidence", async () => {
    // Break caught: a worker_done-shaped summary without route, diff, commands, or audit evidence must not pass.
    const store = new MemoryVerificationStore();
    const service = new VerificationService({ store, completionTarget });
    const task = await service.start(input);

    await expect(service.complete(report(task, "pass"))).resolves.toEqual({
      kind: "verified_success",
      evidence: ["audit:test:1"]
    });
    expect(store.commits[0]?.outboxMessage).toMatchObject({
      template: "success",
      payload: {
        state: "verified_success",
        implementationProvider: "codex",
        verifierProvider: "claude"
      }
    });
  });

  it("atomically persists a failed report, its Fix Task, and redacted audit without success Outbox", async () => {
    // Break caught: splitting the failure transition can lose the Fix Task or leak an unverified success.
    const { store, database } = persistentStore();
    const service = new VerificationService({
      store,
      completionTarget
    });
    const task = await service.start(input);
    persistCompletedVerificationDispatches(database, task);

    await service.complete(report(task, "fail"));

    expect(store.listTasks()).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: task.taskId, state: "verification_failed" }),
      expect.objectContaining({ role: "implement", title: expect.stringContaining("Fix") })
    ]));
    expect(store.listOutbox()).not.toContainEqual(expect.objectContaining({ template: "success" }));
    const audit = JSON.stringify(store.listAuditEvents());
    expect(audit).toContain("verification.failed");
    expect(audit).not.toContain("transcript");
    expect(audit).not.toContain("terminal");
    expect(audit).not.toContain("warnings");
    expect(audit).not.toContain("rawExtensions");
    expect(audit).not.toContain("secret raw transcript");
  });

  it("rejects a self-consistent report without durable implementation and verifier Dispatch evidence", async () => {
    // Break caught: verifier Task payload supplied by the caller cannot authenticate either worker execution.
    const { store } = persistentStore();
    const service = new VerificationService({ store, completionTarget });
    const task = await service.start(input);

    await expect(service.complete(report(task, "pass")))
      .rejects.toThrow("implementation Dispatch");
    expect(store.listOutbox()).toEqual([]);
    expect(store.listAuditEvents()).toEqual([]);
  });

  it("atomically persists verified_success and its complete final report in Outbox", async () => {
    // Break caught: publishing a partial or non-durable report makes success impossible to audit later.
    const { store, database } = persistentStore();
    const service = new VerificationService({
      store,
      completionTarget
    });
    const task = await service.start(input);
    persistCompletedVerificationDispatches(database, task);

    await service.complete(report(task, "pass"));

    expect(store.listTasks()).toContainEqual(expect.objectContaining({
      taskId: task.taskId,
      state: "verified_success",
      payload: expect.objectContaining({ report: expect.objectContaining({ verdict: "pass" }) })
    }));
    expect(store.listOutbox()).toContainEqual(expect.objectContaining({
      template: "success",
      payload: expect.objectContaining({
        state: "verified_success",
        projectRoute: input.projectRoute,
        diffSummary: input.gitDiff.summary,
        commands: input.testReceipts,
        implementationProvider: "codex",
        verifierProvider: "claude",
        auditReferences: expect.arrayContaining(input.auditReferences)
      })
    }));
    expect(database.prepare("SELECT state FROM runs WHERE id = ?").get(input.runId))
      .toEqual({ state: "verified_success" });
  });

  it("does not publish Run success while another verifier is still active", async () => {
    // Break caught: the first passing report in a multi-implementation Run is not terminal success.
    const { store, database } = persistentStore();
    const service = new VerificationService({ store, completionTarget });
    const task = await service.start(input);
    persistCompletedVerificationDispatches(database, task);
    const now = "2026-09-02T00:00:00.000Z";
    database.prepare(`
      INSERT INTO tasks (id, run_id, state, payload_json, created_at, updated_at)
      VALUES ('task:other:verify:0', ?, 'running', ?, ?, ?)
    `).run(
      task.runId,
      JSON.stringify({
        taskId: "task:other:verify:0",
        runId: task.runId,
        title: "Verify another implementation",
        role: "verify",
        preferredAgent: "codex",
        cycle: 0
      }),
      now,
      now
    );

    await service.complete(report(task, "pass"));

    expect(database.prepare("SELECT state FROM runs WHERE id = ?").get(task.runId))
      .toEqual({ state: "awaiting_verification" });
    expect(store.listOutbox()).not.toContainEqual(expect.objectContaining({ template: "success" }));
  });

  it("rolls back every verification side effect when its audit cannot be written", async () => {
    // Break caught: a visible state transition without its audit destroys completion traceability.
    const { store, database } = persistentStore();
    const service = new VerificationService({
      store,
      completionTarget
    });
    const task = await service.start(input);
    persistCompletedVerificationDispatches(database, task);
    database.exec(`
      CREATE TRIGGER force_verification_audit_failure
      BEFORE INSERT ON audit_events
      WHEN NEW.event_type = 'verification.failed'
      BEGIN
        SELECT RAISE(ABORT, 'forced verification audit failure');
      END
    `);

    await expect(service.complete(report(task, "fail")))
      .rejects.toThrow("forced verification audit failure");

    expect(store.listTasks()).toContainEqual(
      expect.objectContaining({ taskId: task.taskId, state: "worker_done" })
    );
    expect(store.listTasks()).not.toContainEqual(
      expect.objectContaining({ role: "implement", title: expect.stringContaining("Fix") })
    );
    expect(store.listOutbox()).toEqual([]);
    expect(store.listAuditEvents()).toEqual([]);
    expect(database.prepare("SELECT state FROM runs WHERE id = ?").get(input.runId))
      .toEqual({ state: "awaiting_verification" });
  });

  it("makes an identical durable completion replay a no-op", async () => {
    // Break caught: transport redelivery after process restart must not duplicate terminal side effects.
    const capture = new MemoryVerificationStore();
    const captureService = new VerificationService({ store: capture, completionTarget });
    const capturedTask = await captureService.start(input);
    await captureService.complete(report(capturedTask, "pass"));
    const commit = capture.commits[0];
    if (commit === undefined) throw new Error("verification commit was not captured");

    const { store, database } = persistentStore();
    store.saveVerificationTask(capturedTask);
    persistCompletedVerificationDispatches(database, capturedTask);
    store.commitVerification(commit);

    expect(() => store.saveVerificationTask(structuredClone(capturedTask))).not.toThrow();
    expect(() => store.commitVerification(structuredClone(commit))).not.toThrow();
    expect(store.listAuditEvents()).toHaveLength(1);
    expect(store.listOutbox()).toHaveLength(1);
  });

  it.each([
    {
      name: "verifier Task is not worker_done",
      mutate: (database: Database.Database, task: VerificationTask) => database.prepare(`
        UPDATE tasks SET state = 'running' WHERE id = ?
      `).run(task.taskId),
      error: "Verification Task"
    },
    {
      name: "implementation provider receipt belongs to another family",
      mutate: (database: Database.Database, task: VerificationTask) => database.prepare(`
        UPDATE dispatches
        SET payload_json = json_set(payload_json, '$.providerId', 'claude')
        WHERE id = ?
      `).run(task.implementationDispatchId),
      error: "implementation Dispatch provider evidence"
    },
    {
      name: "provider start receipt belongs to another local Dispatch",
      mutate: (database: Database.Database, task: VerificationTask) => database.prepare(`
        UPDATE dispatches
        SET payload_json = json_set(
          payload_json,
          '$.providerStartReceipt.assignmentDispatchId',
          'dispatch:other-task:1'
        )
        WHERE id = ?
      `).run(task.implementationDispatchId),
      error: "implementation Dispatch provider evidence"
    },
    {
      name: "terminal provider receipt is not successful",
      mutate: (database: Database.Database, task: VerificationTask) => database.prepare(`
        UPDATE dispatches
        SET payload_json = json_set(payload_json, '$.releaseReceipt.ok', false)
        WHERE id = ?
      `).run(task.implementationDispatchId),
      error: "implementation Dispatch provider evidence"
    },
    {
      name: "prompt artifact belongs to another local Dispatch",
      mutate: (database: Database.Database, task: VerificationTask) => database.prepare(`
        UPDATE dispatches
        SET payload_json = json_set(
          payload_json,
          '$.providerStartReceipt.promptArtifact.ownerDispatchId',
          'dispatch:other-task:1'
        )
        WHERE id = ?
      `).run(task.implementationDispatchId),
      error: "implementation Dispatch provider evidence"
    },
    {
      name: "persisted Orca Dispatch differs from its provider start receipt",
      mutate: (database: Database.Database, task: VerificationTask) => database.prepare(`
        UPDATE dispatches
        SET payload_json = json_set(payload_json, '$.orcaDispatchId', 'orca-dispatch:other')
        WHERE id = ?
      `).run(task.implementationDispatchId),
      error: "implementation Dispatch provider evidence"
    },
    {
      name: "provider inspection belongs to another Orca Task",
      mutate: (database: Database.Database, task: VerificationTask) => database.prepare(`
        UPDATE dispatches
        SET payload_json = json_set(
          payload_json,
          '$.providerInspectReceipts[0].showReceipt.result.dispatch.task_id',
          'orca-task:other'
        )
        WHERE id = ?
      `).run(task.implementationDispatchId),
      error: "implementation Dispatch provider evidence"
    },
    {
      name: "release receipt reports stop semantics",
      mutate: (database: Database.Database, task: VerificationTask) => database.prepare(`
        UPDATE dispatches
        SET payload_json = json_set(payload_json, '$.releaseReceipt.result.verdict', 'stopped')
        WHERE id = ?
      `).run(task.implementationDispatchId),
      error: "implementation Dispatch provider evidence"
    },
    {
      name: "verifier acceptance evidence was substituted",
      mutate: (database: Database.Database, task: VerificationTask) => database.prepare(`
        UPDATE dispatches
        SET payload_json = json_set(
          payload_json,
          '$.verificationCommands[0].summary',
          'substituted result'
        )
        WHERE task_id = ?
      `).run(task.taskId),
      error: "durable verifier Dispatch evidence"
    },
    {
      name: "verifier provider inspection is missing",
      mutate: (database: Database.Database, task: VerificationTask) => database.prepare(`
        UPDATE dispatches
        SET payload_json = json_remove(payload_json, '$.providerInspectReceipts')
        WHERE task_id = ?
      `).run(task.taskId),
      error: "durable verifier Dispatch evidence"
    },
    {
      name: "persisted Git diff digest differs",
      mutate: (database: Database.Database, task: VerificationTask) => database.prepare(`
        UPDATE tasks
        SET payload_json = json_set(payload_json, '$.gitDiff.sha256', ?)
        WHERE id = ?
      `).run("b".repeat(64), task.taskId),
      error: "does not own the persisted Task"
    }
  ])("rejects completion when $name", async ({ mutate, error }) => {
    // Break caught: every completion claim must bind to one exact durable execution chain.
    const { store, database } = persistentStore();
    const service = new VerificationService({ store, completionTarget });
    const task = await service.start(input);
    persistCompletedVerificationDispatches(database, task);
    mutate(database, task);

    await expect(service.complete(report(task, "pass"))).rejects.toThrow(error);
    expect(store.listAuditEvents()).toEqual([]);
    expect(store.listOutbox()).toEqual([]);
    expect(database.prepare("SELECT state FROM runs WHERE id = ?").get(task.runId))
      .toEqual({ state: "awaiting_verification" });
  });

  it("rejects a caller decision that disagrees with the recomputed cycle gate", async () => {
    // Break caught: a cycle-2 failure must not be caller-shaped into another Fix Task.
    const capture = new MemoryVerificationStore();
    const service = new VerificationService({ store: capture, completionTarget });
    const task = await service.start({ ...input, cycle: 2 });
    await service.complete(report(task, "fail"));
    const valid = capture.commits[0];
    if (valid === undefined) throw new Error("verification commit was not captured");
    const { outboxMessage: _outboxMessage, ...withoutOutbox } = valid;
    const wrong: VerificationCommit = {
      ...withoutOutbox,
      decision: {
        kind: "create_fix_task",
        findings: valid.report.findings,
        nextCycle: 2
      },
      audit: {
        ...valid.audit,
        eventType: "verification.failed"
      },
      fixTask: {
        taskId: `${task.implementationTaskId}:fix:2`,
        runId: task.runId,
        sourceVerificationTaskId: task.taskId,
        implementationTaskId: task.implementationTaskId,
        title: `Fix ${task.implementationTaskId} after verification`,
        role: "implement",
        preferredAgent: task.implementationProvider,
        dependsOn: [task.taskId],
        cycle: 2,
        findings: valid.report.findings,
        requestedScope: task.requestedScope,
        prohibitedEffects: task.implementationProhibitedEffects,
        permissions: "read-write",
        nestedWorkers: "forbidden"
      }
    };
    const { store } = persistentStore();

    expect(() => store.commitVerification(wrong)).toThrow("recomputed completion gate");
    expect(store.listAuditEvents()).toEqual([]);
    expect(store.listOutbox()).toEqual([]);
  });

  it("rejects same-family reports, raw transcript extensions, and substituted acceptance commands", async () => {
    // Break caught: accepting self-verification or raw provider output corrupts the audit boundary.
    const task = createVerifierTask(input);
    const valid = report(task, "pass");

    expect(() => VerificationReportSchema.parse({
      ...valid,
      verifierProvider: "codex"
    })).toThrow();
    expect(() => VerificationReportSchema.parse({
      ...valid,
      transcript: "secret raw transcript"
    })).toThrow();
    expect(() => VerificationReportSchema.parse({
      ...valid,
      commands: [{ ...valid.commands[0], exitCode: 1 }]
    })).toThrow();

    const store = new MemoryVerificationStore();
    const service = new VerificationService({ store, completionTarget });
    const started = await service.start(input);
    await expect(service.complete(report(started, "pass", {
      commands: [{
        command: "echo substituted",
        exitCode: 0,
        outcome: "passed",
        auditReference: "audit:substituted"
      }],
      evidence: ["audit:substituted"]
    }))).rejects.toThrow("immutable Task");
  });

  it("makes identical start and completion delivery idempotent but rejects conflicts", async () => {
    // Break caught: transport redelivery must not create duplicate verifier Tasks or terminal side effects.
    const store = new MemoryVerificationStore();
    const service = new VerificationService({ store, completionTarget });
    const first = await service.start(input);

    await expect(service.start(structuredClone(input))).resolves.toEqual(first);
    expect(store.tasks).toHaveLength(1);

    const passing = report(first, "pass");
    await expect(service.complete(passing)).resolves.toEqual({
      kind: "verified_success",
      evidence: ["audit:test:1"]
    });
    await expect(service.complete(structuredClone(passing))).resolves.toEqual({
      kind: "verified_success",
      evidence: ["audit:test:1"]
    });
    expect(store.commits).toHaveLength(1);

    await expect(service.complete({
      ...passing,
      reportId: "report:conflicting-replay"
    })).rejects.toThrow("conflicting verification completion replay");
  });

  it("requires a durable completion target and rejects free-form command output", () => {
    // Break caught: an optional delivery route or raw command output makes durable completion inconsistent and leaky.
    expect(() => new VerificationService({ store: new MemoryVerificationStore() } as never))
      .toThrow("completion target");
    const task = createVerifierTask(input);
    const valid = report(task, "pass");
    expect(() => VerificationReportSchema.parse({
      ...valid,
      commands: [{ ...valid.commands[0], stdout: "x".repeat(513) }]
    })).toThrow();
  });

  it("rejects every free-form command output field before audit or Outbox serialization", async () => {
    // Break caught: a short summary can still carry channel tokens, voice keys, or terminal output.
    const { store, database } = persistentStore();
    const service = new VerificationService({ store, completionTarget });
    const task = await service.start(input);
    persistCompletedVerificationDispatches(database, task);
    const valid = report(task, "pass");
    const leaked = "Slack=xoxb-secret Telegram=123:secret Tailscale=tskey OpenAI=sk-secret";
    await expect(service.complete({
      ...valid,
      commands: [{
        ...valid.commands[0],
        summary: leaked
      }]
    } as never)).rejects.toThrow();
    const serialized = JSON.stringify({
      audit: store.listAuditEvents(),
      outbox: store.listOutbox(),
      reports: database.prepare(`
        SELECT payload_json FROM tasks WHERE id = ?
      `).all(task.taskId)
    });
    for (const value of ["xoxb-secret", "123:secret", "tskey", "sk-secret"]) {
      expect(serialized).not.toContain(value);
    }
  });
});

describe("completionDecision", () => {
  it("uses the report verdict and bounded cycle exactly", () => {
    // Break caught: an off-by-one either escalates too early or permits a third failed fix cycle.
    const task = createVerifierTask(input);
    expect(completionDecision(report(task, "pass"), 0)).toEqual({
      kind: "verified_success",
      evidence: ["audit:test:1"]
    });
    expect(completionDecision(report(task, "fail"), 1)).toEqual({
      kind: "create_fix_task",
      findings: ["Acceptance behavior is incomplete"],
      nextCycle: 2
    });
    expect(completionDecision(report(task, "fail"), 2)).toEqual({
      kind: "intervention_required",
      findings: ["Acceptance behavior is incomplete"]
    });
  });
});
