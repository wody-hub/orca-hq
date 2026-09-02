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
    result: "28 tests passed",
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
    VALUES (?, 'command-1', 'awaiting_verification', '{}', ?, ?)
  `).run(input.runId, now, now);
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
      dependsOn: []
    }),
    now,
    now
  );
  return { store: new ControlStore(database), database };
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
    const service = new VerificationService({ store });
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
    const service = new VerificationService({ store });
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
    const service = new VerificationService({ store });
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
    const { store } = persistentStore();
    const service = new VerificationService({
      store,
      completionTarget: {
        commandId: "command-1",
        channel: "slack",
        destination: "C123",
        nextAttemptAt: "2026-09-02T00:00:00.000Z"
      }
    });
    const task = await service.start(input);

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

  it("atomically persists verified_success and its complete final report in Outbox", async () => {
    // Break caught: publishing a partial or non-durable report makes success impossible to audit later.
    const { store, database } = persistentStore();
    const service = new VerificationService({
      store,
      completionTarget: {
        commandId: "command-1",
        channel: "slack",
        destination: "C123",
        nextAttemptAt: "2026-09-02T00:00:00.000Z"
      }
    });
    const task = await service.start(input);

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

  it("rolls back every verification side effect when its audit cannot be written", async () => {
    // Break caught: a visible state transition without its audit destroys completion traceability.
    const { store, database } = persistentStore();
    const service = new VerificationService({
      store,
      completionTarget: {
        commandId: "command-1",
        channel: "slack",
        destination: "C123",
        nextAttemptAt: "2026-09-02T00:00:00.000Z"
      }
    });
    const task = await service.start(input);
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
      expect.objectContaining({ taskId: task.taskId, state: "planned" })
    );
    expect(store.listTasks()).not.toContainEqual(
      expect.objectContaining({ role: "implement", title: expect.stringContaining("Fix") })
    );
    expect(store.listOutbox()).toEqual([]);
    expect(store.listAuditEvents()).toEqual([]);
    expect(database.prepare("SELECT state FROM runs WHERE id = ?").get(input.runId))
      .toEqual({ state: "awaiting_verification" });
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
    const service = new VerificationService({ store });
    const started = await service.start(input);
    await expect(service.complete(report(started, "pass", {
      commands: [{
        command: "echo substituted",
        exitCode: 0,
        result: "substituted command passed",
        auditReference: "audit:substituted"
      }],
      evidence: ["audit:substituted"]
    }))).rejects.toThrow("immutable Task");
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
