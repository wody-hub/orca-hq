import type { NativeDelivery, NativeMessage } from "./native-coordinator.js";
import type { WorkerResourceVerdict } from "./worker-admission.js";
import { execFile } from "node:child_process";
import { isDeepStrictEqual, promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { openDatabase } from "@orca-hq/persistence";
import {
  NativeWorkItemSchema,
  type NativeWorkItem,
  type NativeWorkerReceipt
} from "@orca-hq/core";
import {
  authoritativeNoLaunchProof,
  buildWorkerStartArgs,
  observedNativeWorkerReceipt,
  validateTerminalReuse,
  type NativeLaunchJournalEntry,
  type NativeLaunchResult,
  type NativeRetentionPolicy,
  type NativeTerminalReuseEvidence
} from "./native-launch.js";
import {
  selectOrcaCliEnvironment,
  selectOrcaCliExecutable
} from "./managed-projects.js";
import type {
  AuthoritativeNoLaunchProof,
  WorkerAdmission,
  WorkerAttempt
} from "./worker-admission.js";
import { normalizeResourceAccesses } from "./execution-reservations.js";
export interface RelayProject {
  id: string;
  name: string;
  absolutePath: string;
  sensitivePaths: readonly string[];
  setupPolicy: string;
  defaultBaseRef?: string;
}
export interface NativeJob {
  execution?: NativeExecutionOwnership;
  id: string;
  runId: string;
  dispatchId?: string;
  projectId: string;
  project?: RelayProject;
  projectName: string;
  prompt: string;
  state:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "stopped"
    | "recovery_required";
  nativeStatus: string;
  createdAt: string;
  updatedAt: string;
  worktreeId?: string;
  worktreePath?: string;
  result?: { summary: string; modifiedFiles: string[]; validation: string[] };
  relayWarning?: string;
}
export interface NativeExecutionOwnership {
  contextId: string;
  requestId: string;
  generation: number;
}
export interface OrcaRelayOptions {
  authorizeLegacyExecution?: (
    project: RelayProject,
    worktreeId?: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  authorizeExecution?: (
    execution: NativeExecutionOwnership,
    project: RelayProject,
    worktreeId?: string,
  ) => Promise<void>;
  databasePath: string;
  coordinatorHandle: string;
  resolveCoordinator?: (runId?: string) => Promise<string>;
  onUpdate?: (job: NativeJob) => void | Promise<void>;
  nativeAdmission?: Pick<
    WorkerAdmission,
    "listAttempts" | "assertLaunchAuthorized" | "bindReceipt" | "markUnknown" | "recoverProvenNoLaunch"
  >;
  resolveNativeProject?: (projectId: string) => Promise<RelayProject>;
  nativeRetentionPolicy?: NativeRetentionPolicy;
  nativeOnly?: boolean;
  assertNativeCoordinator?: () => void;
  now?: () => Date;
  run?: (argv: readonly string[]) => Promise<unknown>;
  pollIntervalMs?: number;
}
type Json = Record<string, any>;
class PreSendRejected extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Orca mutation rejected before send");
    this.name = "PreSendRejected";
    this.cause = cause;
  }
}
interface RequestRecord {
  execution?: NativeExecutionOwnership;
  id: string;
  kind: "submit" | "followup" | "retry";
  project: RelayProject;
  prompt: string;
  phase:
    | "prepared"
    | "task_sent"
    | "task_created"
    | "worker_sent"
    | "message_sent"
    | "observed"
    | "unknown";
  taskId?: string;
  dispatchId?: string;
  parentId?: string;
  worktreeId?: string;
  retryOf?: string;
  launchOwned?: boolean;
  unknownAfterRestart?: boolean;
  warning?: string;
}
export function redactRelayText(value: string): string {
  return value
    .replace(
      /https?:\/\/(?:auth\.openai\.com|login\.tailscale\.com)\/[^\s"<>]+/gi,
      "[REDACTED_AUTH_URL]",
    )
    .replace(
      /https?:\/\/[^\s"<>]+[?&](?:access_token|refresh_token|id_token|code|token)=[^\s"<>]+/gi,
      "[REDACTED_AUTH_URL]",
    )
    .replace(
      /(?:sk-[A-Za-z0-9_-]{12,}|(?:xox[baprs]|xapp)-[A-Za-z0-9-]+|[0-9]{8,}:[A-Za-z0-9_-]{25,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g,
      "[REDACTED]",
    )
    .replace(
      /((?:api[_-]?key|token|secret|password|authorization)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1[REDACTED]",
    );
}
function protect(project: RelayProject) {
  const root = resolve(project.absolutePath);
  const denied = [
    "Project/ETC/orca-hq",
    "orca/workspaces/orca-hq",
    "Applications/orca-hq",
  ].map((p) => join(homedir(), p));
  if (
    project.sensitivePaths.some((p) =>
      p.includes("2026-09-01-orca-hq-private-pilot-roadmap.md"),
    ) ||
    denied.some((p) => root === p || root.startsWith(p + "/"))
  )
    throw Error(
      "보호 파일이 있는 HQ 프로젝트에는 새 편집 작업자를 시작할 수 없습니다",
    );
}
const protectedRelative =
  "docs/superpowers/plans/2026-09-01-orca-hq-private-pilot-roadmap.md";
function protectPrompt(prompt: string) {
  if (
    prompt.includes("2026-09-01-orca-hq-private-pilot-roadmap.md") ||
    [
      "Project/ETC/orca-hq",
      "orca/workspaces/orca-hq",
      "Applications/orca-hq",
    ].some((p) => prompt.includes(join(homedir(), p)))
  )
    throw Error(
      "보호 파일 또는 HQ 보호 경로를 대상으로 하는 지시는 전달할 수 없습니다",
    );
}
function taskSpec(project: RelayProject, prompt: string): string {
  return `필수 보호 규칙: ${protectedRelative} 및 ${join(homedir(), "Project/ETC/orca-hq", protectedRelative)} 파일은 읽기·hash·diff·stage·restore·수정 대상에서 제외합니다. 해당 파일을 포함할 수 있는 광범위 Git/파일 명령도 실행하지 마세요.\n프로젝트 민감 경로(내용이 아닌 경로 규칙): ${JSON.stringify(project.sensitivePaths)}. 비밀 값을 읽거나 결과/로그에 출력하지 마세요.\n작업은 Orca가 지정한 작업 공간에서 수행하고 native Dispatch의 worker_done 규칙을 따르세요. 독립적으로 하위 worker/agent를 실행하지 마세요. 병렬 작업이 필요하면 HQ에 fanout 계획을 보고하고 현재 planner 작업을 먼저 완료하세요. fanout은 worker_done payload의 fanout 배열에 {id, objective, access, dependsOn} 형태로 보고하며 모든 자원은 현재 승인 범위 이내여야 합니다.\n\n사용자 지시:\n${prompt}`;
}
const object = (v: unknown): Json =>
  v && typeof v === "object" ? (v as Json) : {};
const parsed = (v: unknown): Json => {
  if (typeof v === "string") {
    try {
      return object(JSON.parse(v));
    } catch {
      return {};
    }
  }
  return object(v);
};
const rows = (v: unknown): Json[] => (Array.isArray(v) ? v.map(object) : []);
function state(task: string, worker?: string): NativeJob["state"] {
  if (worker === "outcome_unknown") return "recovery_required";
  if (worker === "stopped") return "stopped";
  if (task === "completed" || worker === "succeeded") return "succeeded";
  if (task === "failed" || worker === "failed") return "failed";
  if (
    task === "dispatched" ||
    ["ready", "starting", "running"].includes(worker ?? "")
  )
    return "running";
  return "queued";
}
const exec = promisify(execFile);
export async function runOrca(argv: readonly string[]): Promise<unknown> {
  const env = selectOrcaCliEnvironment();
  try {
    const r = await exec(selectOrcaCliExecutable(), [...argv], {
      env,
      timeout: 75000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(r.stdout);
  } catch (error) {
    const out = (error as { stdout?: string }).stdout;
    if (out) {
      try {
        return JSON.parse(out);
      } catch {
        /* unknown transport outcome */
      }
    }
    throw Error("Orca 응답을 확인하지 못했습니다. 자동 재실행하지 않습니다.");
  }
}
export function createOrcaRelay(options: OrcaRelayOptions) {
  if (!options.coordinatorHandle.trim())
    throw Error("HQ 전용 Orca coordinator handle이 필요합니다");
  if (options.databasePath !== ":memory:")
    mkdirSync(dirname(options.databasePath), { recursive: true, mode: 0o700 });
  const db = openDatabase(options.databasePath);
  if (options.databasePath !== ":memory:")
    chmodSync(options.databasePath, 0o600);
  db.exec(
    "CREATE TABLE IF NOT EXISTS orca_relay_requests(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS orca_relay_snapshots(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS orca_relay_meta(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS orca_native_launches(attempt_id TEXT PRIMARY KEY,body TEXT NOT NULL)",
  );
  const run = options.run ?? runOrca;
  let closed = false;
  let closing = false;
  const cancellation = new AbortController();
  let started = false;
  let poll: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let pollWork: Promise<void> | undefined;
  let serial = Promise.resolve();
  const guidanceLanes = new Map<string, Promise<void>>();
  const guidanceRequests = new Map<string, Promise<NativeJob>>();
  const pending = new Set<Promise<void>>();
  const nativeStarts = new Map<string, Promise<NativeLaunchResult>>();
  const nativeStartItems = new Map<string, NativeWorkItem>();
  const now = options.now ?? (() => new Date());
  const request = (id: string): RequestRecord | undefined => {
    const r = db
      .prepare("SELECT body FROM orca_relay_requests WHERE id=?")
      .get(id) as { body: string } | undefined;
    return r ? JSON.parse(r.body) : undefined;
  };
  const requests = (): RequestRecord[] =>
    (
      db
        .prepare("SELECT body FROM orca_relay_requests ORDER BY rowid")
        .all() as {
        body: string;
      }[]
    ).map((r) => JSON.parse(r.body));
  const saveRequest = (r: RequestRecord) =>
    db
      .prepare("INSERT OR REPLACE INTO orca_relay_requests VALUES(?,?)")
      .run(r.id, JSON.stringify(r));
  const nativeLaunch = (attemptId: string): NativeLaunchJournalEntry | undefined => {
    const row = db.prepare("SELECT body FROM orca_native_launches WHERE attempt_id=?")
      .get(attemptId) as { body: string } | undefined;
    return row ? JSON.parse(row.body) as NativeLaunchJournalEntry : undefined;
  };
  const saveNativeLaunch = (entry: NativeLaunchJournalEntry): NativeLaunchJournalEntry => {
    db.prepare("INSERT OR REPLACE INTO orca_native_launches VALUES(?,?)")
      .run(entry.attemptId, JSON.stringify(entry));
    return entry;
  };
  const meta = (): Json => {
    const r = db
      .prepare("SELECT body FROM orca_relay_meta WHERE id='coordinator'")
      .get() as { body: string } | undefined;
    return r ? JSON.parse(r.body) : {};
  };
  const saveMeta = (value: Json) =>
    db
      .prepare("INSERT OR REPLACE INTO orca_relay_meta VALUES('coordinator',?)")
      .run(JSON.stringify(value));
  const getCached = (id: string): NativeJob => {
    const r = db
      .prepare("SELECT body FROM orca_relay_snapshots WHERE id=?")
      .get(id) as { body: string } | undefined;
    if (!r) throw Error("아직 관측한 Orca 작업이 아닙니다");
    return JSON.parse(r.body);
  };
  const save = (j: NativeJob) => {
    const body = JSON.stringify(j);
    const old = db
      .prepare("SELECT body FROM orca_relay_snapshots WHERE id=?")
      .get(j.id) as { body: string } | undefined;
    db.prepare("INSERT OR REPLACE INTO orca_relay_snapshots VALUES(?,?)").run(
      j.id,
      body,
    );
    if (old?.body !== body)
      try {
        void Promise.resolve(options.onUpdate?.(structuredClone(j))).catch(
          () => {},
        );
      } catch {
        /* delivery failure never restarts work */
      }
    return j;
  };
  const coordinator = async (): Promise<string> => {
    if (!options.resolveCoordinator) return options.coordinatorHandle;
    const m = meta();
    const handle = await options.resolveCoordinator(
      m.runId ? String(m.runId) : undefined,
    );
    if (!handle.startsWith("term_"))
      throw Error("HQ coordinator handle이 잘못되었습니다");
    if (m.coordinatorHandle !== handle)
      saveMeta({ ...m, coordinatorHandle: handle });
    return handle;
  };
  const callReceipt = async (
    command: string,
    args: string[] = [],
    from = false,
    beforeSend?: () => void,
  ): Promise<{ requestId?: string; result: Json }> => {
    const routedFrom = from ? await coordinator() : undefined;
    try {
      beforeSend?.();
    } catch (error) {
      throw new PreSendRejected(error);
    }
    const receipt = object(
      await run([
        "orchestration",
        command,
        ...args,
        ...(routedFrom ? ["--from", routedFrom] : []),
        "--json",
      ]),
    );
    if (receipt.ok !== true)
      throw Object.assign(
        Error(
          redactRelayText(String(receipt.error?.message ?? "Orca 요청 실패")),
        ),
        { receipt },
      );
    const mutation = object(receipt.result?.mutation);
    return {
      ...(typeof mutation.requestId === "string" && mutation.requestId.trim()
        ? { requestId: mutation.requestId.trim() }
        : {}),
      result: object(receipt.result)
    };
  };
  const call = async (
    command: string,
    args: string[] = [],
    from = false,
  ): Promise<Json> => (await callReceipt(command, args, from)).result;
  const allRuns = async () => {
    const found: Json[] = [];
    let cursor: string | undefined;
    do {
      const r = await call("run-list", [
        "--limit",
        "100",
        ...(cursor ? ["--cursor", cursor] : []),
      ]);
      found.push(...rows(r.runs));
      cursor = typeof r.nextCursor === "string" ? r.nextCursor : undefined;
    } while (cursor);
    return found;
  };
  const ensureRun = async () => {
    const handle = await coordinator();
    let m = meta();
    if (m.coordinatorHandle && m.coordinatorHandle !== handle)
      throw Error("저장된 Orca coordinator와 현재 handle이 다릅니다");
    if (m.runId) return String(m.runId);
    if (m.phase === "sent") {
      const found = (await allRuns()).find((r) => r.objective === m.objective);
      if (found) {
        m.runId = found.id;
        saveMeta(m);
        return String(m.runId);
      }
      if (typeof m.mutationRequestId === "string" && m.mutationRequestId) {
        const requestState = await call("request-show", ["--request", m.mutationRequestId]);
        if (["completed", "pending"].includes(String(requestState.state))) {
          const replay = await callReceipt("run-create", [
            "--objective", m.objective,
            "--retry-request", m.mutationRequestId,
          ], true);
          const id = replay.result.run?.id ?? replay.result.runId ?? replay.result.id;
          if (typeof id === "string") {
            m.runId = id;
            m.phase = "observed";
            saveMeta(m);
            return id;
          }
        }
      }
      throw Error("Orca Run 생성 응답 불명: 기존 Run을 확인해야 합니다");
    }
    m = {
      coordinatorHandle: handle,
      objective: `Orca HQ relay ${randomUUID()}`,
      mutationRequestId: null,
      phase: "sent",
    };
    saveMeta(m);
    let receipt: { requestId?: string; result: Json };
    try {
      receipt = await callReceipt("run-create", ["--objective", m.objective], true);
    } catch (error) {
      const failed = object((error as { receipt?: unknown }).receipt);
      const data = object(failed.error?.data);
      if (typeof data.orchestrationRequestId === "string" && data.orchestrationRequestId.trim()) {
        m.mutationRequestId = data.orchestrationRequestId.trim();
        saveMeta(m);
      }
      throw error;
    }
    m.mutationRequestId = receipt.requestId ?? null;
    saveMeta(m);
    const id = receipt.result.run?.id ?? receipt.result.runId ?? receipt.result.id;
    if (typeof id !== "string") throw Error("Orca Run ID 응답 불명");
    m.runId = id;
    m.phase = "observed";
    saveMeta(m);
    return id;
  };
  const owner = (id: string) =>
    requests().find((r) => r.taskId === id && r.kind !== "followup") ??
    requests().find((r) => r.taskId === id && r.phase !== "message_sent");
  const latestWorkerLaunch = (id: string) =>
    requests()
      .filter(
        (r) =>
          r.taskId === id &&
          (r.kind !== "followup" || r.worktreeId !== undefined),
      )
      .at(-1);
  const projectFor = (j: NativeJob): RelayProject =>
    owner(j.id)?.project ?? {
      id: j.projectId,
      name: j.projectName,
      absolutePath: j.worktreePath ?? "",
      sensitivePaths: [],
      setupPolicy: "inherit",
    };
  const projectTask = (task: Json, runId: string): NativeJob => {
    const req = owner(String(task.id));
    const latestDelivery = requests()
      .filter((r) => r.taskId === String(task.id))
      .at(-1);
    const latestLaunch = latestWorkerLaunch(String(task.id));
    const result = parsed(task.result);
    let prior: Partial<NativeJob> = {};
    try {
      prior = getCached(String(task.id));
    } catch {
      /* first observation */
    }
    delete prior.relayWarning;
    if (latestLaunch?.kind === "retry" && !latestLaunch.execution)
      delete prior.execution;
    return {
      ...prior,
      ...(latestLaunch?.execution
        ? { execution: latestLaunch.execution }
        : {}),
      id: String(task.id),
      runId,
      projectId: req?.project.id ?? prior.projectId ?? "unknown",
      ...(req?.project ? { project: req.project } : {}),
      projectName: req?.project.name ?? prior.projectName ?? "Orca",
      prompt: redactRelayText(req?.prompt ?? String(task.spec ?? "")),
      state: state(String(task.status)),
      nativeStatus: String(task.status),
      createdAt: String(task.created_at ?? ""),
      updatedAt: String(task.completed_at ?? task.created_at ?? ""),
      ...(result.body || result.subject
        ? {
            result: {
              summary: redactRelayText(String(result.body ?? result.subject)),
              modifiedFiles: Array.isArray(result.filesModified)
                ? result.filesModified.map((s: unknown) =>
                    redactRelayText(String(s)),
                  )
                : [],
              validation: [],
            },
          }
        : {}),
      ...(latestDelivery?.phase === "unknown"
        ? {
            relayWarning:
              latestDelivery.warning ??
              "Orca mutation 결과 확인 필요. 자동 재실행하지 않습니다.",
          }
        : {}),
    };
  };
  const get = async (id: string): Promise<NativeJob> => {
    const cached = (() => {
      try {
        return getCached(id);
      } catch {
        return undefined;
      }
    })();
    let task: Json | undefined;
    let runId = cached?.runId;
    const candidates = runId ? [{ id: runId }] : await allRuns();
    for (const r of candidates) {
      const list = await call("task-list", ["--run", String(r.id)]);
      task = rows(list.tasks).find((t) => t.id === id);
      if (task) {
        runId = String(r.id);
        break;
      }
    }
    if (!task || !runId) throw Error("Orca 작업을 찾을 수 없습니다");
    const job = projectTask(task, runId);
    let dispatch: Json | undefined;
    try {
      dispatch = (await call("dispatch-show", ["--task", id], true)).dispatch;
    } catch {
      /* undispatched native task */
    }
    if (dispatch?.id) {
      job.dispatchId = String(dispatch.id);
      const observed = await call("worker-show", [
        "--dispatch",
        job.dispatchId,
      ]);
      const worker = object(observed.worker);
      job.state = state(String(task.status), worker.state);
      job.nativeStatus = String(worker.state ?? task.status);
      const worktree = worker.worktree_id ?? observed.terminal?.worktreeId;
      if (typeof worktree === "string") {
        job.worktreeId = worktree;
        const separator = worktree.indexOf("::");
        if (separator >= 0) {
          job.worktreePath = worktree.slice(separator + 2);
          if (job.projectId === "unknown") {
            job.projectId = worktree.slice(0, separator);
            job.projectName = job.projectId;
          }
        }
      }
      job.updatedAt = String(worker.updated_at ?? job.updatedAt);
      if (!job.project && job.projectId !== "unknown") {
        try {
          const receipt = object(
            await run([
              "repo",
              "show",
              "--repo",
              `id:${job.projectId}`,
              "--json",
            ]),
          );
          const repo = receipt.result?.repo;
          if (receipt.ok === true && typeof repo?.path === "string")
            job.project = {
              id: job.projectId,
              name: String(repo.displayName ?? job.projectName),
              absolutePath: repo.path,
              sensitivePaths: [],
              setupPolicy: "inherit",
            };
        } catch {
          /* external project root not yet observed */
        }
      }
      if (
        !job.result &&
        ["succeeded", "failed", "stopped"].includes(job.state)
      ) {
        try {
          const output = await call("worker-read", [
            "--dispatch",
            job.dispatchId,
            "--limit",
            "40",
          ]);
          const text =
            output.terminal?.lines ?? output.transcript?.messages ?? [];
          job.result = {
            summary: redactRelayText(JSON.stringify(text).slice(-12000)),
            modifiedFiles: [],
            validation: [],
          };
        } catch {
          /* result remains unknown */
        }
      }
    }
    const launch = latestWorkerLaunch(id);
    if (launch?.phase === "unknown") {
      const exactOwnedDispatch =
        launch.launchOwned === true &&
        launch.dispatchId !== undefined &&
        job.dispatchId === launch.dispatchId;
      if (exactOwnedDispatch) {
        launch.phase = "observed";
        delete launch.unknownAfterRestart;
        saveRequest(launch);
        delete job.relayWarning;
      } else if (
        launch.execution ||
        launch.unknownAfterRestart ||
        (job.dispatchId !== undefined && job.dispatchId !== launch.retryOf)
      ) {
        job.state = "recovery_required";
        job.nativeStatus =
          launch.kind === "retry"
            ? "retry_outcome_unknown"
            : "worker_start_outcome_unknown";
        delete job.dispatchId;
      }
    }
    const attempt = requests()
      .filter((r) => r.taskId === id && r.kind === "retry")
      .at(-1);
    if (
      attempt?.execution &&
      attempt.retryOf === job.dispatchId &&
      attempt.phase !== "observed"
    ) {
      job.state = attempt.phase === "unknown" ? "recovery_required" : "queued";
      job.nativeStatus =
        attempt.phase === "unknown" ? "retry_outcome_unknown" : "retry_pending";
      delete job.dispatchId;
    }
    return save(job);
  };
  const applyLegacyCompletionPolicy = async (id: string): Promise<NativeJob> => {
    const job = await get(id);
    const launch = requests().find(
      (candidate) =>
        candidate.launchOwned === true &&
        candidate.dispatchId === job.dispatchId
    );
    if (!launch || !job.dispatchId || !["succeeded", "failed"].includes(job.state)) {
      return job;
    }
    try {
      const observed = await call("worker-show", ["--dispatch", job.dispatchId]);
      if (
        observed.terminalResource?.retainedReason ||
        observed.terminalResource?.releaseState === "retained" ||
        observed.terminalResource?.releaseState === "released"
      ) {
        return job;
      }
      const cleanup = await call("worker-release", ["--dispatch", job.dispatchId]);
      if (["release_pending", "release_unknown"].includes(String(cleanup.state))) {
        job.relayWarning = `Orca 작업자 정리 확인 필요: ${cleanup.state}`;
      }
    } catch (error) {
      job.relayWarning = `Orca 작업은 완료되었으며 작업자 정리 확인이 필요합니다: ${redactRelayText(error instanceof Error ? error.message : "unknown")}`;
    }
    return save(job);
  };
  const list = async (): Promise<NativeJob[]> => {
    const output: NativeJob[] = [];
    for (const r of await allRuns()) {
      const result = await call("task-list", [
        "--run",
        String(r.id),
        "--brief",
      ]);
      for (const task of rows(result.tasks)) {
        const job = projectTask(task, String(r.id));
        if (["dispatched", "blocked"].includes(String(task.status))) {
          output.push(await get(job.id));
        } else output.push(save(job));
      }
    }
    return output;
  };
  const background = (r: RequestRecord) => {
    const work = (async () => {
      if (closed || closing || r.phase !== "task_created") return;
      try {
        if (!r.execution)
          await options.authorizeLegacyExecution?.(
            r.project,
            r.worktreeId,
            cancellation.signal,
          );
        if (r.execution)
          await options.authorizeExecution?.(
            r.execution,
            r.project,
            r.worktreeId,
          );
        const args = [
          "--task",
          r.taskId!,
          "--run",
          String(meta().runId),
          "--worktree",
          r.worktreeId ? `id:${r.worktreeId}` : "new-top-level",
          "--agent",
          "codex",
          "--timeout-ms",
          "60000",
        ];
        if (!r.worktreeId) {
          args.push(
            "--repo",
            `id:${r.project.id}`,
            "--name",
            `hq-${r.taskId}`,
            "--setup",
            r.project.setupPolicy === "skip" ? "skip" : "run",
          );
          if (r.project.defaultBaseRef)
            args.push("--base-branch", r.project.defaultBaseRef);
        }
        if (r.retryOf) args.push("--retry-of", r.retryOf);
        if (cancellation.signal.aborted) return;
        r.phase = "worker_sent";
        saveRequest(r);
        const receipt = await call("worker-start", args, true);
        r.dispatchId = String(receipt.dispatchId ?? "");
        r.launchOwned = Boolean(r.dispatchId);
        r.phase = "observed";
        if (!closed) {
          saveRequest(r);
          await get(r.taskId!);
          await applyLegacyCompletionPolicy(r.taskId!);
        }
      } catch (error) {
        if (cancellation.signal.aborted && r.phase === "task_created") return;
        if (!closed) {
          r.warning = redactRelayText(
            error instanceof Error ? error.message : "Orca 응답 확인 필요",
          );
          r.phase = "unknown";
          saveRequest(r);
          try {
            await get(r.taskId!);
          } catch {
            /* preserve native last observation */
          }
        }
      }
    })();
    pending.add(work);
    void work.finally(() => pending.delete(work));
  };
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    if (closed || closing)
      return Promise.reject(Error("Orca relay가 종료 중입니다"));
    const result = serial.then(work);
    serial = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  const serializedGuidance = (
    taskId: string,
    requestId: string,
    work: () => Promise<NativeJob>,
  ): Promise<NativeJob> => {
    if (closed || closing)
      return Promise.reject(Error("Orca relay가 종료 중입니다"));
    const existing = guidanceRequests.get(requestId);
    if (existing) return existing;
    const prior = guidanceLanes.get(taskId) ?? Promise.resolve();
    const result = prior.then(work);
    const settled = result.then(
      () => {},
      () => {},
    );
    guidanceLanes.set(taskId, settled);
    guidanceRequests.set(requestId, result);
    void settled.finally(() => {
      if (guidanceLanes.get(taskId) === settled) guidanceLanes.delete(taskId);
      if (guidanceRequests.get(requestId) === result)
        guidanceRequests.delete(requestId);
    });
    return result;
  };
  const create = async (
    input: {
      requestId: string;
      project: RelayProject;
      prompt: string;
      worktree?: string;
      execution?: NativeExecutionOwnership;
    },
    extra: Partial<RequestRecord> = {},
  ): Promise<NativeJob> => {
    if (closed || closing || !started)
      throw Error("Orca relay가 시작되지 않았습니다");
    if (
      !input.requestId.trim() ||
      !input.prompt.trim() ||
      input.prompt.length > 32000
    )
      throw Error("작업 요청이 잘못되었습니다");
    const existing = request(input.requestId);
    if (existing) {
      if (existing.taskId) return get(existing.taskId);
      throw Error("이 요청의 native 작업 생성 결과를 먼저 확인해야 합니다");
    }
    protect(input.project);
    protectPrompt(input.prompt);
    if (input.worktree) {
      const worktree = input.worktree.replace(/^id:/, "");
      if (!worktree.startsWith(input.project.id + "::"))
        throw Error("작업 공간이 선택 프로젝트에 속하지 않습니다");
      const receipt = object(
        await run([
          "worktree",
          "show",
          "--worktree",
          `id:${worktree}`,
          "--json",
        ]),
      );
      const observed = object(receipt.result?.worktree);
      if (
        receipt.ok !== true ||
        observed.id !== worktree ||
        observed.repoId !== input.project.id ||
        typeof observed.path !== "string"
      )
        throw Error("Orca 작업 공간 소속을 확인하지 못했습니다");
      protect({ ...input.project, absolutePath: observed.path });
      extra = { ...extra, worktreeId: worktree };
      if (/검토|리뷰|review/i.test(input.prompt))
        input = {
          ...input,
          prompt: `Read-only review. Do not edit files.\n${input.prompt}`,
        };
    }
    const runId = await ensureRun();
    const r: RequestRecord = {
      id: input.requestId,
      kind: "submit",
      project: structuredClone(input.project),
      ...(input.execution ? { execution: input.execution } : {}),
      prompt: input.prompt,
      phase: "prepared",
      ...extra,
    };
    saveRequest(r);
    r.phase = "task_sent";
    saveRequest(r);
    const args = [
      "--run",
      runId,
      "--spec",
      `[HQ request ${r.id}]\n${taskSpec(input.project, input.prompt)}`,
      "--task-title",
      input.prompt.slice(0, 100),
    ];
    if (r.parentId) args.push("--parent", r.parentId);
    try {
      const result = await call("task-create", args, true);
      const task = object(result.task ?? result);
      if (typeof task.id !== "string") throw Error("Orca Task ID 응답 불명");
      r.taskId = task.id;
      r.phase = "task_created";
      saveRequest(r);
      const job = save(projectTask(task, runId));
      queueMicrotask(() => background(r));
      return job;
    } catch (error) {
      r.phase = "unknown";
      saveRequest(r);
      throw error;
    }
  };
  const submit = (input: {
    requestId: string;
    project: RelayProject;
    prompt: string;
    worktree?: string;
    execution?: NativeExecutionOwnership;
  }) => serialized(() => create(input));
  const followupWork = async (
    id: string,
    prompt: string,
    requestId: string,
    execution?: NativeExecutionOwnership,
    createWhenSettled = true,
  ): Promise<NativeJob | undefined> => {
    protectPrompt(prompt);
    const prior = request(requestId);
    if (prior?.taskId) return get(prior.taskId);
    const job = await get(id);
    protect(projectFor(job));
    if (job.state === "running" && job.dispatchId) {
      const r: RequestRecord = {
        id: requestId,
        kind: "followup",
        project: projectFor(job),
        prompt,
        taskId: id,
        dispatchId: job.dispatchId,
        phase: "message_sent",
      };
      saveRequest(r);
      try {
        await call(
          "send",
          [
            "--run",
            job.runId,
            "--to",
            `dispatch:${job.dispatchId}`,
            "--type",
            "status",
            "--subject",
            "HQ 후속 지시",
            "--body",
            taskSpec(projectFor(job), prompt),
          ],
          true,
        );
        r.phase = "observed";
        saveRequest(r);
      } catch (error) {
        r.phase = "unknown";
        saveRequest(r);
        throw error;
      }
      return get(id);
    }
    if (!createWhenSettled) return undefined;
    if (!job.worktreeId)
      throw Error("Orca 작업 공간 확인 후 후속 작업을 시작할 수 있습니다");
    return create(
      {
        requestId,
        ...(execution ? { execution } : {}),
        project: projectFor(job),
        prompt: `원래 Orca 작업 ${id}의 후속 지시:\n${prompt}`,
      },
      {
        kind: "followup",
        worktreeId: job.worktreeId,
        ...(job.runId === meta().runId ? { parentId: id } : {}),
      },
    );
  };
  const followup = (
    id: string,
    prompt: string,
    requestId: string,
    execution?: NativeExecutionOwnership,
  ): Promise<NativeJob> => {
    try {
      const known = getCached(id);
      if (known.state === "running" && known.dispatchId)
        return serializedGuidance(id, requestId, async () => {
          const delivered = await followupWork(
            id,
            prompt,
            requestId,
            execution,
            false,
          );
          return (
            delivered ??
            (await serialized(async () =>
              followupWork(id, prompt, requestId, execution),
            ))!
          );
        });
    } catch {
      /* Unknown jobs use the normal serialized discovery path. */
    }
    return serialized(async () =>
      followupWork(id, prompt, requestId, execution),
    ).then((job) => job!);
  };
  const stop = async (id: string) => {
    const job = await get(id);
    if (!job.dispatchId)
      throw Error("이 작업에는 중지할 native Dispatch가 없습니다");
    await call("worker-stop", ["--dispatch", job.dispatchId]);
    return get(id);
  };
  const retry = (
    id: string,
    requestId: string,
    execution?: NativeExecutionOwnership,
  ) =>
    serialized(async () => {
      const prior = request(requestId);
      if (prior?.taskId) return get(prior.taskId);
      const job = await get(id);
      if (
        !["failed", "stopped"].includes(job.state) ||
        !job.dispatchId ||
        !job.worktreeId
      )
        throw Error(
          "Orca가 failed/stopped로 확인한 Dispatch만 재시도할 수 있습니다",
        );
      protect(projectFor(job));
      const r: RequestRecord = {
        id: requestId,
        kind: "retry",
        ...(execution ? { execution } : {}),
        project: projectFor(job),
        prompt: job.prompt,
        taskId: id,
        phase: "task_created",
        retryOf: job.dispatchId,
        worktreeId: job.worktreeId,
      };
      saveRequest(r);
      background(r);
      const queued = {
        ...job,
        state: "queued" as const,
        nativeStatus: "retry_pending",
        ...(execution ? { execution } : {}),
      };
      if (!execution) delete queued.execution;
      delete queued.dispatchId;
      return save(queued);
    });

  const requireNativeAdmission = (item: NativeWorkItem): WorkerAttempt => {
    if (!options.nativeAdmission) throw new Error("native_admission_required");
    const attempt = options.nativeAdmission.listAttempts()
      .find(candidate => candidate.item.attemptId === item.attemptId);
    if (!attempt || !isDeepStrictEqual(attempt.item, item)) {
      throw new Error("native_attempt_identity_mismatch");
    }
    return attempt;
  };

  const assertNativeEffectAllowed = (item: NativeWorkItem): void => {
    if (closing || closed) throw new Error("Orca relay가 종료 중입니다");
    const authorized = options.nativeAdmission!.assertLaunchAuthorized(item.attemptId);
    if (!isDeepStrictEqual(authorized, item)) {
      throw new Error("native_attempt_identity_mismatch");
    }
  };

  const validateNativePlacement = async (item: NativeWorkItem): Promise<RelayProject> => {
    if (!options.resolveNativeProject) throw new Error("native_project_resolver_required");
    const project = await options.resolveNativeProject(item.projectId);
    if (project.id !== item.projectId || !item.worktreeId.startsWith(`${item.projectId}::`)) {
      throw new Error("native_worktree_project_mismatch");
    }
    protect(project);
    protectPrompt(item.objective);
    const receipt = object(await run([
      "worktree", "show", "--worktree", `id:${item.worktreeId}`, "--json"
    ]));
    const worktree = object(receipt.result?.worktree);
    if (
      receipt.ok !== true ||
      worktree.id !== item.worktreeId ||
      worktree.repoId !== item.projectId ||
      typeof worktree.path !== "string"
    ) {
      throw new Error("native_worktree_observation_mismatch");
    }
    protect({ ...project, absolutePath: worktree.path });
    const [observedCheckout] = normalizeResourceAccesses([{
      resourceKey: `checkout:${worktree.path}`,
      mode: item.access
    }]);
    if (!observedCheckout || !item.resources.some(resource =>
      resource.resourceKey === observedCheckout.resourceKey && resource.mode === item.access
    )) {
      throw new Error("native_primary_checkout_mismatch");
    }
    return project;
  };

  const validateNativeTerminalReuse = async (
    item: NativeWorkItem
  ): Promise<NativeWorkerReceipt["effective"] | null> => {
    if (!item.resumeTerminalHandle) return null;
    const admission = options.nativeAdmission!;
    const prior = admission.listAttempts().find(candidate =>
      candidate.item.attemptId !== item.attemptId &&
      candidate.item.contextId === item.contextId &&
      candidate.state === "settled" &&
      candidate.resourceVerdict === "retained_idle" &&
      candidate.receipt?.terminalHandle === item.resumeTerminalHandle
    );
    if (!prior?.receipt) throw new Error("terminal_reuse_not_authorized");
    const priorJournal = nativeLaunch(prior.item.attemptId);
    if (
      priorJournal?.phase !== "ready" ||
      priorJournal.receipt?.dispatchId !== prior.receipt.dispatchId ||
      priorJournal.terminalHandle !== item.resumeTerminalHandle ||
      !priorJournal.terminalSessionId
    ) {
      throw new Error("terminal_reuse_not_authorized");
    }
    const observed = await call("worker-show", ["--dispatch", prior.receipt.dispatchId]);
    const worker = object(observed.worker);
    const terminal = object(observed.terminal);
    const resource = object(observed.terminalResource);
    const observation = object(observed.observation);
    const idle = object(await run([
      "terminal", "wait",
      "--terminal", item.resumeTerminalHandle,
      "--for", "tui-idle",
      "--timeout-ms", "5000",
      "--json"
    ]));
    const currentSessionId = String(terminal.incarnationId ?? terminal.ptyId ?? "");
    const evidence: NativeTerminalReuseEvidence = {
      terminalHandle: String(terminal.handle ?? ""),
      worktreeId: String(terminal.worktreeId ?? ""),
      contextId: prior.item.contextId,
      priorAttemptId: prior.item.attemptId,
      priorDispatchId: prior.receipt.dispatchId,
      sessionId: currentSessionId,
      state: ["succeeded", "failed", "stopped"].includes(String(worker.state)) &&
        observation.exactWorker === true &&
        currentSessionId === priorJournal.terminalSessionId &&
        idle.ok === true ? "idle" : "unknown",
      ownership: resource.ownershipState === "owned" &&
        resource.releaseState === "retained" &&
        resource.ownerDispatchId === prior.receipt.dispatchId
        ? "hq_retained"
        : resource.ownershipState === "transferred"
          ? "user_owned"
          : "unknown",
      connected: terminal.connected === true,
      writable: terminal.writable === true,
      requested: prior.receipt.requested,
      effective: {
        agent: prior.receipt.effective.agent,
        ...(prior.receipt.effective.model ? { model: prior.receipt.effective.model } : {}),
        ...(prior.receipt.effective.effort ? { effort: prior.receipt.effective.effort } : {})
      }
    };
    validateTerminalReuse(item, evidence);
    return prior.receipt.effective;
  };

  const nativeRecovery = (
    entry: NativeLaunchJournalEntry,
    reason: string,
    value: unknown = {}
  ): NativeLaunchResult => {
    const details = object(value);
    const residualResources = Array.isArray(details.residualResources)
      ? details.residualResources
      : entry.residualResources;
    const updated = saveNativeLaunch({
      ...entry,
      phase: "recovery_required",
      warning: redactRelayText(reason),
      residualResources
    });
    options.nativeAdmission!.markUnknown(entry.attemptId);
    return {
      state: "recovery_required",
      attemptId: entry.attemptId,
      runId: entry.runId,
      ...(updated.taskId ? { taskId: updated.taskId } : {}),
      ...(updated.dispatchId ? { dispatchId: updated.dispatchId } : {}),
      ...((updated.taskId
        ? updated.mutationRequestIds.worker
        : updated.mutationRequestIds.task)
        ? {
            mutationRequestId: (updated.taskId
              ? updated.mutationRequestIds.worker
              : updated.mutationRequestIds.task)!
          }
        : {}),
      residualResources,
      reason: updated.warning!
    };
  };

  const reportedNativeTerminalHandle = (value: Json): string | null => {
    for (const direct of [value.agentTerminalHandle, value.terminalHandle]) {
      if (typeof direct === "string" && direct.trim()) return direct.trim();
    }
    const effects = [
      ...(Array.isArray(value.effects) ? value.effects : []),
      ...(Array.isArray(value.residualResources) ? value.residualResources : [])
    ].map(object);
    const terminal = effects.find(effect =>
      effect.kind === "terminal" &&
      (effect.role === undefined || effect.role === "agent") &&
      typeof effect.id === "string" && effect.id.trim()
    );
    return terminal ? String(terminal.id).trim() : null;
  };

  const observeNativeDispatch = async (
    item: NativeWorkItem,
    entry: NativeLaunchJournalEntry
  ): Promise<NativeLaunchResult | undefined> => {
    if (!entry.dispatchId) return undefined;
    try {
      const observed = await call("worker-show", ["--dispatch", entry.dispatchId]);
      if (observed.worker?.state !== "ready") return undefined;
      const receipt = observedNativeWorkerReceipt(item, entry, observed);
      const terminal = object(observed.terminal);
      const terminalSessionId = typeof terminal.incarnationId === "string"
        ? terminal.incarnationId
        : typeof terminal.ptyId === "string"
          ? terminal.ptyId
          : null;
      if (!terminalSessionId) throw new Error("native_terminal_session_unknown");
      options.nativeAdmission!.bindReceipt(receipt);
      saveNativeLaunch({
        ...entry,
        phase: "ready",
        terminalHandle: receipt.terminalHandle,
        terminalSessionId,
        effective: receipt.effective,
        receipt,
        warning: null,
        residualResources: []
      });
      return { state: "ready", receipt };
    } catch {
      return undefined;
    }
  };

  const processNativeWorkerResult = async (
    item: NativeWorkItem,
    entry: NativeLaunchJournalEntry,
    value: unknown
  ): Promise<NativeLaunchResult> => {
    const result = object(value);
    const dispatchId = typeof result.dispatchId === "string" && result.dispatchId.trim()
      ? result.dispatchId.trim()
      : entry.dispatchId;
    entry = saveNativeLaunch({
      ...entry,
      dispatchId,
      terminalHandle: reportedNativeTerminalHandle(result) ?? entry.terminalHandle
    });
    const proof = authoritativeNoLaunchProof(item, entry, result, now().toISOString());
    if (proof) {
      options.nativeAdmission!.recoverProvenNoLaunch(proof);
      saveNativeLaunch({
        ...entry,
        phase: "proven_no_launch",
        noLaunchProof: proof,
        warning: null,
        residualResources: []
      });
      return { state: "proven_no_launch", proof };
    }
    if (result.state === "ready" && !dispatchId) {
      return nativeRecovery(entry, "worker-start ready 응답에 Dispatch가 없습니다", result);
    }
    const observed = await observeNativeDispatch(item, entry);
    if (observed) return observed;
    return nativeRecovery(
      entry,
      String(result.lastError ?? result.warning ?? `worker-start 상태 확인 필요: ${result.state ?? "unknown"}`),
      result
    );
  };

  const workerStart = async (
    item: NativeWorkItem,
    entry: NativeLaunchJournalEntry,
    retryRequest = false
  ): Promise<NativeLaunchResult> => {
    if (!entry.taskId) return nativeRecovery(entry, "native Task ID가 없습니다");
    if (closing || closed) {
      return nativeRecovery(entry, "relay 종료 전에 worker-start가 전송되지 않았습니다");
    }
    const taskId = entry.taskId;
    assertNativeEffectAllowed(item);
    if (retryRequest && !entry.mutationRequestIds.worker) {
      return nativeRecovery(entry, "worker-start mutation ID가 없어 재실행할 수 없습니다");
    }
    entry = saveNativeLaunch({ ...entry, phase: "worker_sent" });
    const args = [
      ...buildWorkerStartArgs(item, { runId: entry.runId, taskId }),
      ...(retryRequest
        ? ["--retry-request", entry.mutationRequestIds.worker!]
        : [])
    ];
    try {
      const response = await callReceipt(
        "worker-start",
        args,
        true,
        () => assertNativeEffectAllowed(item)
      );
      if (
        retryRequest && response.requestId &&
        response.requestId !== entry.mutationRequestIds.worker
      ) {
        return nativeRecovery(entry, "worker-start mutation ID 불일치");
      }
      if (!retryRequest && response.requestId) {
        entry = saveNativeLaunch({
          ...entry,
          mutationRequestIds: {
            ...entry.mutationRequestIds,
            worker: response.requestId
          }
        });
      }
      return await processNativeWorkerResult(item, entry, response.result);
    } catch (error) {
      if (error instanceof PreSendRejected) throw error.cause;
      const receipt = object((error as { receipt?: unknown }).receipt);
      const result = object(receipt.result ?? receipt.error?.data);
      const errorData = object(receipt.error?.data);
      const responseRequestId = typeof errorData.orchestrationRequestId === "string" && errorData.orchestrationRequestId.trim()
        ? errorData.orchestrationRequestId.trim()
        : null;
      if (responseRequestId) {
        if (entry.mutationRequestIds.worker && entry.mutationRequestIds.worker !== responseRequestId) {
          return nativeRecovery(entry, "worker-start mutation ID 불일치", result);
        }
        entry = saveNativeLaunch({
          ...entry,
          mutationRequestIds: {
            ...entry.mutationRequestIds,
            worker: responseRequestId
          }
        });
      }
      const dispatchId = typeof result.dispatchId === "string"
        ? result.dispatchId
        : typeof result.recovery?.dispatchId === "string"
          ? result.recovery.dispatchId
          : null;
      entry = saveNativeLaunch({
        ...entry,
        dispatchId,
        terminalHandle: reportedNativeTerminalHandle(result) ?? entry.terminalHandle
      });
      const proof = authoritativeNoLaunchProof(item, entry, result, now().toISOString());
      if (proof) {
        options.nativeAdmission!.recoverProvenNoLaunch(proof);
        saveNativeLaunch({ ...entry, phase: "proven_no_launch", noLaunchProof: proof });
        return { state: "proven_no_launch", proof };
      }
      const observed = await observeNativeDispatch(item, entry);
      if (observed) return observed;
      return nativeRecovery(
        entry,
        error instanceof Error ? error.message : "worker-start 응답 확인 필요",
        result
      );
    }
  };

  const taskCreate = async (
    item: NativeWorkItem,
    project: RelayProject,
    entry: NativeLaunchJournalEntry,
    retryRequest = false
  ): Promise<NativeLaunchResult> => {
    if (closing || closed) {
      return nativeRecovery(entry, "relay 종료 전에 task-create가 전송되지 않았습니다");
    }
    assertNativeEffectAllowed(item);
    if (retryRequest && !entry.mutationRequestIds.task) {
      return nativeRecovery(entry, "task-create mutation ID가 없어 재실행할 수 없습니다");
    }
    entry = saveNativeLaunch({ ...entry, phase: "task_sent" });
    const args = [
      "--run", entry.runId,
      "--spec", `[HQ native attempt ${item.attemptId}]\n${taskSpec(project, item.objective)}`,
      "--task-title", item.objective.slice(0, 100),
      ...(retryRequest
        ? ["--retry-request", entry.mutationRequestIds.task!]
        : [])
    ];
    try {
      const response = await callReceipt(
        "task-create",
        args,
        true,
        () => assertNativeEffectAllowed(item)
      );
      if (
        retryRequest && response.requestId &&
        response.requestId !== entry.mutationRequestIds.task
      ) {
        return nativeRecovery(entry, "task-create mutation ID 불일치");
      }
      if (!retryRequest && response.requestId) {
        entry = saveNativeLaunch({
          ...entry,
          mutationRequestIds: {
            ...entry.mutationRequestIds,
            task: response.requestId
          }
        });
      }
      const created = response.result;
      const task = object(created.task ?? created);
      if (typeof task.id !== "string" || !task.id.trim()) {
        return nativeRecovery(entry, "Orca Task ID 응답 불명", created);
      }
      entry = saveNativeLaunch({ ...entry, taskId: task.id, phase: "task_created" });
      return workerStart(item, entry);
    } catch (error) {
      if (error instanceof PreSendRejected) throw error.cause;
      const receipt = object((error as { receipt?: unknown }).receipt);
      const errorData = object(receipt.error?.data);
      const responseRequestId = typeof errorData.orchestrationRequestId === "string" && errorData.orchestrationRequestId.trim()
        ? errorData.orchestrationRequestId.trim()
        : null;
      if (responseRequestId) {
        if (entry.mutationRequestIds.task && entry.mutationRequestIds.task !== responseRequestId) {
          return nativeRecovery(entry, "task-create mutation ID 불일치");
        }
        entry = saveNativeLaunch({
          ...entry,
          mutationRequestIds: {
            ...entry.mutationRequestIds,
            task: responseRequestId
          }
        });
      }
      return nativeRecovery(
        entry,
        error instanceof Error ? error.message : "task-create 응답 확인 필요"
      );
    }
  };

  const recoverNativeLaunch = async (
    item: NativeWorkItem,
    project: RelayProject,
    entry: NativeLaunchJournalEntry
  ): Promise<NativeLaunchResult> => {
    if (entry.receipt) return { state: "ready", receipt: entry.receipt };
    if (entry.noLaunchProof) return { state: "proven_no_launch", proof: entry.noLaunchProof };
    if (entry.dispatchId) {
      const observed = await observeNativeDispatch(item, entry);
      if (observed) return observed;
      return nativeRecovery(entry, entry.warning ?? "기존 Dispatch 시작 상태 확인 필요");
    }
    if (entry.taskId && entry.phase === "task_created") return workerStart(item, entry);
    if (entry.taskId) {
      if (!entry.mutationRequestIds.worker) {
        return nativeRecovery(entry, entry.warning ?? "worker-start mutation ID가 없어 결과가 불명확합니다");
      }
      try {
        const requestState = await call("request-show", [
          "--request", entry.mutationRequestIds.worker
        ]);
        if (["completed", "pending"].includes(String(requestState.state))) {
          return workerStart(item, entry, true);
        }
      } catch {
        /* Exact request remains uncertain; never switch mutation identity. */
      }
      return nativeRecovery(entry, entry.warning ?? "worker-start mutation 결과 확인 필요");
    }
    if (entry.phase === "prepared") return taskCreate(item, project, entry);
    if (!entry.mutationRequestIds.task) {
      return nativeRecovery(entry, entry.warning ?? "task-create mutation ID가 없어 결과가 불명확합니다");
    }
    try {
      const requestState = await call("request-show", [
        "--request", entry.mutationRequestIds.task
      ]);
      if (["completed", "pending"].includes(String(requestState.state))) {
        return taskCreate(item, project, entry, true);
      }
    } catch {
      /* Exact request remains uncertain; never create a fresh task mutation. */
    }
    return nativeRecovery(entry, entry.warning ?? "task-create mutation 결과 확인 필요");
  };

  const performNativeStart = async (rawItem: NativeWorkItem): Promise<NativeLaunchResult> => {
    if (closed || closing || !started) throw new Error("Orca relay가 시작되지 않았습니다");
    const item = NativeWorkItemSchema.parse(rawItem);
    const attempt = requireNativeAdmission(item);
    const existing = nativeLaunch(item.attemptId);
    if (existing) {
      if (!isDeepStrictEqual(existing.item, item)) throw new Error("native_launch_collision");
      if (!["launching", "unknown", "active", "settled"].includes(attempt.state)) {
        throw new Error("native_attempt_not_admitted");
      }
      const project = await options.resolveNativeProject?.(item.projectId);
      if (!project) throw new Error("native_project_resolver_required");
      return recoverNativeLaunch(item, project, existing);
    }
    if (attempt.state !== "launching") throw new Error("native_attempt_not_admitted");
    if (!options.nativeRetentionPolicy) throw new Error("native_retention_policy_required");
    const project = await validateNativePlacement(item);
    const reuseEffective = await validateNativeTerminalReuse(item);
    const runId = String(meta().runId ?? "");
    if (!runId) throw new Error("native_run_not_ready");
    const entry = saveNativeLaunch({
      attemptId: item.attemptId,
      item,
      phase: "prepared",
      mutationIntentIds: {
        task: `intent_${randomUUID()}`,
        worker: `intent_${randomUUID()}`
      },
      mutationRequestIds: {
        task: null,
        worker: null
      },
      runId,
      taskId: null,
      dispatchId: null,
      terminalHandle: null,
      terminalSessionId: null,
      worktreeId: item.worktreeId,
      requested: item.profile,
      effective: reuseEffective,
      retentionPolicy: options.nativeRetentionPolicy,
      receipt: null,
      noLaunchProof: null,
      warning: null,
      residualResources: []
    });
    return taskCreate(item, project, entry);
  };

  const startNativeWork = (item: NativeWorkItem): Promise<NativeLaunchResult> => {
    const parsedItem = NativeWorkItemSchema.parse(item);
    const attemptId = parsedItem.attemptId;
    const inFlight = nativeStarts.get(attemptId);
    if (inFlight) {
      if (!isDeepStrictEqual(nativeStartItems.get(attemptId), parsedItem)) {
        return Promise.reject(new Error("native_launch_collision"));
      }
      return inFlight;
    }
    const work = performNativeStart(parsedItem);
    nativeStarts.set(attemptId, work);
    nativeStartItems.set(attemptId, parsedItem);
    void work.then(
      () => {
        if (nativeStarts.get(attemptId) === work) {
          nativeStarts.delete(attemptId);
          nativeStartItems.delete(attemptId);
        }
      },
      () => {
        if (nativeStarts.get(attemptId) === work) {
          nativeStarts.delete(attemptId);
          nativeStartItems.delete(attemptId);
        }
      }
    );
    return work;
  };
  const nativeFence = () => {
    if (closed || closing || !options.nativeAdmission) throw Error("native_admission_required");
    options.assertNativeCoordinator?.();
  };
  const exactNative = (receipt: NativeWorkerReceipt) => {
    nativeFence();
    const entry = nativeLaunch(receipt.attemptId);
    if (!entry?.receipt || !isDeepStrictEqual(entry.receipt, receipt)) throw Error("native_receipt_mismatch");
    return entry;
  };
  const effectRecord = (id: string): Json | undefined => {
    const row = db.prepare("SELECT body FROM orca_relay_meta WHERE id=?").get("native-effect:" + id) as { body: string } | undefined;
    return row ? JSON.parse(row.body) : undefined;
  };
  const saveEffect = (id: string, value: Json) => db.prepare("INSERT OR REPLACE INTO orca_relay_meta VALUES(?,?)").run("native-effect:" + id, JSON.stringify(value));
  const durableNativeEffect = async (id: string, command: string, args: string[], from = true): Promise<Json> => {
    nativeFence();
    let record = effectRecord(id);
    if (record && (record.command !== command || !isDeepStrictEqual(record.args, args))) throw Error("native_effect_collision");
    if (record?.result) return record.result;
    if (record) {
      if (!record.requestId) throw Error("native_effect_recovery_required");
      const observed = await call("request-show", ["--request", record.requestId], true);
      if (!["completed", "pending"].includes(String(observed.state ?? observed.status))) throw Error("native_effect_recovery_required");
    } else { record = { command, args }; saveEffect(id, record); }
    try {
      const response = await callReceipt(command, [...args, ...(record.requestId ? ["--retry-request", record.requestId] : [])], from, nativeFence);
      saveEffect(id, { ...record, requestId: response.requestId, result: response.result });
      return response.result;
    } catch (error) {
      const receipt = object(error).receipt;
      const requestId = receipt?.error?.data?.orchestrationRequestId;
      saveEffect(id, { ...record, ...(typeof requestId === "string" ? { requestId } : {}), recovery: receipt?.error?.data });
      throw error;
    }
  };
  /**
   * The authoritative fleet row for one Dispatch. `worker-list` is scoped to the receipt's own Run and
   * paged; the row is matched by exact Dispatch id, and an exhausted listing means "no proof", never
   * "not running".
   */
  const nativeFleetRow = async (receipt: NativeWorkerReceipt): Promise<Json | undefined> => {
    nativeFence();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await call("worker-list", ["--run", receipt.runId, "--limit", "100", ...(cursor ? ["--cursor", cursor] : [])]);
      const found = rows(result.workers).find(row => row.dispatchId === receipt.dispatchId);
      if (found) return found;
      const next = object(result.page).nextCursor;
      if (typeof next !== "string" || next === "") return undefined;
      cursor = next;
    }
    return undefined;
  };
  const cleanupNative = async (receipt: NativeWorkerReceipt, policy: NativeRetentionPolicy): Promise<{ verdict: WorkerResourceVerdict; recovery?: unknown }> => {
    const entry = exactNative(receipt);
    const observed = await call("worker-show", ["--dispatch", receipt.dispatchId]);
    nativeFence();
    const resource = object(observed.terminalResource);
    if (observed.dispatch?.id !== receipt.dispatchId || observed.dispatch?.task_id !== receipt.taskId ||
      resource.terminalHandle !== receipt.terminalHandle || resource.ownerDispatchId !== receipt.dispatchId) return { verdict: "unknown", recovery: observed };
    if (resource.releaseState === "released") return { verdict: "released" };
    if (!["owned", "retained"].includes(String(resource.ownershipState))) return { verdict: "unknown", recovery: observed };
    if (observed.observation?.exactWorker !== true || observed.terminal?.handle !== receipt.terminalHandle ||
      (observed.terminal?.incarnationId ?? observed.terminal?.ptyId) !== entry.terminalSessionId) return { verdict: "unknown", recovery: observed };
    // Only the accepted result's exact settled Dispatch can authorize cleanup.
    if (!["worker_done", "completed", "succeeded", "failed", "stopped"].includes(String(observed.dispatch?.state ?? observed.dispatch?.status))) return { verdict: "unknown", recovery: observed };
    try {
      if (policy === "retain") {
        if (resource.releaseState !== "retained") await durableNativeEffect(`retain:${receipt.dispatchId}`, "worker-retain", ["--dispatch", receipt.dispatchId], false);
        const idle = object(await run(["terminal", "wait", "--terminal", receipt.terminalHandle, "--for", "tui-idle", "--timeout-ms", "1000", "--json"]));
        nativeFence();
        if (idle.ok !== true) return { verdict: "unknown", recovery: idle.result };
        const retained = await call("worker-show", ["--dispatch", receipt.dispatchId]);
        if (retained.terminalResource?.releaseState !== "retained" || retained.terminalResource?.ownerDispatchId !== receipt.dispatchId ||
          retained.terminal?.handle !== receipt.terminalHandle || (retained.terminal?.incarnationId ?? retained.terminal?.ptyId) !== entry.terminalSessionId) return { verdict: "unknown", recovery: retained };
        return { verdict: "retained_idle" };
      }
      const result = await durableNativeEffect(`release:${receipt.dispatchId}`, "worker-release", ["--dispatch", receipt.dispatchId], false);
      if (result.state === "released" && (!result.dispatchId || result.dispatchId === receipt.dispatchId)) return { verdict: "released" };
      return { verdict: "unknown", recovery: result };
    } catch (error) { return { verdict: "unknown", recovery: object(error).receipt ?? effectRecord(`${policy}:${receipt.dispatchId}`) }; }
  };
  const parseDelivery = (result: Json): NativeDelivery | undefined => {
    if (!result.deliveryId) return undefined;
    if (typeof result.runId !== "string" || !Array.isArray(result.messages)) throw Error("native_delivery_invalid");
    return { runId: result.runId, deliveryId: result.deliveryId, messages: result.messages.map((raw: Json): NativeMessage => {
      const payload = typeof raw.payload === "string" ? object(JSON.parse(raw.payload)) : object(raw.payload);
      return { id: String(raw.id), type: String(raw.type), body: redactRelayText(String(raw.body ?? "")),
        ...(typeof payload.taskId === "string" ? { taskId: payload.taskId } : {}),
        ...(typeof payload.dispatchId === "string" ? { dispatchId: payload.dispatchId } : {}),
        ...(payload.outcome ? { outcome: payload.outcome } : {}),
        ...(Array.isArray(payload.fanout) ? { fanout: payload.fanout } : {}) };
    }) };
  };
  return {
    submit: (...args: Parameters<typeof submit>) => options.nativeOnly ? Promise.reject(Error("native_admission_required")) : submit(...args),
    list,
    get,
    applyLegacyCompletionPolicy,
    startNativeWork,
    getNativeLaunch: (attemptId: string): NativeLaunchJournalEntry => {
      const entry = nativeLaunch(attemptId);
      if (!entry) throw new Error("native_launch_not_found");
      return structuredClone(entry);
    },
    getCached,
    listActiveCached: (): NativeJob[] =>
      (
        db
          .prepare(
            "SELECT body FROM orca_relay_snapshots WHERE json_extract(body,'$.state') IN ('queued','running','recovery_required')",
          )
          .all() as { body: string }[]
      ).map((row) => JSON.parse(row.body) as NativeJob),
    listCached: (): NativeJob[] =>
      (
        db
          .prepare(
            "SELECT body FROM orca_relay_snapshots ORDER BY rowid DESC LIMIT 20",
          )
          .all() as { body: string }[]
      ).map((row) => JSON.parse(row.body) as NativeJob),
    followup: (...args: Parameters<typeof followup>) => options.nativeOnly ? Promise.reject(Error("native_admission_required")) : followup(...args),
    stop,
    retry: (...args: Parameters<typeof retry>) => options.nativeOnly ? Promise.reject(Error("native_admission_required")) : retry(...args),
    cleanupNative,
    /**
     * Read-only liveness proof for one exact owned Dispatch. A bound receipt only proves the launch
     * happened, and a connected PTY is not evidence of a live agent: `worker-show`'s
     * `observation.status` is terminal liveness only, while `worker-list`'s `projection.liveness` is
     * the authoritative fleet verdict for the agent itself. Restart therefore restores guidance only
     * when the receipt still exactly owns its terminal resource in both views **and** that verdict is
     * `live`. An `exited`/`unverifiable`/absent verdict, a missing row, a foreign owner or
     * incarnation, and a retained/released/settled Dispatch all report `live: false`, which keeps the
     * slot occupied rather than relaunching or releasing on ambiguous evidence.
     */
    async observeNativeWorker(receipt: NativeWorkerReceipt) {
      let entry: NativeLaunchJournalEntry;
      try { entry = exactNative(receipt); } catch (error) { return { live: false, recovery: object(error).receipt }; }
      const observed = await call("worker-show", ["--dispatch", receipt.dispatchId]);
      nativeFence();
      const resource = object(observed.terminalResource);
      // Exact ownership first: without it the fleet verdict below describes somebody else's worker.
      const owned = observed.dispatch?.id === receipt.dispatchId && observed.dispatch?.task_id === receipt.taskId &&
        resource.terminalHandle === receipt.terminalHandle && resource.ownerDispatchId === receipt.dispatchId &&
        resource.ownershipState === "owned" && resource.releaseState !== "released" && resource.releaseState !== "retained" &&
        observed.observation?.exactWorker === true && observed.terminal?.handle === receipt.terminalHandle &&
        observed.terminal?.connected === true &&
        (observed.terminal?.incarnationId ?? observed.terminal?.ptyId) === entry.terminalSessionId &&
        !["worker_done", "completed", "succeeded", "failed", "stopped"].includes(String(observed.dispatch?.state ?? observed.dispatch?.status));
      if (!owned) return { live: false, recovery: observed };
      const projected = await nativeFleetRow(receipt);
      nativeFence();
      if (!projected) return { live: false, recovery: observed };
      const fleetResource = object(projected.resource);
      const liveness = object(object(projected.projection).liveness);
      // The authoritative agent verdict, read from a row that must still name this exact receipt.
      const live = projected.taskId === receipt.taskId && projected.runId === receipt.runId &&
        projected.agentTerminalHandle === receipt.terminalHandle &&
        fleetResource.ownerDispatchId === receipt.dispatchId && fleetResource.ownershipState === "owned" &&
        projected.terminalState === "active" && liveness.verdict === "live";
      return live ? { live: true } : { live: false, recovery: { observed, projected } };
    },
    async stopNative(receipt: NativeWorkerReceipt) {
      exactNative(receipt);
      try { await durableNativeEffect(`stop:${receipt.dispatchId}`, "worker-stop", ["--dispatch", receipt.dispatchId], false); }
      catch { /* A lost response requires an exact read, never another new stop mutation. */ }
      const observed = await call("worker-show", ["--dispatch", receipt.dispatchId]);
      return observed.dispatch?.id === receipt.dispatchId && observed.dispatch?.task_id === receipt.taskId &&
        (observed.dispatch?.status === "stopped" || observed.worker?.state === "stopped");
    },
    async checkDelivery() {
      nativeFence();
      const handle = await coordinator();
      return parseDelivery(await call("check", ["--terminal", handle, "--run", String(meta().runId)], false));
    },
    async acknowledgeDelivery(delivery: NativeDelivery) {
      nativeFence();
      if (delivery.runId !== meta().runId) throw Error("native_delivery_run_mismatch");
      const handle = await coordinator();
      await callReceipt("check", ["--terminal", handle, "--run", delivery.runId, "--ack", delivery.deliveryId], false, nativeFence);
      // check may return the next batch; it remains unacknowledged and is replayed by the next check.
    },
    async sendNativeGuidance(receipt: NativeWorkerReceipt, text: string, id: string) {
      exactNative(receipt); protectPrompt(text);
      const project = await options.resolveNativeProject!(receipt.worktreeId.slice(0, receipt.worktreeId.indexOf("::")));
      const result = await durableNativeEffect(`guidance:${id}`, "send", ["--run", receipt.runId, "--to", `dispatch:${receipt.dispatchId}`, "--type", "status", "--subject", "HQ 후속 지시", "--body", taskSpec(project, text)]);
      const messageId = result.message?.id ?? result.messageId ?? result.id;
      if (typeof messageId !== "string") throw Error("native_message_receipt_unknown");
      return { messageId };
    },
    async replyNativeQuestion(receipt: NativeWorkerReceipt, messageId: string, text: string, id: string) {
      exactNative(receipt); protectPrompt(text);
      await durableNativeEffect(`reply:${id}`, "reply", ["--id", messageId, "--body", text]);
      return { messageId };
    },
    isBusy: async (projectId: string) =>
      (await list()).some(
        (j) =>
          j.projectId === projectId &&
          ["queued", "running", "recovery_required"].includes(j.state),
      ),
    start: async () => {
      if (started) return;
      await ensureRun();
      started = true;
      for (const r of requests()) {
        if (r.phase === "task_created") background(r);
        else if (r.taskId) {
          if (r.phase === "worker_sent") {
            r.phase = "unknown";
            r.unknownAfterRestart = true;
            r.warning =
              "Orca worker-start 결과 확인 필요. 자동 재실행하지 않습니다.";
            saveRequest(r);
            try {
              const unknown = {
                ...getCached(r.taskId),
                state: "recovery_required" as const,
                nativeStatus:
                  r.kind === "retry"
                    ? "retry_outcome_unknown"
                    : "worker_start_outcome_unknown",
                relayWarning: r.warning,
              };
              delete unknown.dispatchId;
              save(unknown);
            } catch {
              /* The durable request record still carries unknown ownership. */
            }
          }
          try {
            await get(r.taskId);
            await applyLegacyCompletionPolicy(r.taskId);
          } catch {
            /* native reconciliation only */
          }
        } else if (r.phase === "unknown" || r.phase === "task_sent") {
          const tasks = await call("task-list", [
            "--run",
            String(meta().runId),
          ]);
          const matches = rows(tasks.tasks).filter((t) =>
            String(t.spec).startsWith(`[HQ request ${r.id}]\n`),
          );
          if (matches.length === 1) {
            r.taskId = String(matches[0]!.id);
            r.phase = "task_created";
            saveRequest(r);
            background(r);
          }
        }
      }
      poll = setInterval(() => {
        if (polling || closed) return;
        polling = true;
        pollWork = (async () => {
          for (const r of requests())
            if (r.taskId) {
              try {
                await get(r.taskId);
                await applyLegacyCompletionPolicy(r.taskId);
              } catch {
                /* runtime offline does not alter native state */
              }
            }
        })().finally(() => {
          polling = false;
        });
      }, options.pollIntervalMs ?? 5000);
      poll.unref();
    },
    close: async () => {
      if (closed) return;
      if (poll) clearInterval(poll);
      closing = true;
      cancellation.abort();
      await serial;
      await Promise.allSettled([
        ...pending,
        ...nativeStarts.values(),
        ...guidanceRequests.values(),
        ...(pollWork ? [pollWork] : []),
      ]);
      closed = true;
      db.close();
    },
  };
}
export type OrcaRelay = ReturnType<typeof createOrcaRelay>;
