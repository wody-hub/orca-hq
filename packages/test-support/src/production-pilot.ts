import { join } from "node:path";

import {
  createProductionGateway,
  type GatewayProductionDependencies
} from "@orca-hq/gateway/production";
import type { CommandEnvelope, ExecutionProposal } from "@orca-hq/core";
import {
  routeProject,
  type ProjectRegistryEntry
} from "@orca-hq/project-registry";
import {
  GitWorktreePlacementService,
  type DispatchRecord,
  type VerificationReport,
  type VerificationTask
} from "@orca-hq/worker-routing";

import { LaunchOrca, MemoryAssignmentArtifacts } from "./fake-agents.js";
import type { SandboxRepo } from "./sandbox-repo.js";

const verifierEffects = Object.freeze({
  filesModified: false,
  committed: false,
  pushed: false,
  pullRequestChanged: false,
  merged: false,
  deployed: false,
  secretsAccessed: false,
  productionAccessed: false
});

function pilotProject(repositoryPath: string): ProjectRegistryEntry {
  return {
    projectKey: "sandbox-web",
    orcaProjectId: "orca-sandbox-web",
    repoId: "repo-sandbox-web",
    absolutePath: repositoryPath,
    aliases: ["샌드박스 프런트엔드", "sandbox web"],
    component: "frontend",
    defaultBaseRef: "main",
    instructionsFiles: [],
    setupPolicy: "run",
    allowedOperations: ["L0", "L1", "L2", "L3"],
    requiredChecks: ["pnpm test"],
    sensitivePaths: [".env"],
    lockKey: "sandbox-web"
  };
}

function proposalFor(
  command: CommandEnvelope,
  project: ProjectRegistryEntry,
  proposalId: string
): ExecutionProposal {
  const route = routeProject({ text: command.text }, [project]);
  if (route.kind !== "selected") throw new Error("production_pilot_route_not_selected");
  return {
    proposalId,
    commandId: command.commandId,
    selectedProjectKey: route.projectKey,
    routeCandidates: [{
      projectKey: route.projectKey,
      score: route.score,
      evidence: [...route.evidence]
    }],
    baseRef: "main",
    allowedScope: ["src/**"],
    prohibitedEffects: ["push", "deployment", "secret access"],
    acceptanceCommands: ["pnpm test"],
    riskLevel: "L1",
    tasks: [{
      localId: "implement",
      title: "샌드박스 테스트 수정",
      dependsOn: [],
      role: "implement",
      preferredAgent: "codex"
    }]
  };
}

function verificationReport(task: VerificationTask, reportId: string): VerificationReport {
  const command = {
    command: "pnpm test",
    exitCode: 0,
    outcome: "passed" as const,
    auditReference: `audit:${reportId}:test`
  };
  return {
    reportId,
    runId: task.runId,
    verificationTaskId: task.taskId,
    implementationTaskId: task.implementationTaskId,
    implementationDispatchId: task.implementationDispatchId,
    cycle: task.cycle,
    verdict: "pass",
    projectRoute: task.projectRoute,
    changedFiles: task.changedFiles,
    diffSha256: task.gitDiff.sha256,
    diffSummary: task.gitDiff.summary,
    commands: [command],
    implementationProvider: task.implementationProvider,
    verifierProvider: task.preferredAgent,
    findings: [],
    evidence: [command.auditReference, `audit:${reportId}:verifier`],
    auditReferences: [...task.auditReferences, `audit:${reportId}:verifier`],
    verifierEffects
  };
}

