import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { openDatabase } from "@orca-hq/persistence";
export interface RelayProject {
  id: string;
  name: string;
  absolutePath: string;
  sensitivePaths: readonly string[];
  setupPolicy: string;
  defaultBaseRef?: string;
}
export interface NativeJob {
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
export interface OrcaRelayOptions {
  databasePath: string;
  coordinatorHandle: string;
  onUpdate?: (job: NativeJob) => void | Promise<void>;
  run?: (argv: readonly string[]) => Promise<unknown>;
  pollIntervalMs?: number;
}
type Json = Record<string, any>;
interface RequestRecord {
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
  return `필수 보호 규칙: ${protectedRelative} 및 ${join(homedir(), "Project/ETC/orca-hq", protectedRelative)} 파일은 읽기·hash·diff·stage·restore·수정 대상에서 제외합니다. 해당 파일을 포함할 수 있는 광범위 Git/파일 명령도 실행하지 마세요.\n프로젝트 민감 경로(내용이 아닌 경로 규칙): ${JSON.stringify(project.sensitivePaths)}. 비밀 값을 읽거나 결과/로그에 출력하지 마세요.\n작업은 Orca가 지정한 작업 공간에서 수행하고 native Dispatch의 worker_done 규칙을 따르세요.\n\n사용자 지시:\n${prompt}`;
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
async function runOrca(argv: readonly string[]): Promise<unknown> {
  const env: NodeJS.ProcessEnv = {};
  for (const k of [
    "HOME",
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "USER",
    "LOGNAME",
    "SHELL",
  ])
    if (process.env[k] !== undefined) env[k] = process.env[k];
  try {
    const r = await exec("orca", [...argv], {
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
    "CREATE TABLE IF NOT EXISTS orca_relay_requests(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS orca_relay_snapshots(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS orca_relay_meta(id TEXT PRIMARY KEY,body TEXT NOT NULL)",
  );
  const run = options.run ?? runOrca;
  let closed = false;
  let closing = false;
  let started = false;
  let poll: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let pollWork: Promise<void> | undefined;
  let serial = Promise.resolve();
  const pending = new Set<Promise<void>>();
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
  const call = async (
    command: string,
    args: string[] = [],
    from = false,
  ): Promise<Json> => {
    const receipt = object(
      await run([
        "orchestration",
        command,
        ...args,
        ...(from ? ["--from", options.coordinatorHandle] : []),
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
    return object(receipt.result);
  };
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
    let m = meta();
    if (
      m.coordinatorHandle &&
      m.coordinatorHandle !== options.coordinatorHandle
    )
      throw Error("저장된 Orca coordinator와 현재 handle이 다릅니다");
    if (m.runId) return String(m.runId);
    if (m.phase === "sent") {
      const found = (await allRuns()).find((r) => r.objective === m.objective);
      if (!found)
        throw Error("Orca Run 생성 응답 불명: 기존 Run을 확인해야 합니다");
      m.runId = found.id;
      saveMeta(m);
      return String(m.runId);
    }
    m = {
      coordinatorHandle: options.coordinatorHandle,
      objective: `Orca HQ relay ${randomUUID()}`,
      phase: "sent",
    };
    saveMeta(m);
    const r = await call("run-create", ["--objective", m.objective], true);
    const id = r.run?.id ?? r.runId ?? r.id;
    if (typeof id !== "string") throw Error("Orca Run ID 응답 불명");
    m.runId = id;
    m.phase = "observed";
    saveMeta(m);
    return id;
  };
  const owner = (id: string) =>
    requests().find((r) => r.taskId === id && r.kind !== "followup") ??
    requests().find((r) => r.taskId === id && r.phase !== "message_sent");
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
    const result = parsed(task.result);
    let prior: Partial<NativeJob> = {};
    try {
      prior = getCached(String(task.id));
    } catch {
      /* first observation */
    }
    delete prior.relayWarning;
    return {
      ...prior,
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
        requests().some(
          (r) => r.launchOwned === true && r.dispatchId === job.dispatchId,
        ) &&
        ["succeeded", "failed"].includes(worker.state) &&
        !observed.terminalResource?.retainedReason &&
        observed.terminalResource?.releaseState !== "retained" &&
        observed.terminalResource?.releaseState !== "released"
      ) {
        try {
          const cleanup = await call("worker-release", [
            "--dispatch",
            job.dispatchId,
          ]);
          if (
            ["release_pending", "release_unknown"].includes(
              String(cleanup.state),
            )
          )
            job.relayWarning = `Orca 작업자 정리 확인 필요: ${cleanup.state}`;
        } catch (error) {
          job.relayWarning = `Orca 작업은 완료되었으며 작업자 정리 확인이 필요합니다: ${redactRelayText(error instanceof Error ? error.message : "unknown")}`;
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
      r.phase = "worker_sent";
      saveRequest(r);
      try {
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
            "inherit",
          );
          if (r.project.defaultBaseRef)
            args.push("--base-branch", r.project.defaultBaseRef);
        }
        if (r.retryOf) args.push("--retry-of", r.retryOf);
        const receipt = await call("worker-start", args, true);
        r.dispatchId = String(receipt.dispatchId ?? "");
        r.launchOwned = Boolean(r.dispatchId);
        r.phase = "observed";
        if (!closed) {
          saveRequest(r);
          await get(r.taskId!);
        }
      } catch (error) {
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
  const create = async (
    input: {
      requestId: string;
      project: RelayProject;
      prompt: string;
      worktree?: string;
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
  }) => serialized(() => create(input));
  const followup = (id: string, prompt: string, requestId: string) =>
    serialized(async () => {
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
      if (!job.worktreeId)
        throw Error("Orca 작업 공간 확인 후 후속 작업을 시작할 수 있습니다");
      return create(
        {
          requestId,
          project: projectFor(job),
          prompt: `원래 Orca 작업 ${id}의 후속 지시:\n${prompt}`,
        },
        {
          kind: "followup",
          worktreeId: job.worktreeId,
          ...(job.runId === meta().runId ? { parentId: id } : {}),
        },
      );
    });
  const stop = async (id: string) => {
    const job = await get(id);
    if (!job.dispatchId)
      throw Error("이 작업에는 중지할 native Dispatch가 없습니다");
    await call("worker-stop", ["--dispatch", job.dispatchId]);
    return get(id);
  };
  const retry = (id: string, requestId: string) =>
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
        project: projectFor(job),
        prompt: job.prompt,
        taskId: id,
        phase: "task_created",
        retryOf: job.dispatchId,
        worktreeId: job.worktreeId,
      };
      saveRequest(r);
      background(r);
      return job;
    });
  return {
    submit,
    list,
    get,
    getCached,
    listCached: (): NativeJob[] => (db.prepare("SELECT body FROM orca_relay_snapshots ORDER BY rowid DESC LIMIT 20").all() as {body:string}[]).map(row => JSON.parse(row.body) as NativeJob),
    followup,
    stop,
    retry,
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
          try {
            await get(r.taskId);
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
      await serial;
      await Promise.allSettled([...pending, ...(pollWork ? [pollWork] : [])]);
      closed = true;
      db.close();
    },
  };
}
export type OrcaRelay = ReturnType<typeof createOrcaRelay>;
