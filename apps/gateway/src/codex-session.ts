import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, symlink, readlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { redactRelayText } from "./orca-relay.js";

export interface AgentToolSpec { name: string; description: string; inputSchema: Record<string, unknown> }
export interface CodexSessionOptions {
  cwd: string; instructions: string; tools: AgentToolSpec[]; timeoutMs?: number;
  executable?: string; spawnProcess?: typeof spawn;
}
export interface CodexSessionRun {
  threadId?: string; text: string;
  onProgress?: (text:string)=>Promise<void>;
  onThread: (id: string) => void | Promise<void>;
  onTool: (name: string, args: unknown, callId: string) => Promise<unknown>;
}
// Dynamic function dispatch requires the internal code-mode host; only the model-facing code_mode tool is disabled.
const DISABLED = ["shell_tool", "unified_exec", "shell_snapshot", "apps", "enable_mcp_apps", "browser_use", "browser_use_external", "browser_use_full_cdp_access", "in_app_browser", "computer_use", "code_mode", "hooks", "image_generation", "view_image", "skill_search", "skill_mcp_dependency_install", "plugins", "remote_plugin", "plugin_sharing", "tool_suggest", "multi_agent", "multi_agent_v2", "goals", "sleep_tool", "standalone_web_search", "auth_elicitation", "tool_call_mcp_elicitation"];
const MAX_BYTES = 1024 * 1024;
type RecordValue = Record<string, any>;
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};

