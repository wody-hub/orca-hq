import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const COMMAND_TIMEOUT_MS = 10_000;
const COMMAND_OUTPUT_LIMIT = 512 * 1024;
const MAX_WORKTREES = 50;
const MAX_TERMINALS_PER_WORKTREE = 20;
const MAX_TERMINAL_READS = 20;
const MAX_RECENT_LINES = 6;
const MAX_LINE_LENGTH = 300;

export interface ObservedProject {
  readonly id: string;
  readonly name: string;
  readonly absolutePath: string;
  readonly sensitivePaths: readonly string[];
}

export type ObserveIntent = "status" | "review";

export interface OrcaRunOptions {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export type OrcaObserverRun = (
  command: string,
  args: readonly string[],
  options: OrcaRunOptions
) => Promise<string | Readonly<{ stdout: string }>>;

export interface OrcaObserver {
  observe(project: ObservedProject, intent: ObserveIntent): Promise<string>;
}

export interface CreateOrcaObserverOptions {
  readonly run?: OrcaObserverRun;
  /** Retained for composition compatibility. Native Orca state is formatted directly. */
  readonly summarize?: (input: unknown) => Promise<string>;
}

interface NativeWorktree {
  readonly id: string;
  readonly identity?: string;
  readonly path: string;
  readonly name?: string;
  readonly branch?: string;
  readonly status?: string;
  readonly lastActivityAt?: string;
}

interface NativeTerminal {
  readonly handle: string;
  readonly title?: string;
  readonly status?: string;
  readonly updatedAt?: string;
}

interface WorktreeObservation extends NativeWorktree {
  readonly terminals: readonly NativeTerminal[];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function sanitize(value: string): string {
  return value
    .replace(/-----BEGIN [^-\r\n]+PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]+PRIVATE KEY-----/gi, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|(?:xox[baprs]|xapp)-[A-Za-z0-9-]+|gh[opusr]_[A-Za-z0-9_]{20,}|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, "[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization|cookie)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[REDACTED]")
    .replace(/https?:\/\/[^\s<>()]+/gi, "[REDACTED_URL]");
}

function safeField(value: unknown, fallback: string): string {
  return sanitize(text(value) ?? fallback).slice(0, MAX_LINE_LENGTH);
}

function isProtectedProject(project: ObservedProject): boolean {
  const normalized = project.absolutePath.replaceAll("\\", "/").replace(/\/+$/, "");
  const protectedInstallation = [
    "/Project/ETC/orca-hq",
    "/orca/workspaces/orca-hq",
    "/Applications/orca-hq"
  ].some(fragment => normalized.endsWith(fragment) || normalized.includes(`${fragment}/`));
  return protectedInstallation || project.sensitivePaths.some(path => /(?:^|[/_-])roadmap(?:[./_-]|$)/i.test(path));
}

async function defaultRun(
  command: string,
  args: readonly string[],
  options: OrcaRunOptions
): Promise<string> {
  const { stdout } = await execute(command, [...args], {
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: options.maxOutputBytes
  });
  return stdout;
}

function receiptResult(raw: string | Readonly<{ stdout: string }>): Record<string, unknown> {
  const output = typeof raw === "string" ? raw : raw.stdout;
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Orca 상태 응답을 확인할 수 없습니다");
  }
  const envelope = record(parsed);
  if (envelope === undefined || envelope.ok !== true) {
    throw new Error("Orca 상태 응답을 확인할 수 없습니다");
  }
  const result = record(envelope.result);
  if (result === undefined) throw new Error("Orca 상태 응답을 확인할 수 없습니다");
  return result;
}

function arrayField(result: Record<string, unknown>, field: string): readonly unknown[] {
  const value = result[field];
  if (!Array.isArray(value)) throw new Error("Orca 상태 응답을 확인할 수 없습니다");
  return value;
}

function parseWorktrees(result: Record<string, unknown>): NativeWorktree[] {
  return arrayField(result, "worktrees").map(value => {
    const item = record(value);
    const id = text(item?.id) ?? text(item?.worktreeId);
    const path = text(item?.path) ?? text(item?.worktreePath);
    if (item === undefined || id === undefined || path === undefined) {
      throw new Error("Orca 상태 응답을 확인할 수 없습니다");
    }
    return {
      id,
      path,
      ...(text(item.identity) === undefined ? {} : { identity: text(item.identity)! }),
      ...(text(item.displayName) === undefined ? {} : { name: text(item.displayName)! }),
      ...(text(item.branch) === undefined ? {} : { branch: text(item.branch)! }),
      ...(text(item.workspaceStatus) === undefined ? {} : { status: text(item.workspaceStatus)! }),
      ...(text(item.lastActivityAt) === undefined ? {} : { lastActivityAt: text(item.lastActivityAt)! })
    };
  });
}

function parseTerminals(result: Record<string, unknown>): NativeTerminal[] {
  return arrayField(result, "terminals").map(value => {
    const item = record(value);
    const handle = text(item?.handle) ?? text(item?.id);
    if (item === undefined || handle === undefined) {
      throw new Error("Orca 상태 응답을 확인할 수 없습니다");
    }
    return {
      handle,
      ...(text(item.title) === undefined ? {} : { title: text(item.title)! }),
      ...(text(item.status) === undefined ? {} : { status: text(item.status)! }),
      ...(text(item.updatedAt) === undefined ? {} : { updatedAt: text(item.updatedAt)! })
    };
  });
}

