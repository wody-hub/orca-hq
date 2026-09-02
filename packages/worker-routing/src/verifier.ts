import { isAbsolute } from "node:path";

import { z } from "zod";

import { type CompletionDecision, completionDecision } from "./completion-gate.js";
import { WorkerProviderIdSchema, type WorkerProviderId } from "./providers.js";

const NonBlankStringSchema = z.string().trim().min(1);
const StringListSchema = z.array(NonBlankStringSchema);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const CycleSchema = z.number().int().min(0).max(2);

const ProjectRouteSchema = z.object({
  projectKey: NonBlankStringSchema,
  orcaProjectId: NonBlankStringSchema,
  repositoryPath: NonBlankStringSchema.refine(isAbsolute, "must be an absolute path")
}).strict();

const GitDiffEvidenceSchema = z.object({
  sha256: Sha256Schema,
  summary: NonBlankStringSchema
}).strict();

export const VerificationCommandReceiptSchema = z.object({
  command: NonBlankStringSchema,
  exitCode: z.number().int(),
  result: NonBlankStringSchema,
  auditReference: NonBlankStringSchema
}).strict();

const WorkerResultSchema = z.object({
  outcome: z.enum(["completed", "failed"]),
  summary: NonBlankStringSchema,
  auditReference: NonBlankStringSchema
}).strict();

const VerifierEffectsSchema = z.object({
  filesModified: z.literal(false),
  committed: z.literal(false),
  pushed: z.literal(false),
  pullRequestChanged: z.literal(false),
  merged: z.literal(false),
  deployed: z.literal(false),
  secretsAccessed: z.literal(false),
  productionAccessed: z.literal(false)
}).strict();

export const VerificationInputSchema = z.object({
  runId: NonBlankStringSchema,
  implementationTaskId: NonBlankStringSchema,
  implementationDispatchId: NonBlankStringSchema,
  implementationProvider: WorkerProviderIdSchema,
  cycle: CycleSchema,
  projectRoute: ProjectRouteSchema,
  requestedScope: StringListSchema,
  changedFiles: StringListSchema,
  gitDiff: GitDiffEvidenceSchema,
  testReceipts: z.array(VerificationCommandReceiptSchema).min(1),
  prohibitedEffects: StringListSchema,
  workerResult: WorkerResultSchema,
  auditReferences: StringListSchema.min(1)
}).strict();

export const VerificationTaskSchema = VerificationInputSchema.extend({
  taskId: NonBlankStringSchema,
  title: NonBlankStringSchema,
  role: z.literal("verify"),
  preferredAgent: WorkerProviderIdSchema,
  dependsOn: z.array(NonBlankStringSchema).length(1),
  permissions: z.literal("read-only"),
  nestedWorkers: z.literal("forbidden"),
  implementationProhibitedEffects: StringListSchema,
  allowedActions: z.tuple([
    z.literal("repository_read"),
    z.literal("acceptance_commands")
  ])
}).strict().superRefine((task, context) => {
  if (task.preferredAgent === task.implementationProvider) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["preferredAgent"],
      message: "verification must use the opposite model family"
    });
  }
});

export type VerificationInput = Readonly<z.infer<typeof VerificationInputSchema>>;
export type VerificationTask = Readonly<z.infer<typeof VerificationTaskSchema>>;
export type VerificationCommandReceipt = Readonly<
  z.infer<typeof VerificationCommandReceiptSchema>
>;

export const VerificationReportSchema = z.object({
  reportId: NonBlankStringSchema,
  runId: NonBlankStringSchema,
  verificationTaskId: NonBlankStringSchema,
  implementationTaskId: NonBlankStringSchema,
  implementationDispatchId: NonBlankStringSchema,
  cycle: CycleSchema,
  verdict: z.enum(["pass", "fail"]),
  projectRoute: ProjectRouteSchema,
  changedFiles: StringListSchema,
  diffSummary: NonBlankStringSchema,
  commands: z.array(VerificationCommandReceiptSchema).min(1),
  implementationProvider: WorkerProviderIdSchema,
  verifierProvider: WorkerProviderIdSchema,
  findings: StringListSchema,
  evidence: StringListSchema,
  auditReferences: StringListSchema.min(1),
  verifierEffects: VerifierEffectsSchema
}).strict().superRefine((report, context) => {
  if (report.implementationProvider === report.verifierProvider) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["verifierProvider"],
      message: "verification must use the opposite model family"
    });
  }
  if (report.verdict === "pass" && report.evidence.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence"],
      message: "passing verification requires evidence"
    });
  }
  if (
    report.verdict === "pass"
    && report.commands.some(({ exitCode }) => exitCode !== 0)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["commands"],
      message: "passing verification requires every acceptance command to pass"
    });
  }
  if (
    report.verdict === "pass"
    && report.commands.some(({ auditReference }) => !report.evidence.includes(auditReference))
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence"],
      message: "passing verification evidence must reference every acceptance command"
    });
  }
  if (report.verdict === "fail" && report.findings.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["findings"],
      message: "failed verification requires findings"
    });
  }
});

