import { z } from "zod";
import type { NativeExecutionOwnership } from "./orca-relay.js";

export interface CommandProject {
  id: string;
  name: string;
  absolutePath: string;
  aliases: readonly string[];
  enabled: boolean;
  sensitivePaths: readonly string[];
  setupPolicy: "run" | "skip" | "inherit";
  defaultBaseRef?: string;
}
export interface CommandJob {
  dispatchId?: string;
  execution?: NativeExecutionOwnership;
  id: string;
  projectId: string;
  projectName: string;
  prompt: string;
  state: string;
  nativeStatus?: string;
  relayWarning?: string;
  project?: { absolutePath: string };
  worktreePath?: string;
  result?: { summary: string; modifiedFiles: string[]; validation: string[] };
  createdAt: string;
  updatedAt: string;
}
export interface ManagedCommandPorts {
  catalog: {
    list(): Promise<CommandProject[]>;
    resolve(selector: string): Promise<CommandProject>;
    add(path: string): Promise<CommandProject>;
    alias(selector: string, alias: string): Promise<void>;
    setEnabled(selector: string, enabled: boolean): Promise<void>;
  };
  observe?: (
    project: CommandProject,
    intent: "status" | "review",
  ) => Promise<string>;
  jobs: {
    list(): CommandJob[] | Promise<CommandJob[]>;
    get(id: string): CommandJob | Promise<CommandJob>;
    submit(input: {
      requestId: string;
      project: CommandProject;
      prompt: string;
      worktree?: string;
      execution?: NativeExecutionOwnership;
    }): Promise<CommandJob>;
    stop(id: string): Promise<CommandJob>;
    retry(
      id: string,
      requestId: string,
      execution?: NativeExecutionOwnership,
    ): Promise<CommandJob>;
    followup(
      id: string,
      prompt: string,
      requestId: string,
      execution?: NativeExecutionOwnership,
    ): Promise<CommandJob>;
  };
}
export interface ManagedCommandInput {
  id: string;
  text: string;
  source: "slack" | "telegram" | "terminal";
  userId: string;
  contextJobId?: string;
  conversationId?: string;
  sessionId?: string;
  signal?: AbortSignal;
  onProgress?: (text: string) => Promise<void>;
  onThread?: (threadId: string) => void;
  onToolEvent?: (
    name: string,
    phase: "started" | "completed" | "failed",
    callId: string,
  ) => void;
  execution?: {
    contextId: string;
    requestId: string;
    generation: number;
    assertActive(): void;
    reserve(
      resources: Array<{ resourceKey: string; mode: "read" | "write" }>,
      signal?: AbortSignal,
    ): Promise<void>;
    markNativeAttempt?(): void;
    beforeNative(jobId?: string): Promise<void>;
    onNative(jobId: string): Promise<void>;
  };
}
export interface ManagedCommandResult {
  text: string;
  state?: "completed" | "failed" | "recovery_required";
  jobId?: string;
  jobIds?: string[];
  projectId?: string;
}
const short = z.string().trim().min(1).max(512),
  prompt = z.string().trim().min(1).max(8000);
const ActionSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.enum(["projects.list", "projects.sync", "jobs.list"]) })
    .strict(),
  z.object({ action: z.literal("projects.add"), path: short }).strict(),
  z
    .object({
      action: z.literal("projects.alias"),
      project: short,
      alias: short,
    })
    .strict(),
  z
    .object({
      action: z.enum([
        "projects.exclude",
        "projects.restore",
        "projects.activity",
        "projects.review",
      ]),
      project: short,
    })
    .strict(),
  z
    .object({
      action: z.literal("jobs.run"),
      project: short,
      prompt,
      worktree: short.optional(),
    })
    .strict(),
  z
    .object({
      action: z.enum(["jobs.show", "jobs.stop", "jobs.retry"]),
      jobId: short,
    })
    .strict(),
  z
    .object({ action: z.literal("jobs.followup"), jobId: short, prompt })
    .strict(),
]);
type Action = z.infer<typeof ActionSchema>;
const help =
  "프로젝트 목록 · 프로젝트 등록 /절대/경로 · 프로젝트 <이름> 제외/복원 · <프로젝트명> <작업 지시> · 작업 목록 · 작업 <ID> 상태/중지/재시도 · 작업 <ID> 이어서 <지시>";
