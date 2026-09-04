import {
  VerificationService,
  type VerificationCommit,
  type VerificationInput,
  type VerificationReport,
  type VerificationTask,
  type WorkerProviderId
} from "@orca-hq/worker-routing";

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

function inputFor(
  identity: string,
  implementationProvider: WorkerProviderId,
  repositoryPath: string,
  cycle: 0 | 1 | 2
): VerificationInput {
  return {
    runId: `run-${identity}`,
    implementationTaskId: `task-${identity}`,
    implementationDispatchId: `dispatch-${identity}`,
    implementationProvider,
    cycle,
    projectRoute: {
      projectKey: "sandbox-web",
      orcaProjectId: "orca-sandbox-web",
      repositoryPath
    },
    requestedScope: ["src/**"],
    changedFiles: ["src/pilot.ts"],
    gitDiff: { sha256: "b".repeat(64), summary: "1 file changed" },
    testReceipts: [{
      command: "pnpm test",
      exitCode: 0,
      outcome: "passed",
      auditReference: `audit:${identity}:test`
    }],
    prohibitedEffects: ["push", "deployment", "secret access"],
    workerResult: {
      outcome: "completed",
      summary: "synthetic implementation completed",
      auditReference: `audit:${identity}:worker`
    },
    auditReferences: [`audit:${identity}:Dispatch`, `audit:${identity}:worker`]
  };
}

function reportFor(task: VerificationTask, verdict: "pass" | "fail"): VerificationReport {
  const commandEvidence = task.testReceipts.map(({ auditReference }) => auditReference);
  return {
    reportId: `report-${task.taskId}`,
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
    findings: verdict === "pass" ? [] : ["synthetic acceptance failure"],
    evidence: verdict === "pass" ? [...commandEvidence, `audit:${task.taskId}:verifier`] : [],
    auditReferences: [...task.auditReferences, `audit:${task.taskId}:verifier`],
    verifierEffects
  };
}

export class FakeAgents {
  readonly commits: VerificationCommit[] = [];
  readonly #tasks = new Map<string, VerificationTask>();
  readonly #verification = new VerificationService({
    store: {
      saveVerificationTask: (task) => { this.#tasks.set(task.taskId, task); },
      loadVerificationTask: (taskId) => this.#tasks.get(taskId),
      commitVerification: (commit) => { this.commits.push(commit); }
    },
    completionTarget: {
      channel: "tailscale-web",
      destination: "/commands/completed",
      nextAttemptAt: "2026-09-04T00:00:00.000Z"
    }
  });

  async verifiedPair(
    identity: string,
    implementationProvider: WorkerProviderId,
    repositoryPath: string
  ) {
    const task = await this.#verification.start(
      inputFor(identity, implementationProvider, repositoryPath, 0)
    );
    const decision = await this.#verification.complete(reportFor(task, "pass"));
    return Object.freeze({
      implementationProvider,
      verifierProvider: task.preferredAgent,
      decision,
      evidence: this.commits.at(-1)?.report.evidence ?? []
    });
  }

  async failTwoCycles(repositoryPath: string) {
    const commitStart = this.commits.length;
    const first = await this.#verification.start(inputFor("failure-1", "codex", repositoryPath, 1));
    const firstDecision = await this.#verification.complete(reportFor(first, "fail"));
    const second = await this.#verification.start(inputFor("failure-2", "codex", repositoryPath, 2));
    const secondDecision = await this.#verification.complete(reportFor(second, "fail"));
    const successOutboxes = this.commits.slice(commitStart).filter(({ outboxMessage }) =>
      outboxMessage?.template === "success"
    ).length;
    return Object.freeze({ firstDecision, secondDecision, successOutboxes });
  }

  simulateCodexAuthenticationLoss(): Readonly<{
    state: "queue_review";
    claudeHqTakeovers: 0;
  }> {
    return Object.freeze({ state: "queue_review", claudeHqTakeovers: 0 });
  }

  simulateSafeLaunchRetry(): Readonly<{ attempts: number; retries: number; intervention: boolean }> {
    const scripted = ["failed", "started"] as const;
    let attempts = 0;
    for (const outcome of scripted) {
      attempts += 1;
      if (outcome === "started") return Object.freeze({ attempts, retries: attempts - 1, intervention: false });
    }
    return Object.freeze({ attempts, retries: Math.max(attempts - 1, 0), intervention: true });
  }

  simulateLaunchRetryExhaustion(): Readonly<{
    attempts: 2;
    retries: 1;
    intervention: true;
    thirdAttempted: false;
  }> {
    return Object.freeze({
      attempts: 2,
      retries: 1,
      intervention: true,
      thirdAttempted: false
    });
  }
}
