import { PassThrough, Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import { runChat } from "../src/chat.js";
import { ProgressRequestFailed, type ProgressClient, type ProgressEvent, type ProgressFrame, type ProgressStreamOptions } from "../src/progress-client.js";

function event(seq: number, requestId: string, kind: string, contextId: string | null = null, text = "通知"): ProgressEvent {
  return { seq, eventKey: `e${seq}`, requestId, contextId, kind, source: "hq", occurredAt: "2026-09-08T00:00:00Z", payload: { text, title: "테스트", contextId, relation: "new" } };
}
function fixture() {
  const input = new PassThrough();
  let output = "";
  const streams: { options: ProgressStreamOptions; push(frame: ProgressFrame): void; end(): void }[] = [];
  const client: ProgressClient = {
    submitRequest: vi.fn(async request => ({ requestId: request.requestId, state: "queued" })),
    getRequest: vi.fn(async requestId => ({ requestId, sessionId: "session", state: "queued", contextIds: [] })),
    listContexts: vi.fn(async () => []), getContext: vi.fn(), acquireViewerLease: vi.fn(), heartbeatViewerLease: vi.fn(), releaseViewerLease: vi.fn(),
    streamEvents(options) {
      const queue: ProgressFrame[] = [];
      let done = false;
      let wake: (() => void) | undefined;
      const end = () => { done = true; wake?.(); };
      streams.push({ options, push(frame) { queue.push(frame); wake?.(); }, end });
      options.signal?.addEventListener("abort", end, { once: true });
      return { async *[Symbol.asyncIterator]() {
        try {
          while (!done) {
            if (queue.length) yield queue.shift()!;
            else await new Promise<void>(resolve => { wake = resolve; if (options.signal?.aborted) end(); });
          }
        } finally { options.signal?.removeEventListener("abort", end); }
      } };
    }
  };
  const windows = { open: vi.fn(async () => "opened" as const) };
  const sink = new PassThrough();
  sink.on("data", chunk => { output += chunk.toString(); });
  const options = { input, output: sink, sessionId: "session", client, windows, progressWindow: "auto" as const, platform: "darwin", inputIsTTY: true, outputIsTTY: false, reconnectDelayMs: 1 };
  return { input, get output() { return output; }, client, streams, windows, options };
}

describe("async terminal conversations", () => {
  it("accepts a second instruction while the first has no final response and exits without canceling work", async () => {
    const f = fixture();
    const running = runChat(f.options);
    f.input.write("첫 질문\n두 번째 질문\n");
    await vi.waitFor(() => expect(f.client.submitRequest).toHaveBeenCalledTimes(2));
    const calls = vi.mocked(f.client.submitRequest).mock.calls;
    expect(calls[0]![0].sessionId).toBe(calls[1]![0].sessionId);
    expect(calls[0]![0].requestId).not.toBe(calls[1]![0].requestId);
    expect(f.output).toContain("업무 맥락 확인 중");
    f.input.write("/exit\n무시\n");
    await running;
    expect(f.streams[0]!.options.signal?.aborted).toBe(true);
    expect(f.client.releaseViewerLease).not.toHaveBeenCalled();
    expect(f.client.submitRequest).toHaveBeenCalledTimes(2);
  });
  it("opens only live assignments for locally submitted requests, once per request/context, and prints aggregate results once", async () => {
    const f = fixture();
    const running = runChat({ ...f.options, outputIsTTY: true });
    await vi.waitFor(() => expect(f.streams).toHaveLength(1));
    f.streams[0]!.push(event(1, "old", "context.assigned", "ctx_old"));
    f.input.write("질문\n");
    await vi.waitFor(() => expect(f.client.submitRequest).toHaveBeenCalledTimes(1));
    const id = vi.mocked(f.client.submitRequest).mock.calls[0]![0].requestId;
    f.streams[0]!.push(event(2, id, "context.assigned", "ctx_a"));
    f.streams[0]!.push(event(3, id, "context.assigned", "ctx_a"));
    f.streams[0]!.push(event(4, id, "job.state", "ctx_b"));
    f.streams[0]!.push(event(5, id, "request.completed", "ctx_a", "완료 상세"));
    f.streams[0]!.push(event(6, id, "request.completed", null, "최종 요약"));
    f.streams[0]!.push(event(6, id, "request.completed", null, "최종 요약"));
    await vi.waitFor(() => expect(f.output).toContain("최종 요약"));
    expect(f.windows.open).toHaveBeenCalledExactlyOnceWith("ctx_a");
    expect(f.output.match(/최종 요약/gu)).toHaveLength(1);
    expect(f.output).not.toContain("완료 상세");
    f.input.write("/exit\n"); await running;
  });
  it("discovers uncertain acceptance by the same ID using GET, never posts a retry, and permits manual recovery", async () => {
    const f = fixture();
    vi.mocked(f.client.submitRequest).mockRejectedValue(new Error("private socket error"));
    vi.mocked(f.client.getRequest).mockRejectedValue(new ProgressRequestFailed(404, "absent"));
    const running = runChat(f.options);
    f.input.write("질문\n");
    await vi.waitFor(() => expect(f.output).toContain("접수 여부 확인 필요"));
    const id = vi.mocked(f.client.submitRequest).mock.calls[0]![0].requestId;
    expect(f.client.getRequest).toHaveBeenCalledWith(id);
    expect(f.client.submitRequest).toHaveBeenCalledTimes(1);
    expect(f.output).not.toContain("private socket error");
    vi.mocked(f.client.getRequest).mockResolvedValue({ requestId: id, sessionId: "session", state: "completed", contextIds: ["ctx_a"], result: { text: "복구 결과" } });
    f.input.write(`/request ${id}\n`);
    await vi.waitFor(() => expect(f.output).toContain("복구 결과"));
    expect(f.client.submitRequest).toHaveBeenCalledTimes(1);
    expect(f.windows.open).not.toHaveBeenCalled();
    f.input.write("/exit\n"); await running;
  });
  it("switches sessions on /new while prior observers and viewers remain alive", async () => {
    const f = fixture();
    const running = runChat(f.options);
    f.input.write("첫 질문\n/context ctx_a\n후속\n/new\n새 질문\n");
    await vi.waitFor(() => expect(f.client.submitRequest).toHaveBeenCalledTimes(3));
    const calls = vi.mocked(f.client.submitRequest).mock.calls.map(call => call[0]);
    expect(calls[1]!.contextHint).toEqual({ mode: "continue", contextId: "ctx_a" });
    expect(calls[2]!.sessionId).not.toBe(calls[0]!.sessionId);
    expect(calls[2]!.contextHint).toBeUndefined();
    expect(f.streams[0]!.options.signal?.aborted).toBe(false);
    f.input.write("/exit\n"); await running;
  });
  it("resumes event cursors after disconnect and compaction without opening historical windows", async () => {
    const f = fixture();
    const running = runChat(f.options);
    await vi.waitFor(() => expect(f.streams).toHaveLength(1));
    f.streams[0]!.push({ kind: "history.compacted", occurredAt: "now", oldestSeq: 41, latestSeq: 45, snapshots: [] });
    await vi.waitFor(() => expect(f.output).toContain("이전 기록 정리"));
    f.streams[0]!.end();
    await vi.waitFor(() => expect(f.streams).toHaveLength(2));
    expect(f.streams[1]!.options.after).toBe(45);
    expect(f.windows.open).not.toHaveBeenCalled();
    f.input.write("/exit\n"); await running;
  });
  it("drains piped lines through durable acceptance without waiting for work completion", async () => {
    const f = fixture();
    await runChat({ ...f.options, input: Readable.from(["하나\n둘\n"]), inputIsTTY: false });
    expect(f.client.submitRequest).toHaveBeenCalledTimes(2);
    expect(f.windows.open).not.toHaveBeenCalled();
  });
  it.each([["chat", "extra"], ["chat", "--session"], ["chat", "--progress-window=bad"], ["watch"], ["watch", "--context", "ctx_a", "--lease-token", "token"]])("rejects malformed CLI arguments %j", async (...input) => {
    expect(await runCli(input, { stdin: Readable.from([]), stdout: { write: () => true } })).toBe(2);
  });
  it.each(["", "../other", "two words", "a".repeat(101), "세션"])("rejects invalid session %j", async sessionId => {
    expect(await runCli(["chat", "--session", sessionId], { stdin: Readable.from([]), stdout: { write: () => true } })).toBe(2);
  });
});

it("preserves a partially typed line while an asynchronous notification redraws the terminal", async () => {
  const f = fixture();
  const running = runChat({ ...f.options, outputIsTTY: true });
  await vi.waitFor(() => expect(f.streams).toHaveLength(1));
  f.input.write("아직 입력 중");
  f.streams[0]!.push(event(1, "old", "hq.progress", "ctx_a", "중간 설명\u001b]0;위조\u0007"));
  // Off mode renders progress inline while readline keeps its editable input buffer.
  f.streams[0]!.push(event(2, "old", "clarification.required", null, "확인 질문\u001b[2J"));
  await vi.waitFor(() => expect(f.output).toContain("확인 질문"));
  f.input.write("인 질문\n");
  await vi.waitFor(() => expect(f.client.submitRequest).toHaveBeenCalledTimes(1));
  expect(vi.mocked(f.client.submitRequest).mock.calls[0]![0].text).toBe("아직 입력 중인 질문");
  expect(f.output).not.toContain("\u001b[2J");
  expect(f.output).not.toContain("위조");
  f.input.write("\u0003");
  await running;
});

it("routes real CLI chat flags through the asynchronous client", async () => {
  const f = fixture();
  const result = runCli(["chat", "--progress-window=off", "--session", "resume"], {
    stdin: Readable.from(["질문\n"]), stdout: f.options.output, progress: f.client,
    control: { async send() { throw new Error("legacy_transport_forbidden"); } }
  });
  expect(await result).toBe(0);
  expect(vi.mocked(f.client.submitRequest).mock.calls[0]![0]).toMatchObject({ sessionId: "resume", text: "질문" });
});

it("retains a long multiline final report while removing injected terminal controls", async () => {
  const f = fixture();
  const running = runChat(f.options);
  await vi.waitFor(() => expect(f.streams).toHaveLength(1));
  const report = `검토 결과\n\n${"충분한 상세 결과입니다.\n".repeat(1000)}최종 결론`;
  f.streams[0]!.push(event(1, "old", "request.completed", null, `\u001b]0;위조\u0007${report}\u001b[2J`));
  await vi.waitFor(() => expect(f.output).toContain("최종 결론"));
  expect(f.output).toContain(report);
  expect(f.output).not.toContain("위조");
  expect(f.output).not.toContain("\u001b[2J");
  f.input.write("/exit\n"); await running;
});

it("fetches a full durable final result when the NDJSON event contains only a bounded preview", async () => {
  const f = fixture();
  const report = `긴 결과\n${"상세 내용\n".repeat(2000)}끝`;
  vi.mocked(f.client.getRequest).mockResolvedValue({ requestId: "r", sessionId: "session", state: "completed", contextIds: ["ctx_a"], result: { text: report, jobId: "job_1" } });
  const running = runChat(f.options);
  await vi.waitFor(() => expect(f.streams).toHaveLength(1));
  f.streams[0]!.push(event(1, "r", "request.completed", null, "긴 결과…"));
  await vi.waitFor(() => expect(f.output).toContain(report));
  expect(f.output).toContain("작업 ID: job_1");
  f.input.write("/exit\n"); await running;
});