export function formatManagedJob(job: CommandJob): string {
  const labels: Record<string, string> = {
    queued: "대기",
    running: "실행 중",
    succeeded: "완료",
    failed: "실패",
    stopped: "중지",
    recovery_required: "복구 확인 필요",
  };
  return [
    `작업 ${job.id} · ${job.projectName} · ${labels[job.state] ?? job.state}${job.nativeStatus ? ` (Orca: ${job.nativeStatus})` : ""}`,
    job.worktreePath ? `작업 위치: ${job.worktreePath}` : "",
    job.relayWarning ? `Orca 전달 상태: ${job.relayWarning}` : "",
    job.result?.summary ?? "",
    job.result?.modifiedFiles.length
      ? `변경 파일: ${job.result.modifiedFiles.join(", ")}`
      : "",
    job.result?.validation.length
      ? `검증: ${job.result.validation.join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 14000);
}
async function natural(
  text: string,
  ports: ManagedCommandPorts,
): Promise<Action | undefined> {
  if (
    /^(?:\/?projects|프로젝트\s*(?:목록|리스트)|등록된 프로젝트|오르카.*프로젝트 목록)/iu.test(
      text,
    )
  )
    return { action: "projects.list" };
  if (/^(?:프로젝트\s*)?동기화(?:해줘)?$/u.test(text))
    return { action: "projects.sync" };
  let match = text.match(/^(?:프로젝트\s*)?등록\s+(\/[^\n]+)$/u);
  if (match) return { action: "projects.add", path: match[1]!.trim() };
  match = text.match(/^프로젝트\s+(.+?)\s+(제외|복원)(?:해줘)?$/u);
  if (match)
    return {
      action: match[2] === "제외" ? "projects.exclude" : "projects.restore",
      project: match[1]!,
    };
  match = text.match(/^프로젝트\s+(.+?)\s+별칭\s+(.+)$/u);
  if (match)
    return { action: "projects.alias", project: match[1]!, alias: match[2]! };
  if (/^(?:작업 목록|\/?jobs)$/u.test(text)) return { action: "jobs.list" };
  match = text.match(/^작업\s+(\S+)\s+(상태|중지|재시도)(?:해줘)?$/u);
  if (match)
    return {
      action:
        match[2] === "상태"
          ? "jobs.show"
          : match[2] === "중지"
            ? "jobs.stop"
            : "jobs.retry",
      jobId: match[1]!,
    };
  match = text.match(/^작업\s+(\S+)\s+이어서\s+([\s\S]+)$/u);
  if (match)
    return { action: "jobs.followup", jobId: match[1]!, prompt: match[2]! };
  const projects = await ports.catalog.list();
  const matched = projects.filter((p) =>
    [p.id, p.name, ...p.aliases].some(
      (a) =>
        text === a ||
        text.startsWith(a + " ") ||
        text.startsWith(a + "에서 ") ||
        text.startsWith(a + "의 "),
    ),
  );
  if (matched.length > 1)
    throw new Error("프로젝트 이름이 겹칩니다. 프로젝트 ID로 지정해주세요.");
  if (matched.length === 1) {
    if (/진행 상황|진행 상태|진행률|어디까지|현재 작업|작업 상태/u.test(text))
      return { action: "projects.activity", project: matched[0]!.id };
    if (/(?:현재|기존|변경된).*검토/u.test(text))
      return { action: "projects.review", project: matched[0]!.id };
    const selected = text.match(/작업공간\s+(\S+)\s+([\s\S]+)/u);
    return {
      action: "jobs.run",
      project: matched[0]!.id,
      prompt: text,
      ...(selected ? { worktree: selected[1]! } : {}),
    };
  }
  return undefined;
}
export function createManagedCommands(ports: ManagedCommandPorts) {
  const checkCurrent = async (id: string) => {
    const job = await ports.jobs.get(id);
    const project = await ports.catalog.resolve(job.projectId);
    if (!project.enabled)
      throw new Error("HQ 사용에서 제외된 프로젝트입니다. 먼저 복원해주세요.");
    if (job.project && project.absolutePath !== job.project.absolutePath)
      throw new Error(
        "프로젝트 경로가 변경됐습니다. 현재 프로젝트에서 새 작업을 시작해주세요.",
      );
  };
  return {
    async execute(input: ManagedCommandInput): Promise<ManagedCommandResult> {
      short.parse(input.id);
      const text = prompt.parse(input.text);
      if (/^\/(?:start|help)(?:@\w+)?$/u.test(text) || text === "도움말")
        return { text: help };
      const decoded = text.startsWith("/hq ")
        ? JSON.parse(text.slice(4))
        : await natural(text, ports);
      if (decoded === undefined) {
        if (input.contextJobId) {
          await checkCurrent(input.contextJobId);
          const job = await ports.jobs.followup(
            input.contextJobId,
            text,
            input.id,
          );
          return {
            text: formatManagedJob(job),
            jobId: job.id,
            projectId: job.projectId,
          };
        }
        return {
          text: `대상 프로젝트를 먼저 적어주세요. 예: subway-seet 로그인 오류 고치고 테스트해줘\n${help}`,
        };
      }
      const action = ActionSchema.parse(decoded);
      const execution = input.execution
        ? {
            contextId: input.execution.contextId,
            requestId: input.execution.requestId,
            generation: input.execution.generation,
          }
        : undefined;
      switch (action.action) {
        case "projects.list":
        case "projects.sync": {
          const rows = await ports.catalog.list();
          return {
            text: rows.length
              ? rows
                  .map(
                    (p) =>
                      `${p.name} [${p.id}]${p.enabled ? "" : " (사용 제외)"}`,
                  )
                  .join("\n")
              : "Orca에 등록된 프로젝트가 없습니다. 프로젝트 등록 /절대/경로 로 추가하세요.",
          };
        }
        case "projects.activity":
        case "projects.review": {
          const project = await ports.catalog.resolve(action.project);
          if (!project.enabled)
            throw new Error(
              "HQ 사용에서 제외된 프로젝트입니다. 먼저 복원해주세요.",
            );
          return {
            projectId: project.id,
            text: ports.observe
              ? await ports.observe(
                  project,
                  action.action === "projects.review" ? "review" : "status",
                )
              : "Orca 작업 조회 연결을 확인해주세요.",
          };
        }
        case "projects.add": {
          const p = await ports.catalog.add(action.path);
          return {
            projectId: p.id,
            text: `프로젝트 등록: ${p.name} [${p.id}]`,
          };
        }
        case "projects.alias":
          await ports.catalog.alias(action.project, action.alias);
          return { text: `별칭 저장: ${action.alias}` };
        case "projects.exclude":
        case "projects.restore":
          await ports.catalog.setEnabled(
            action.project,
            action.action === "projects.restore",
          );
          return {
            text:
              action.action === "projects.restore"
                ? "HQ 사용을 복원했습니다."
                : "HQ 사용에서 제외했습니다. 저장소 파일과 Orca 등록은 유지됩니다.",
          };
        case "jobs.list": {
          const all = await ports.jobs.list();
          const recent = [...all]
            .sort(
              (a, b) =>
                (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0),
            )
            .slice(0, 20);
          return {
            text: (
              `Orca 작업 ${all.length}개 (최근 최대 20개)\n` +
              recent.map(formatManagedJob).join("\n\n")
            ).slice(0, 14000),
          };
        }
        case "jobs.run": {
          const project = await ports.catalog.resolve(action.project);
          if (!project.enabled)
            throw new Error(
              "HQ 사용에서 제외된 프로젝트입니다. 먼저 복원해주세요.",
            );
          const job = await ports.jobs.submit({
            requestId: input.id,
            project,
            prompt: action.prompt,
            ...(execution ? { execution } : {}),
            ...(action.worktree ? { worktree: action.worktree } : {}),
          });
          return {
            text: formatManagedJob(job),
            jobId: job.id,
            projectId: job.projectId,
          };
        }
        case "jobs.show": {
          const job = await ports.jobs.get(action.jobId);
          return {
            text: formatManagedJob(job),
            jobId: job.id,
            projectId: job.projectId,
          };
        }
        case "jobs.stop": {
          const job = await ports.jobs.stop(action.jobId);
          return {
            text: formatManagedJob(job),
            jobId: job.id,
            projectId: job.projectId,
          };
        }
        case "jobs.retry": {
          await checkCurrent(action.jobId);
          const job = await ports.jobs.retry(
            action.jobId,
            input.id,
            ...(execution ? [execution] : []),
          );
          return {
            text: formatManagedJob(job),
            jobId: job.id,
            projectId: job.projectId,
          };
        }
        case "jobs.followup": {
          await checkCurrent(action.jobId);
          const job = await ports.jobs.followup(
            action.jobId,
            action.prompt,
            input.id,
            ...(execution ? [execution] : []),
          );
          return {
            text: formatManagedJob(job),
            jobId: job.id,
            projectId: job.projectId,
          };
        }
      }
    },
  };
}