function recentLines(result: Record<string, unknown>): string[] {
  const candidate = result.tail ?? result.lines ?? result.output ?? result.text;
  const values = Array.isArray(candidate) ? candidate : typeof candidate === "string" ? candidate.split(/\r?\n/) : [];
  return values
    .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    .slice(-MAX_RECENT_LINES)
    .map(value => sanitize(value.trim()).slice(0, MAX_LINE_LENGTH));
}

function worktreeSelector(worktree: NativeWorktree): string {
  return worktree.identity === undefined ? `path:${worktree.path}` : `identity:${worktree.identity}`;
}

function worktreeMetadata(item: WorktreeObservation): string {
  const fields = [
    `ID ${safeField(item.id, "알 수 없음")}`,
    `경로 ${safeField(item.path, "알 수 없음")}`,
    `브랜치 ${safeField(item.branch, "확인 안 됨")}`,
    `상태 ${safeField(item.status, "확인 안 됨")}`
  ];
  if (item.lastActivityAt !== undefined) fields.push(`최근 활동 ${safeField(item.lastActivityAt, "확인 안 됨")}`);
  return fields.join(" · ");
}

export function createOrcaObserver(options: CreateOrcaObserverOptions = {}): OrcaObserver {
  const run = options.run ?? defaultRun;
  const invoke = async (args: readonly string[]): Promise<Record<string, unknown>> => {
    try {
      return receiptResult(await run("orca", args, {
        timeoutMs: COMMAND_TIMEOUT_MS,
        maxOutputBytes: COMMAND_OUTPUT_LIMIT
      }));
    } catch (error) {
      if (error instanceof Error && error.message === "Orca 상태 응답을 확인할 수 없습니다") throw error;
      throw new Error("Orca 상태를 조회하지 못했습니다");
    }
  };

  const collect = async (project: ObservedProject): Promise<WorktreeObservation[]> => {
    const worktrees = parseWorktrees(await invoke([
      "worktree", "list", "--repo", `id:${project.id}`, "--limit", String(MAX_WORKTREES), "--json"
    ]));
    const observations: WorktreeObservation[] = [];
    for (const worktree of worktrees) {
      const terminals = parseTerminals(await invoke([
        "terminal", "list", "--worktree", worktreeSelector(worktree),
        "--limit", String(MAX_TERMINALS_PER_WORKTREE), "--json"
      ]));
      observations.push({ ...worktree, terminals });
    }
    return observations;
  };

  return {
    async observe(project, intent) {
      const observations = await collect(project);
      if (observations.length === 0) {
        return intent === "review"
          ? `${safeField(project.name, "프로젝트")}에 검토할 Orca 작업 공간이 없습니다.`
          : `${safeField(project.name, "프로젝트")}에 Orca 작업 공간이 없습니다. 외부 작업 시작 여부를 확인할 수 없습니다.`;
      }

      if (intent === "review") {
        const candidates = observations.map(item => {
          const terminals = item.terminals.length === 0
            ? "터미널 없음"
            : `터미널 ${item.terminals.map(terminal => safeField(terminal.handle, "알 수 없음")).join(", ")}`;
          return `- ${worktreeMetadata(item)} · ${terminals}`;
        });
        if (observations.length > 1) {
          return [
            `검토 가능한 Orca 작업 공간 ${observations.length}개입니다. 임의로 선택하지 않았습니다.`,
            ...candidates,
            "검토할 작업 공간 ID 또는 경로를 지정해 주세요."
          ].join("\n");
        }
        return [
          "검토 대상 Orca 작업 공간 후보입니다.",
          ...candidates,
          "이 ID 또는 경로를 대상으로 Orca 작업으로 검토를 요청할 수 있습니다."
        ].join("\n");
      }

      const protectedProject = isProtectedProject(project);
      let reads = 0;
      const sections: string[] = [
        `${safeField(project.name, "프로젝트")}의 Orca 작업 공간 ${observations.length}개를 확인했습니다.`
      ];
      if (protectedProject) {
        sections.push("보호 프로젝트이므로 터미널 원문을 읽지 않고 상태 메타데이터만 표시합니다.");
      }
      for (const item of observations) {
        sections.push(`- ${worktreeMetadata(item)}`);
        if (item.terminals.length === 0) {
          sections.push("  터미널 없음 · 최근 출력이 없어 현재 단계를 확정할 수 없습니다.");
          continue;
        }
        for (const terminal of item.terminals) {
          const metadata = [
            `터미널 ${safeField(terminal.handle, "알 수 없음")}`,
            `상태 ${safeField(terminal.status, "확인 안 됨")}`
          ];
          if (terminal.title !== undefined) metadata.push(`제목 ${safeField(terminal.title, "확인 안 됨")}`);
          sections.push(`  ${metadata.join(" · ")}`);
          if (protectedProject) continue;
          if (reads >= MAX_TERMINAL_READS) {
            sections.push("    최근 출력 조회 한도에 도달해 현재 단계를 확정할 수 없습니다.");
            continue;
          }
          reads += 1;
          const lines = recentLines(await invoke([
            "terminal", "read", "--terminal", terminal.handle,
            "--limit", "40", "--json"
          ]));
          if (lines.length === 0) {
            sections.push("    최근 출력이 없어 현재 단계를 확정할 수 없습니다.");
          } else {
            sections.push(`    최근 단계 단서: ${lines.join(" / ")}`);
            sections.push("    불확실성: 최근 터미널 출력만으로 작업 완료 여부는 확정할 수 없습니다.");
          }
        }
      }
      return sections.join("\n");
    }
  };
}