export async function runProductionPilotFlow(input: Readonly<{
  sandbox: SandboxRepo;
  command: CommandEnvelope;
  runIdentity: string;
  now: Date;
}>) {
  const project = pilotProject(input.sandbox.repositoryPath);
  const proposalId = `proposal-${input.runIdentity}`;
  const reportId = `report-${input.runIdentity}`;
  const orca = new LaunchOrca();
  const deliveries: string[] = [];
  const ingress = { async start() {}, async stopIngress() {} };
  const now = () => new Date(input.now);
  const dependencies: GatewayProductionDependencies = {
    config: { async validate() {} },
    orca,
    execution: {
      placements: new GitWorktreePlacementService(input.sandbox.git),
      assignmentArtifacts: new MemoryAssignmentArtifacts(),
      providerCapabilities: {
        codex: { worker: "available", hq: "available" },
        claude: { worker: "available", hq: "unavailable" },
        providerChildEnvironmentIsolation: {
          kind: "verified_effective_allowlist",
          effectiveEnvironmentKeys: ["HOME", "PATH"]
        },
        assignmentArtifactAccess: { kind: "same_host" }
      },
      verificationEvidence: {
        collectImplementation() {
          return {
            changedFiles: ["src/pilot.ts"],
            gitDiff: { sha256: "b".repeat(64), summary: "1 file changed" },
            testReceipts: [{
              command: "pnpm test",
              exitCode: 0,
              outcome: "passed" as const,
              auditReference: `audit:${input.runIdentity}:implementation:test`
            }],
            auditReferences: [`audit:${input.runIdentity}:implementation:dispatch`]
          };
        },
        collectVerifierCommands() {
          return [{
            command: "pnpm test",
            exitCode: 0,
            outcome: "passed" as const,
            auditReference: `audit:${reportId}:test`
          }];
        },
        captureRepositorySnapshot({ dispatch, phase }) {
          const durable = dispatch as DispatchRecord;
          return {
            repositoryPath: durable.assignment.repo.repositoryPath,
            worktreePath: durable.assignment.worktree.path,
            worktreeKind: durable.assignment.worktree.kind,
            head: durable.assignment.worktree.head,
            branch: durable.assignment.worktree.branch,
            statusSha256: "c".repeat(64),
            diffSha256: "b".repeat(64),
            auditReference: `audit:${input.runIdentity}:repository:${phase}`
          };
        }
      }
    },
    proposalModel: {
      async plan(command) {
        return { kind: "proposal", proposal: proposalFor(command, project, proposalId) };
      }
    },
    projects: [project],
    channelRecovery: { async resumeCursors() {} },
    http: ingress,
    slack: ingress,
    telegram: ingress,
    transactions: { async drain() {} },
    outbox: {
      workerId: `${input.runIdentity}:outbox-worker`,
      providers: {
        telegram: {
          async deliver(message) {
            deliveries.push((message.payload as { text: string }).text);
            return { providerMessageId: `${input.runIdentity}:provider-message` };
          }
        }
      }
    },
    dispatchControl: { async stop() { return false; }, async retry() { return false; } },
    now,
    completionDestinations: {
      slack: "C-PILOT",
      tailscaleWeb: "/commands/completed"
    }
  };
  const composition = await createProductionGateway({
    databasePath: join(input.sandbox.rootPath, `${input.runIdentity}.sqlite`),
    shutdownDrainMs: 1_000,
    outboxPollMs: 60_000,
    outboxMaxBackoffMs: 60_000
  }, dependencies);
  try {
    await composition.gateway.start();
    composition.services.store.insertCommand(input.command);
    const accepted = await composition.gateway.acceptCommand({
      commandId: input.command.commandId,
      channel: input.command.channel,
      text: input.command.text
    });
    if (accepted.state !== "active") throw new Error("production_pilot_not_active");

    const implementation = composition.services.store.listTasks()
      .find(({ role }) => role === "implement");
    const implementationDispatch = implementation === undefined
      ? undefined
      : composition.services.store.loadDispatchesForTask(implementation.id)[0] as DispatchRecord | undefined;
    if (implementation === undefined || implementationDispatch?.orcaDispatchId === undefined) {
      throw new Error("production_pilot_implementation_missing");
    }
    await composition.services.execution.recordWorkerMessage({
      kind: "worker_done",
      messageId: `${input.runIdentity}:implementation-done`,
      dispatchId: implementationDispatch.orcaDispatchId,
      outcome: "completed",
      summary: "synthetic implementation complete"
    });

    const verifier = composition.services.store.listTasks().find(({ role }) => role === "verify");
    const verificationTask = verifier?.payload as VerificationTask | undefined;
    const verifierDispatch = verifier === undefined
      ? undefined
      : composition.services.store.loadDispatchesForTask(verifier.id)[0] as DispatchRecord | undefined;
    if (verifier === undefined || verificationTask === undefined || verifierDispatch?.orcaDispatchId === undefined) {
      throw new Error("production_pilot_verifier_missing");
    }
    await composition.services.execution.recordWorkerMessage({
      kind: "worker_done",
      messageId: `${input.runIdentity}:verifier-done`,
      dispatchId: verifierDispatch.orcaDispatchId,
      outcome: "completed",
      summary: "synthetic verification complete"
    });
    const decision = await composition.services.execution.recordVerificationReport(
      verificationReport(verificationTask, reportId)
    );
    await composition.services.outbox.tick(now().toISOString());

    const tasks = composition.services.store.listTasks();
    const taskIds = new Set(tasks.map(({ id }) => id));
    const dispatches = tasks.flatMap((task) =>
      composition.services.store.loadDispatchesForTask(task.id) as unknown as DispatchRecord[]
    );
    const dispatchIds = new Set(dispatches.map(({ id }) => id));
    const orcaDispatchIds = new Set(dispatches.flatMap(({ orcaDispatchId }) =>
      orcaDispatchId === undefined ? [] : [orcaDispatchId]
    ));
    const audit = composition.services.store.listAuditEvents();
    const linkedParts = new Set<string>();
    if (audit.some((event) => event.subjectId === input.command.commandId
      && event.eventType === "command.route_selected")) linkedParts.add("route");
    if (audit.some((event) => event.subjectId === input.command.commandId
      && event.eventType === "command.policy_authorized")) {
      linkedParts.add("policy");
      linkedParts.add("approval");
    }
    if (audit.some((event) => event.eventType === "lifecycle.transition"
      && dispatchIds.has(event.subjectId))) linkedParts.add("Dispatch");
    if (audit.some((event) => event.eventType === "worker.worker_done"
      && orcaDispatchIds.has(event.subjectId))) linkedParts.add("worker");
    if (audit.some((event) => event.eventType === "verification.passed"
      && taskIds.has(event.subjectId))) linkedParts.add("verifier");
    if (audit.some((event) => event.subjectId === input.command.commandId
      && event.eventType === "outbox.delivered")) linkedParts.add("delivery");

    return Object.freeze({
      decision,
      linkedParts: Object.freeze([...linkedParts]),
      implementationProvider: implementation.preferredAgent,
      verifierProvider: verifier.preferredAgent,
      worktreeKind: implementationDispatch.assignment.worktree.kind,
      evidence: Object.freeze(verificationReport(verificationTask, reportId).evidence),
      proposal: composition.services.store.findExecutionProposal(proposalId),
      runState: (composition.services.store.loadRunRecord(verificationTask.runId) as { state: string }).state,
      outboxState: composition.services.store.getOutbox(`${reportId}:success`)?.state,
      deliveries: Object.freeze([...deliveries]),
      audit: Object.freeze(structuredClone(audit))
    });
  } finally {
    await composition.gateway.stop();
  }
}