export type VerificationReport = Readonly<z.infer<typeof VerificationReportSchema>>;

export const FixTaskSchema = z.object({
  taskId: NonBlankStringSchema,
  runId: NonBlankStringSchema,
  sourceVerificationTaskId: NonBlankStringSchema,
  implementationTaskId: NonBlankStringSchema,
  title: NonBlankStringSchema,
  role: z.literal("implement"),
  preferredAgent: WorkerProviderIdSchema,
  dependsOn: z.array(NonBlankStringSchema).length(1),
  cycle: z.number().int().min(1).max(2),
  findings: StringListSchema.min(1),
  requestedScope: StringListSchema,
  prohibitedEffects: StringListSchema,
  permissions: z.literal("read-write"),
  nestedWorkers: z.literal("forbidden")
}).strict();

export type FixTask = Readonly<z.infer<typeof FixTaskSchema>>;

export type VerificationOutboxMessage = Readonly<{
  id: string;
  template: "success" | "intervention_required";
  payload: Readonly<Record<string, unknown>>;
  commandId?: string | undefined;
  channel?: "slack" | "telegram" | "tailscale-web" | undefined;
  destination?: string | undefined;
  nextAttemptAt?: string | undefined;
}>;

export type VerificationCompletionTarget = Readonly<{
  commandId?: string | undefined;
  channel: "slack" | "telegram" | "tailscale-web";
  destination: string;
  nextAttemptAt: string;
}>;

export type VerificationAudit = Readonly<{
  subjectId: string;
  eventType: "verification.passed" | "verification.failed" | "verification.intervention_required";
  data: Readonly<{
    reportId: string;
    runId: string;
    verificationTaskId: string;
    implementationTaskId: string;
    implementationDispatchId: string;
    cycle: number;
    verdict: "pass" | "fail";
    projectKey: string;
    implementationProvider: WorkerProviderId;
    verifierProvider: WorkerProviderId;
    commandAuditReferences: readonly string[];
    auditReferences: readonly string[];
    evidenceReferences: readonly string[];
    findingCount: number;
  }>;
}>;

export type VerificationCommit = Readonly<{
  report: VerificationReport;
  decision: CompletionDecision;
  audit: VerificationAudit;
  fixTask?: FixTask | undefined;
  outboxMessage?: VerificationOutboxMessage | undefined;
}>;

type MaybePromise<T> = T | Promise<T>;

export interface VerificationLifecycleStore {
  saveVerificationTask(task: VerificationTask): MaybePromise<void>;
  commitVerification(commit: VerificationCommit): MaybePromise<void>;
}

const verifierProhibitions = Object.freeze([
  "file writes",
  "commit",
  "push",
  "pull request",
  "merge",
  "deployment",
  "secret access",
  "production access"
] as const);

function uniqueStrings(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)]);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value as Readonly<T>;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function selectVerifier(implementerValue: WorkerProviderId): WorkerProviderId {
  const implementer = WorkerProviderIdSchema.parse(implementerValue);
  return implementer === "codex" ? "claude" : "codex";
}

export function createVerifierTask(inputValue: VerificationInput): VerificationTask {
  const input = VerificationInputSchema.parse(inputValue);
  return deepFreeze(VerificationTaskSchema.parse({
    ...input,
    taskId: `${input.implementationTaskId}:verify:${input.cycle}`,
    title: `Verify ${input.implementationTaskId}`,
    role: "verify",
    preferredAgent: selectVerifier(input.implementationProvider),
    dependsOn: [input.implementationTaskId],
    implementationProhibitedEffects: [...input.prohibitedEffects],
    prohibitedEffects: uniqueStrings([
      ...input.prohibitedEffects,
      ...verifierProhibitions
    ]),
    permissions: "read-only",
    nestedWorkers: "forbidden",
    allowedActions: ["repository_read", "acceptance_commands"]
  })) as VerificationTask;
}

function createFixTask(task: VerificationTask, decision: Extract<
  CompletionDecision,
  { kind: "create_fix_task" }
>): FixTask {
  return deepFreeze(FixTaskSchema.parse({
    taskId: `${task.implementationTaskId}:fix:${decision.nextCycle}`,
    runId: task.runId,
    sourceVerificationTaskId: task.taskId,
    implementationTaskId: task.implementationTaskId,
    title: `Fix ${task.implementationTaskId} after verification`,
    role: "implement",
    preferredAgent: task.implementationProvider,
    dependsOn: [task.taskId],
    cycle: decision.nextCycle,
    findings: decision.findings,
    requestedScope: task.requestedScope,
    prohibitedEffects: task.implementationProhibitedEffects,
    permissions: "read-write",
    nestedWorkers: "forbidden"
  })) as FixTask;
}

