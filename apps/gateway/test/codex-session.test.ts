import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createCodexSessionClient } from "../src/codex-session.js";

type Message = { id?: number | string | undefined; method?: string; params?: any; result?: any; error?: any };
type FakeChild = ChildProcessWithoutNullStreams & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough };
function server(handler?: (m: Message, send: (m: Message) => void, child: FakeChild) => boolean | void) {
  const received: Message[] = [];
  const children: FakeChild[] = [];
  const spawnMock = vi.fn((_executable: string, _args: readonly string[], _options: SpawnOptionsWithoutStdio) => {
    const child = new EventEmitter() as FakeChild;
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => { queueMicrotask(() => child.emit("close", 0)); return true; }) });
    children.push(child);
    const send = (m: Message) => child.stdout.write(JSON.stringify(m) + "\n");
    child.stdin.on("data", (data) => {
      for (const line of String(data).trim().split("\n")) {
        const m: Message = JSON.parse(line); received.push(m);
        if (handler?.(m, send, child)) continue;
        if (m.method === "initialize") send({ id: m.id, result: {} });
        if (m.method === "thread/start" || m.method === "thread/resume") send({ id: m.id, result: { thread: { id: "thread-1" } } });
        if (m.method === "turn/start") {
          send({ id: m.id, result: { turn: { id: "turn-1" } } });
          send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", phase: "commentary", text: "중간" } } });
          send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", phase: "final_answer", text: "최종 답변" } } });
          send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
        }
      }
    });
    return child;
  });
  const spawnProcess = spawnMock as unknown as typeof spawn;
  return { spawnProcess, spawnMock, received, children };
}
const tools = [{ name: "lookup", description: "조회", inputSchema: { type: "object" } }];
const options = { cwd: "/tmp", instructions: "HQ 지침", tools };
const input = { text: "상태 알려줘", onThread: async (_id: string) => {}, onTool: async () => ({ ok: true }) };