async function runtimeEnvironment(): Promise<NodeJS.ProcessEnv> {
  const originalHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const sessionHome = join(originalHome, "orca-hq-session-home");
  await mkdir(sessionHome, { recursive: true, mode: 0o700 });
  const authPath = join(sessionHome, "auth.json");
  const sourceAuth = join(originalHome, "auth.json");
  try { await symlink(sourceAuth, authPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readlink(authPath).catch(() => "") !== sourceAuth) {
      throw new Error("Codex 로그인 연결을 준비하지 못했습니다.");
    }
  }
  const env: NodeJS.ProcessEnv = { CODEX_HOME: sessionHome, HOME: sessionHome };
  for (const name of ["PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "USER", "LOGNAME", "SHELL", "TERM"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}
function argumentsForServer(): string[] {
  const args = ["app-server", "--stdio", "--strict-config"];
  for (const entry of ['approval_policy="never"', 'sandbox_mode="read-only"', "project_doc_max_bytes=0", "project_doc_fallback_filenames=[]", "skills.bundled.enabled=false", "skills.include_instructions=false", "include_permissions_instructions=false", "include_apps_instructions=false", "include_collaboration_mode_instructions=false", "include_environment_context=false", 'web_search="disabled"', "apps._default.enabled=false", "suppress_unstable_features_warning=true"]) args.push("--config", entry);
  for (const feature of DISABLED) args.push("--disable", feature);
  args.push("--enable", "skip_host_skill_discovery");
  return args;
}

export function createCodexSessionClient(options: CodexSessionOptions) {
  let closed = false;
  const active = new Set<{ stop: () => void; done: Promise<unknown> }>();
  async function execute(input: CodexSessionRun, register: (stop: () => void) => void): Promise<{ threadId: string; text: string }> {
    if (Buffer.byteLength(input.text) > MAX_BYTES) throw new Error("Codex 입력 크기 제한을 초과했습니다.");
    const env = await runtimeEnvironment();
    if (closed) throw new Error("Codex 대화 연결이 종료되었습니다.");
    let child: ChildProcessWithoutNullStreams;
    try { child = (options.spawnProcess ?? spawn)(options.executable ?? "codex", argumentsForServer(), { cwd: options.cwd, env, stdio: "pipe" }) as ChildProcessWithoutNullStreams; }
    catch { throw new Error("Codex 프로세스를 시작하지 못했습니다."); }
    let processClosed = false;
    let markClosed!: () => void;
    const processExit = new Promise<void>(resolve => { markClosed = resolve; });
    let stopped = false;
    let failure: Error | undefined;
    let sequence = 0;
    let bytes = 0;
    let buffer = "";
    let threadId = "";
    let turnId = "";
    let turnSubmitted = false;
    let finalText = "";
    const calls = new Map<string, Promise<unknown>>();
    const inflight = new Set<Promise<unknown>>();
    const pending = new Map<number, { resolve: (value: RecordValue) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    let complete!: () => void;
    let rejectComplete!: (error: Error) => void;
    const completion = new Promise<void>((resolve, reject) => { complete = resolve; rejectComplete = reject; });
    // Notifications can fail before the handshake finishes; always observe rejection immediately.
    void completion.catch(() => {});
    function stop(error?: Error) {
      if (stopped) return;
      stopped = true; failure = error;
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error ?? new Error("Codex 연결이 종료되었습니다.")); }
      pending.clear();
      if (error) rejectComplete(error);
      try { child.kill("SIGTERM"); } catch { /* Process already exited. */ }
    }
    register(() => stop(new Error("Codex 대화 연결이 종료되었습니다.")));
    const deadline = setTimeout(() => stop(new Error("Codex 응답 제한 시간이 지났습니다. 이미 요청한 작업은 자동 재실행하지 않습니다.")), options.timeoutMs ?? 180_000);
    function send(message: unknown) {
      if (stopped) return;
      try { child.stdin.write(JSON.stringify(message) + "\n", error => { if (error) stop(new Error("Codex 연결에 쓰지 못했습니다.")); }); }
      catch { stop(new Error("Codex 연결에 쓰지 못했습니다.")); }
    }
    function request(method: string, params: unknown): Promise<RecordValue> {
      if (stopped) return Promise.reject(failure ?? new Error("Codex 연결이 종료되었습니다."));
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => stop(new Error(`Codex ${method === "thread/resume" ? "대화 재개" : "요청"} 제한 시간이 지났습니다.`)), Math.min(options.timeoutMs ?? 180_000, 30_000));
        pending.set(id, { resolve, reject, timer }); send({ id, method, params });
      });
    }
    function assistantItem(item: RecordValue) {
      if (item.type === "agentMessage" && item.phase === "commentary" && typeof item.text === "string" && input.onProgress) { const progress=Promise.resolve().then(()=>stopped?undefined:input.onProgress!(redactRelayText(item.text).slice(0,2000))); inflight.add(progress); void progress.finally(()=>inflight.delete(progress)).catch(()=>{}); }
      if (item.type === "agentMessage" && item.phase !== "commentary" && typeof item.text === "string") finalText = item.text;
    }
    function handle(message: RecordValue) {
      if (stopped) return;
      if (typeof message.method !== "string") {
        const req = pending.get(message.id);
        if (req) {
          clearTimeout(req.timer); pending.delete(message.id);
          if (message.error) req.reject(new Error("Codex 요청 실패: " + redactRelayText(String(record(message.error).message ?? "원인 미확인")).slice(0, 1000))); else req.resolve(record(message.result));
        }
        return;
      }
      const params = record(message.params);
      if (message.id !== undefined) {
        if (message.method !== "item/tool/call") { send({ id: message.id, error: { code: -32601, message: "HQ에서 허용하지 않는 요청입니다." } }); return; }
        if (!turnSubmitted || params.threadId !== threadId || (turnId && params.turnId !== turnId) || typeof params.callId !== "string" || !options.tools.some(tool => tool.name === params.tool) || params.namespace) {
          send({ id: message.id, result: { success: false, contentItems: [{ type: "inputText", text: "허용하지 않는 도구 요청입니다." }] } }); return;
        }
        let work = calls.get(params.callId);
        if (!work) {
          work = Promise.resolve().then(async () => {
            if (stopped) return { success: false, contentItems: [{ type: "inputText", text: "요청 시간이 종료되었습니다." }] };
            try {
              const result = await input.onTool(params.tool, params.arguments, params.callId);
              const text = JSON.stringify(result) ?? "null";
              if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("도구 결과 크기 제한 초과");
              return { success: true, contentItems: [{ type: "inputText", text }] };
            } catch (error) { return { success: false, contentItems: [{ type: "inputText", text: `HQ 도구 실행 실패: ${redactRelayText(error instanceof Error ? error.message : "알 수 없는 오류").slice(0, 2000)}. 동일 작업을 자동 재실행하지 마세요.` }] }; }
          });
          calls.set(params.callId, work); inflight.add(work);
          const tracked = work;
          void tracked.finally(() => inflight.delete(tracked)).catch(() => {});
        }
        void work.then(result => send({ id: message.id, result })).catch(() => stop(new Error("Codex 도구 결과 전달에 실패했습니다.")));
        return;
      }
      if (params.threadId !== threadId || !turnSubmitted) return;
      if (params.turnId && turnId && params.turnId !== turnId) return;
      if (message.method === "item/completed") assistantItem(record(params.item));
      if (message.method === "turn/completed") {
        const turn = record(params.turn);
        if (turnId && turn.id !== turnId) return;
        if (Array.isArray(turn.items)) for (const item of turn.items) assistantItem(record(item));
        if (turn.status !== "completed") stop(new Error("Codex 응답 중단: " + redactRelayText(String(record(turn.error).message ?? turn.status)).slice(0, 1000)));
        else complete();
      }
    }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stopped) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 8 * MAX_BYTES || Buffer.byteLength(buffer) + Buffer.byteLength(chunk) >= 2 * MAX_BYTES) { stop(new Error("Codex 출력 크기 제한을 초과했습니다.")); return; }
      buffer += chunk;
      for (;;) {
        const index = buffer.indexOf("\n"); if (index < 0) break;
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        try { handle(record(JSON.parse(line))); } catch { stop(new Error("Codex 응답 형식을 해석하지 못했습니다.")); }
      }
    });
    child.stderr.on("data", () => {}); // Never forward auth or raw subprocess diagnostics.
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on("error", () => stop(new Error("Codex 연결 오류가 발생했습니다.")));
    child.on("error", () => stop(new Error("Codex 프로세스를 시작하지 못했습니다.")));
    child.on("close", () => { processClosed = true; markClosed(); stop(new Error("Codex 프로세스가 응답 전에 종료되었습니다.")); });
    try {
      await request("initialize", { clientInfo: { name: "orca_hq", version: "0.1.0" }, capabilities: { experimentalApi: true } });
      send({ method: "initialized" });
      const base = { cwd: options.cwd, approvalPolicy: "never", sandbox: "read-only", baseInstructions: options.instructions };
      let thread: RecordValue;
      try {
        thread = await request(input.threadId ? "thread/resume" : "thread/start", input.threadId ? { ...base, threadId: input.threadId } : { ...base, ephemeral: false, dynamicTools: options.tools.map(tool => ({ type: "function", ...tool })) });
      } catch (error) { if (input.threadId && !failure) throw new Error("Codex 대화를 재개하지 못했습니다. /new로 새 대화를 시작할 수 있습니다."); throw error; }
      threadId = record(thread.thread).id;
      if (typeof threadId !== "string" || !threadId || (input.threadId && threadId !== input.threadId)) throw new Error("Codex 대화 식별자가 올바르지 않습니다.");
      await input.onThread(threadId);
      if (stopped) throw failure;
      turnSubmitted = true;
      const result = await request("turn/start", { threadId, input: [{ type: "text", text: input.text, text_elements: [] }] });
      turnId = record(result.turn).id;
      if (typeof turnId !== "string" || !turnId) throw new Error("Codex 응답 식별자가 올바르지 않습니다.");
      await completion;
      if (failure) throw failure;
      if (!finalText.trim()) throw new Error("Codex가 최종 응답을 반환하지 않았습니다.");
      return { threadId, text: finalText };
    } finally {
      clearTimeout(deadline); stop();
      await Promise.allSettled([...inflight]);
      if (!processClosed) {
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([processExit, new Promise<void>(resolve => {
          killTimer = setTimeout(() => {
            try { child.kill("SIGKILL"); } catch { /* Already gone. */ }
            resolve();
          }, 1_000);
        })]);
        clearTimeout(killTimer);
      }
    }
  }
  return {
    run(input: CodexSessionRun): Promise<{ threadId: string; text: string }> {
      if (closed) return Promise.reject(new Error("Codex 대화 연결이 종료되었습니다."));
      const entry = { stop: () => {}, done: Promise.resolve() as Promise<unknown> };
      const done = execute(input, stop => { entry.stop = stop; });
      entry.done = done; active.add(entry);
      void done.finally(() => active.delete(entry)).catch(() => {});
      return done;
    },
    async close(): Promise<void> {
      closed = true;
      for (const entry of active) entry.stop();
      await Promise.allSettled([...active].map(entry => entry.done));
    }
  };
}