function reportMatchesTask(report: VerificationReport, task: VerificationTask): boolean {
  return report.runId === task.runId
    && report.verificationTaskId === task.taskId
    && report.implementationTaskId === task.implementationTaskId
    && report.implementationDispatchId === task.implementationDispatchId
    && report.cycle === task.cycle
    && report.implementationProvider === task.implementationProvider
    && report.verifierProvider === task.preferredAgent
    && report.diffSummary === task.gitDiff.summary
    && JSON.stringify(report.projectRoute) === JSON.stringify(task.projectRoute)
    && JSON.stringify(report.changedFiles) === JSON.stringify(task.changedFiles)
    && JSON.stringify(report.commands.map(({ command }) => command))
      === JSON.stringify(task.testReceipts.map(({ command }) => command))
    && task.auditReferences.every((reference) => report.auditReferences.includes(reference));
}

function auditFor(
  report: VerificationReport,
  decision: CompletionDecision
): VerificationAudit {
  const eventType = decision.kind === "verified_success"
    ? "verification.passed"
    : decision.kind === "intervention_required"
      ? "verification.intervention_required"
      : "verification.failed";
  return deepFreeze({
    subjectId: report.verificationTaskId,
    eventType,
    data: {
      reportId: report.reportId,
      runId: report.runId,
      verificationTaskId: report.verificationTaskId,
      implementationTaskId: report.implementationTaskId,
      implementationDispatchId: report.implementationDispatchId,
      cycle: report.cycle,
      verdict: report.verdict,
      projectKey: report.projectRoute.projectKey,
      implementationProvider: report.implementationProvider,
      verifierProvider: report.verifierProvider,
      commandAuditReferences: report.commands.map(({ auditReference }) => auditReference),
      auditReferences: [...report.auditReferences],
      evidenceReferences: [...report.evidence],
      findingCount: report.findings.length
    }
  }) as VerificationAudit;
}

function outboxFor(
  report: VerificationReport,
  decision: CompletionDecision,
  target?: VerificationCompletionTarget
): VerificationOutboxMessage | undefined {
  const route = target === undefined ? {} : {
    ...(target.commandId === undefined ? {} : { commandId: target.commandId }),
    channel: target.channel,
    destination: target.destination,
    nextAttemptAt: target.nextAttemptAt
  };
  if (decision.kind === "create_fix_task") return undefined;
  if (decision.kind === "intervention_required") {
    return deepFreeze({
      id: `${report.reportId}:intervention`,
      template: "intervention_required" as const,
      ...route,
      payload: {
        state: "intervention_required",
        reportId: report.reportId,
        implementationTaskId: report.implementationTaskId,
        cycle: report.cycle,
        auditReferences: [...report.auditReferences]
      }
    });
  }
  return deepFreeze({
    id: `${report.reportId}:success`,
    template: "success" as const,
    ...route,
    payload: {
      state: "verified_success",
      reportId: report.reportId,
      implementationTaskId: report.implementationTaskId,
      implementationDispatchId: report.implementationDispatchId,
      projectRoute: report.projectRoute,
      changedFiles: [...report.changedFiles],
      diffSummary: report.diffSummary,
      commands: report.commands,
      implementationProvider: report.implementationProvider,
      verifierProvider: report.verifierProvider,
      auditReferences: [...report.auditReferences],
      evidence: [...decision.evidence]
    }
  });
}

export class VerificationService {
  readonly #store: VerificationLifecycleStore;
  readonly #completionTarget: VerificationCompletionTarget | undefined;
  readonly #tasks = new Map<string, VerificationTask>();
  readonly #completed = new Set<string>();

  constructor(options: Readonly<{
    store: VerificationLifecycleStore;
    completionTarget?: VerificationCompletionTarget | undefined;
  }>) {
    this.#store = options.store;
    this.#completionTarget = options.completionTarget === undefined
      ? undefined
      : deepFreeze({ ...options.completionTarget });
  }

  async start(input: VerificationInput): Promise<VerificationTask> {
    const task = createVerifierTask(input);
    if (this.#tasks.has(task.taskId)) {
      throw new Error(`Verification Task ${task.taskId} is already started`);
    }
    await this.#store.saveVerificationTask(task);
    this.#tasks.set(task.taskId, task);
    return task;
  }

  async complete(reportValue: VerificationReport): Promise<CompletionDecision> {
    const report = deepFreeze(VerificationReportSchema.parse(reportValue)) as VerificationReport;
    const task = this.#tasks.get(report.verificationTaskId);
    if (task === undefined) {
      throw new Error(`Verification Task ${report.verificationTaskId} is not known`);
    }
    if (this.#completed.has(report.verificationTaskId)) {
      throw new Error(`Verification Task ${report.verificationTaskId} is already complete`);
    }
    if (!reportMatchesTask(report, task)) {
      throw new TypeError("verification report does not match its immutable Task");
    }
    const decision = completionDecision(report, task.cycle);
    const fixTask = decision.kind === "create_fix_task"
      ? createFixTask(task, decision)
      : undefined;
    const outboxMessage = outboxFor(report, decision, this.#completionTarget);
    const commit = deepFreeze({
      report,
      decision,
      audit: auditFor(report, decision),
      ...(fixTask === undefined ? {} : { fixTask }),
      ...(outboxMessage === undefined ? {} : { outboxMessage })
    }) as VerificationCommit;
    await this.#store.commitVerification(commit);
    this.#completed.add(report.verificationTaskId);
    return decision;
  }
}