describe("Codex persistent app-server client", () => {
  let fixture: string;
  beforeEach(async () => { fixture = await mkdtemp(join(tmpdir(), "hq-codex-session-test-")); vi.stubEnv("CODEX_HOME", fixture); });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(fixture, { recursive: true, force: true }); });
  it("persists the thread before submitting text and resumes it in another process", async () => {
    const fake = server(); const client = createCodexSessionClient({ ...options, spawnProcess: fake.spawnProcess });
    const onThread = vi.fn(async (id: string) => {
      expect(id).toBe("thread-1"); expect(fake.received.filter(m => m.method === "turn/start")).toHaveLength(0);
    });
    expect(await client.run({ ...input, onThread })).toEqual({ threadId: "thread-1", text: "최종 답변" });
    await client.run({ ...input, threadId: "thread-1" });
    expect(fake.received.filter(m => m.method === "thread/start")).toHaveLength(1);
    expect(fake.received.find(m => m.method === "thread/start")?.params.dynamicTools[0].type).toBe("function");
    expect(fake.received.find(m => m.method === "thread/resume")?.params.threadId).toBe("thread-1");
    expect(fake.spawnMock.mock.calls[0]?.[2]?.env?.CODEX_HOME).toBe(fake.spawnMock.mock.calls[1]?.[2]?.env?.CODEX_HOME);
    await client.close();
  });
  it("returns repeated dynamic tool results and failures, rejecting unknown requests", async () => {
    let count = 0;
    const fake = server((m, send) => {
      const call = () => send({ id: 100 + count, method: "item/tool/call", params: { threadId: "thread-1", turnId: "turn-1", callId: `call-${count}`, tool: "lookup", arguments: { count } } });
      if (m.method === "turn/start") { send({ id: m.id, result: { turn: { id: "turn-1" } } }); call(); return true; }
      if (m.id === 100) { expect(m.result.success).toBe(true); count++; call(); return true; }
      if (m.id === 101) { expect(m.result.success).toBe(false); expect(m.result.contentItems[0].text).toContain("도구 실패"); expect(m.result.contentItems[0].text).not.toContain("xoxb-secret-value"); send({ id: 102, method: "item/commandExecution/requestApproval", params: {} }); return true; }
      if (m.id === 102) { expect(m.error).toBeDefined(); send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [{ type: "agentMessage", phase: "final_answer", text: "완료" }] } } }); return true; }
    });
    const onTool = vi.fn(async (_name, args, _callId) => { if (args.count === 1) throw new Error("도구 실패 xoxb-secret-value"); return { found: true }; });
    const client = createCodexSessionClient({ ...options, spawnProcess: fake.spawnProcess });
    expect((await client.run({ ...input, onTool })).text).toBe("완료"); expect(onTool).toHaveBeenCalledTimes(2);
  });
  it("does not settle a timeout until its active mutation settles or execute later tools", async () => {
    let release!: () => void; let send!: (m: Message) => void;
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const fake = server((m, emit) => { if (m.method === "turn/start") { send = emit; emit({ id: m.id, result: { turn: { id: "turn-1" } } }); emit({ id: 100, method: "item/tool/call", params: { threadId: "thread-1", turnId: "turn-1", callId: "mutation", tool: "lookup", arguments: {} } }); return true; } });
    const onTool = vi.fn(() => { markStarted(); return new Promise(resolve => { release = () => resolve({ done: true }); }); });
    const client = createCodexSessionClient({ ...options, timeoutMs: 40, spawnProcess: fake.spawnProcess });
    let settled = false;
    const result = client.run({ ...input, onTool }).then(() => { settled = true; }, error => { settled = true; return error; });
    await started; await new Promise(resolve => setTimeout(resolve, 70));
    expect(settled).toBe(false);
    send({ id: 101, method: "item/tool/call", params: { threadId: "thread-1", turnId: "turn-1", callId: "late", tool: "lookup", arguments: {} } });
    release(); expect((await result).message).toContain("시간"); expect(onTool).toHaveBeenCalledTimes(1);
  });
  it.each(["exit", "overflow", "resume"])("reports %s without replaying turns", async mode => {
    const fake = server((m, send, child) => {
      if (mode === "resume" && m.method === "thread/resume") { send({ id: m.id, error: { message: "private detail" } }); return true; }
      if (m.method === "turn/start") { if (mode === "exit") child.emit("close", 1); else child.stdout.write("x".repeat(2 * 1024 * 1024)); return true; }
    });
    const client = createCodexSessionClient({ ...options, spawnProcess: fake.spawnProcess });
    await expect(client.run({ ...input, ...(mode === "resume" ? { threadId: "thread-1" } : {}) })).rejects.toThrow(/Codex/);
    expect(fake.received.filter(m => m.method === "turn/start").length).toBeLessThanOrEqual(1);
  });
  it("does not submit a turn if thread persistence fails", async () => {
    const fake = server(); const client = createCodexSessionClient({ ...options, spawnProcess: fake.spawnProcess });
    await expect(client.run({ ...input, onThread: async () => { throw new Error("저장 실패"); } })).rejects.toThrow("저장 실패");
    expect(fake.received.some(m => m.method === "turn/start")).toBe(false);
  });
  it("isolates credentials and disables built-in execution while retaining durable history", async () => {
    const fake = server(); const client = createCodexSessionClient({ ...options, spawnProcess: fake.spawnProcess });
    await client.run(input);
    const args = fake.spawnMock.mock.calls[0]?.[1] as string[];
    const env = fake.spawnMock.mock.calls[0]?.[2]?.env;
    expect(args).not.toContain("code_mode_host"); expect(args).toContain("shell_tool"); expect(args).toContain("unified_exec"); expect(args).toContain("skip_host_skill_discovery");
    expect(args).toContain("project_doc_max_bytes=0"); expect(args).not.toContain("--ephemeral");
    expect(env?.OPENAI_API_KEY).toBeUndefined(); expect(env?.SLACK_BOT_TOKEN).toBeUndefined();
    const start = fake.received.find(m => m.method === "thread/start")?.params;
    expect(start.sandbox).toBe("read-only"); expect(start.ephemeral).toBe(false); expect(start.baseInstructions).toBe(options.instructions);
    await client.close(); await expect(client.run(input)).rejects.toThrow("종료");
  });

  it("escalates termination if the app-server ignores SIGTERM", async () => {
    const fake = server((_m, _send, child) => { child.kill = vi.fn(signal => { if (signal === "SIGKILL") queueMicrotask(() => child.emit("close", 0)); return true; }); });
    const client = createCodexSessionClient({ ...options, spawnProcess: fake.spawnProcess });
    await client.run(input);
    expect(fake.children[0]?.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("close waits for an active mutation and prevents queued callbacks", async () => {
    let release!: () => void; let send!: (m: Message) => void; let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const fake = server((m, emit) => {
      if (m.method !== "turn/start") return;
      send = emit; emit({ id: m.id, result: { turn: { id: "turn-1" } } });
      emit({ id: 100, method: "item/tool/call", params: { threadId: "thread-1", turnId: "turn-1", callId: "active", tool: "lookup", arguments: {} } });
      return true;
    });
    const onTool = vi.fn(() => { markStarted(); return new Promise(resolve => { release = () => resolve({ done: true }); }); });
    const client = createCodexSessionClient({ ...options, spawnProcess: fake.spawnProcess });
    const run = client.run({ ...input, onTool }).catch(error => error);
    await started;
    let closed = false; const closing = client.close().then(() => { closed = true; });
    send({ id: 101, method: "item/tool/call", params: { threadId: "thread-1", turnId: "turn-1", callId: "late", tool: "lookup", arguments: {} } });
    await new Promise(resolve => setTimeout(resolve, 5)); expect(closed).toBe(false);
    release(); await closing; expect((await run).message).toContain("종료"); expect(onTool).toHaveBeenCalledTimes(1);
  });

});
