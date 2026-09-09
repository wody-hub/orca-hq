import { randomUUID } from "node:crypto";
import { createInterface, clearLine, cursorTo } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { validSessionId } from "./control.js";
import {
  createProgressClient, isProgressCompaction, isProgressEvent, ProgressRequestFailed,
  sanitizeDisplayText, sanitizeResultText, validProgressIdentifier, type ContextHint, type ProgressClient,
  type ProgressEvent, type ProgressRequestStatus
} from "./progress-client.js";
import { canOpenProgressWindow, createProgressWindowManager, type ProgressWindowManager, type ProgressWindowMode } from "./progress-window.js";

export interface ChatOptions {
  readonly input: Readable;
  readonly output: Pick<typeof process.stdout, "write">;
  readonly sessionId?: string;
  readonly client?: ProgressClient;
  readonly windows?: ProgressWindowManager;
  readonly progressWindow?: ProgressWindowMode;
  readonly platform?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly inputIsTTY?: boolean;
  readonly outputIsTTY?: boolean;
  readonly signal?: AbortSignal;
  readonly reconnectDelayMs?: number;
}

/** Durable acceptance and the observation stream have independent lifetimes. No observer sends execution retries. */
export async function runChat(options: ChatOptions): Promise<void> {
  let sessionId = options.sessionId ?? randomUUID();
  if (!validSessionId(sessionId)) throw new Error("control_session_invalid");
  const client = options.client ?? createProgressClient();
  const inputIsTTY = options.inputIsTTY ?? (options.input as { isTTY?: boolean }).isTTY === true;
  const outputIsTTY = options.outputIsTTY ?? (options.output as { isTTY?: boolean }).isTTY === true;
  const terminal = inputIsTTY && outputIsTTY;
  const autoWindows = options.progressWindow !== "off" && canOpenProgressWindow({
    platform: options.platform ?? process.platform, inputIsTTY, outputIsTTY, env: options.env ?? process.env
  });
  const windows = options.windows ?? createProgressWindowManager({ client });
  const stopper = new AbortController();
  const lines = createInterface({ input: options.input, output: terminal ? options.output as Writable : undefined, terminal, crlfDelay: Infinity });
  // Install the iterator before any await so piped input remains queued during durable acceptance.
  const iterator = lines[Symbol.asyncIterator]();
  let prompting = false;
  let contextHint: ContextHint | undefined;
  const submitted = new Map<string, { sessionId: string; opened: Set<string> }>();
  const uncertain = new Set<string>();
  const finalShown = new Set<string>();
  const inlineContexts = new Set<string>();
  const observers: Promise<void>[] = [];
  const openings = new Set<Promise<void>>();
  const abort = () => { stopper.abort(); lines.close(); };
  lines.on("SIGINT", abort);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });

  function prompt(): void {
    prompting = true;
    if (terminal) { lines.setPrompt("> "); lines.prompt(true); }
    else options.output.write("> ");
  }
  function notify(message: string): void {
    if (stopper.signal.aborted) return;
    if (terminal && prompting) { clearLine(options.output as Writable, 0); cursorTo(options.output as Writable, 0); }
    options.output.write(`${message}\n`);
    if (terminal && prompting) lines.prompt(true);
  }
  function announce(): void { notify(`세션 ID: ${sessionId}\n재개: hq chat --session ${sessionId}`); }
  function manual(contextId: string): void {
    if (!validProgressIdentifier(contextId)) return;
    inlineContexts.add(contextId);
    notify(`진행 확인: hq watch --context ${contextId}`);
  }
  function showResult(status: ProgressRequestStatus): void {
    notify(`요청 [${sanitizeDisplayText(status.requestId)}] · ${sanitizeDisplayText(status.state)}`);
    if (status.result !== undefined && !finalShown.has(status.requestId)) {
      finalShown.add(status.requestId);
      notify(sanitizeResultText(status.result.text));
      if (status.result.jobId !== undefined) notify(`작업 ID: ${sanitizeDisplayText(status.result.jobId)}`);
    }
    for (const id of status.contextIds) manual(id);
  }
  async function discover(requestId: string): Promise<boolean> {
    try {
      const status = await client.getRequest(requestId);
      if (status.requestId !== requestId) throw new Error("progress_response_invalid");
      uncertain.delete(requestId);
      showResult(status);
      return true;
    } catch { return false; }
  }
  function openFor(event: ProgressEvent): void {
    const local = submitted.get(event.requestId);
    const contextId = event.contextId ?? event.payload.contextId;
    if (!validProgressIdentifier(contextId)) return;
    if (local === undefined || local.opened.has(contextId)) return;
    local.opened.add(contextId);
    if (!autoWindows) { manual(contextId); return; }
    const opening = (async () => {
      let result;
      try { result = await windows.open(contextId); } catch { result = "uncertain"; }
      if (result === "failed" || result === "uncertain") {
        notify(result === "failed" ? "진행 창을 열지 못했습니다. 작업은 계속됩니다." : "진행 창 생성 여부 확인 필요. 자동으로 다시 열지 않습니다.");
        manual(contextId);
      } else notify(`진행 창 ${result === "reused" ? "재사용" : "열림"} [${contextId}]`);
    })();
    openings.add(opening);
    void opening.finally(() => openings.delete(opening));
  }
  async function display(event: ProgressEvent): Promise<void> {
    const id = sanitizeDisplayText(event.contextId ?? event.requestId);
    const text = sanitizeDisplayText(event.payload.text);
    if (event.kind === "context.assigned") {
      notify(`${event.payload.relation === "continue" ? "이어서 진행" : "새 작업"}: ${sanitizeDisplayText(event.payload.title)} [${id}]`);
      openFor(event);
    } else if (["request.completed", "request.failed", "recovery.required"].includes(event.kind)) {
      // Runtime emits one aggregate final plus per-context detail; only aggregate belongs in the input terminal.
      if (event.contextId === null && !finalShown.has(event.requestId)) {
        finalShown.add(event.requestId);
        let resultText = event.payload.text;
        let jobId = event.payload.jobId;
        try {
          const status = await client.getRequest(event.requestId);
          if (status.requestId === event.requestId && status.result !== undefined) {
            resultText = status.result.text; jobId = status.result.jobId;
          }
        } catch { /* Keep the recorded preview visible if the snapshot is temporarily unavailable. */ }
        notify(`[${id}] ${sanitizeResultText(resultText) || sanitizeDisplayText(event.kind)}`);
        if (typeof jobId === "string") notify(`작업 ID: ${sanitizeDisplayText(jobId)}`);
        if (typeof resultText === "string" && resultText.endsWith("…")) {
          notify(`전체 결과 확인: /request ${sanitizeDisplayText(event.requestId)}`);
        }
      }
    } else if (event.kind === "clarification.required" || event.kind === "agent.waiting" || event.kind === "request.queued") {
      notify(`[${id}] ${text || sanitizeDisplayText(event.kind)}`);
    } else if ((!autoWindows || (event.contextId !== null && inlineContexts.has(event.contextId))) && text !== ""
      && ["hq.progress", "tool.started", "tool.completed", "tool.failed", "job.linked", "job.state"].includes(event.kind)) {
      notify(`[${id}] ${sanitizeDisplayText(event.kind)} · ${text}`);
    }
  }
  async function delay(milliseconds: number): Promise<void> {
    if (stopper.signal.aborted) return;
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); stopper.signal.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, milliseconds);
      stopper.signal.addEventListener("abort", finish, { once: true });
    });
  }
  async function observe(scope: string): Promise<void> {
    let cursor = 0;
    let attempt = 0;
    let disconnected = false;
    try {
      for (const snapshot of await client.listContexts(scope)) {
        notify(`기존 작업: ${sanitizeDisplayText(snapshot.title)} · ${sanitizeDisplayText(snapshot.state)}`);
        manual(snapshot.contextId);
      }
    } catch { /* The stream retries discovery without replaying execution. */ }
    while (!stopper.signal.aborted) {
      try {
        for await (const frame of client.streamEvents({ sessionId: scope, after: cursor, signal: stopper.signal })) {
          if (stopper.signal.aborted) break;
          if (disconnected) { notify(`진행 연결 복구 [${scope}]`); disconnected = false; }
          attempt = 0;
          if (isProgressCompaction(frame)) {
            cursor = Math.max(cursor, frame.latestSeq);
            notify("이전 기록 정리 · 현재 요약으로 이어갑니다.");
            for (const snapshot of frame.snapshots) {
              notify(`${sanitizeDisplayText(snapshot.title)} · ${sanitizeDisplayText(snapshot.state)} · ${sanitizeDisplayText(snapshot.summary)}`);
              manual(snapshot.contextId);
            }
            // Compaction can remove the final event for a request submitted in this process.
            for (const [id, local] of submitted) {
              if (local.sessionId === scope && !finalShown.has(id)) await discover(id);
            }
          } else if (isProgressEvent(frame) && frame.seq > cursor) {
            cursor = frame.seq;
            await display(frame);
          }
        }
      } catch { /* Socket loss is an observation failure, never a reason to re-submit. */ }
      if (stopper.signal.aborted) break;
      if (!disconnected) notify(`진행 연결 재연결 중 [${scope}] · 작업은 계속됩니다.`);
      disconnected = true;
      for (const id of uncertain) {
        if (submitted.get(id)?.sessionId === scope) await discover(id);
      }
      const backoff = [1, 2, 5, 10][Math.min(attempt++, 3)]!;
      await delay((options.reconnectDelayMs ?? 1000) * backoff);
    }
  }
  function startObserver(): void { observers.push(observe(sessionId)); }

  try {
    announce();
    notify("질문을 입력하세요. /new: 새 대화, /context ID: 맥락 선택, /request ID: 접수 확인, /exit: 종료");
    startObserver();
    prompt();
    for await (const line of { [Symbol.asyncIterator]: () => iterator }) {
      prompting = false;
      const text = line.trim();
      if (text === "/exit" || stopper.signal.aborted) break;
      if (text === "/new") {
        sessionId = randomUUID(); contextHint = undefined; announce(); startObserver();
      } else if (text.startsWith("/context")) {
        const match = /^\/context ([A-Za-z0-9_.:-]{1,200})$/u.exec(text);
        if (match === null) notify("사용법: /context ID");
        else { contextHint = { mode: "continue", contextId: match[1]! }; notify(`선택한 맥락 [${match[1]}]`); }
      } else if (text.startsWith("/request")) {
        const id = text.slice("/request".length).trim();
        if (!validProgressIdentifier(id)) notify("사용법: /request ID");
        else if (!(await discover(id))) notify(`접수 여부 확인 필요 [${id}] · 자동 재전송하지 않습니다.`);
      } else if (text !== "") {
        const requestId = randomUUID();
        submitted.set(requestId, { sessionId, opened: new Set() });
        notify(`접수 중 [${requestId}]`);
        try {
          const accepted = await client.submitRequest({ requestId, sessionId, text, ...(contextHint === undefined ? {} : { contextHint }) });
          if (accepted.requestId !== requestId) throw new Error("progress_response_invalid");
          notify(`접수 완료 [${requestId}] · 업무 맥락 확인 중`);
        } catch (error) {
          if (error instanceof ProgressRequestFailed && error.status >= 400 && error.status < 500) {
            submitted.delete(requestId);
            notify(`접수 거절 [${requestId}] · ${sanitizeDisplayText(error.text)}`);
          } else {
            uncertain.add(requestId);
            if (!(await discover(requestId))) notify(`접수 여부 확인 필요 [${requestId}] · /request ${requestId}로 확인하세요. 자동 재전송하지 않습니다.`);
          }
        }
      }
      prompt();
    }
  } finally {
    stopper.abort();
    options.signal?.removeEventListener("abort", abort);
    lines.removeListener("SIGINT", abort);
    lines.close();
    await Promise.allSettled(observers);
    // A launched viewer owns its own lease and must survive input EOF; let in-flight opens settle once.
    await Promise.allSettled(openings);
    options.output.write("입력을 종료합니다. 실행 중인 작업과 진행 창은 계속됩니다.\n");
  }
}
