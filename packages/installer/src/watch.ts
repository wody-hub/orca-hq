import { randomUUID } from "node:crypto";

import {
  isProgressCompaction,
  isProgressEvent,
  ProgressRequestFailed,
  sanitizeDisplayText,
  sanitizeResultText,
  type ContextSnapshot,
  type ProgressClient,
  type ProgressEvent,
  type ProgressFrame,
  type ViewerLeaseHolder
} from "./progress-client.js";

// The server expires a viewer lease after 20s, so refresh well inside that window.
const defaultViewerHeartbeatMs = 5_000;
const defaultReconnectDelayMs = 1_000;
const reconnectMultipliers = [1, 2, 5, 10];
const seenEventKeyLimit = 512;

export type WatchConnection = "connected" | "reconnecting";

/**
 * Public labels for the contract's event kinds. An unlisted kind keeps its wire name so a newly
 * added server observation is still shown rather than silently dropped.
 */
const eventLabels: Readonly<Record<string, string>> = Object.freeze({
  "request.accepted": "요청 접수",
  "request.queued": "실행 대기",
  "agent.started": "작업자 시작",
  "agent.resumed": "작업자 재개",
  "agent.waiting": "대기",
  "clarification.required": "확인 질문",
  "hq.progress": "HQ 진행 설명",
  "tool.started": "도구 시작",
  "tool.completed": "도구 완료",
  "tool.failed": "도구 실패",
  "job.linked": "Orca 작업 접수",
  "job.state": "작업자 상태",
  "request.completed": "요청 완료",
  "request.failed": "요청 실패",
  "recovery.required": "복구 필요",
  "history.compacted": "이전 기록 정리"
});

export interface WatchRendererOptions {
  readonly contextId: string;
  readonly timeZone?: string;
  readonly startedAtMs?: number;
}

export interface WatchRenderer {
  readonly cursor: number;
  header(snapshot: ContextSnapshot): string;
  /** Returns the line to print, or nothing for a replay, a foreign context, or a heartbeat. */
  event(frame: ProgressFrame): string | undefined;
  status(nowMs: number): string;
  clock(occurredAt: string): string;
  setConnection(connection: WatchConnection): void;
  /** Records the server's authoritative context state so the status line never guesses it. */
  setState(state: string): void;
  /** Skips sequences the server can no longer serve after a retention compaction. */
  skipTo(seq: number): void;
}

export function createWatchRenderer(options: WatchRendererOptions): WatchRenderer {
  const clock = new Intl.DateTimeFormat("en-GB", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone })
  });
  const startedAtMs = options.startedAtMs ?? Date.now();
  const seen = new Set<string>();
  let cursor = 0;
  let connection: WatchConnection = "connected";
  let lastEventAt: string | undefined;
  let contextState = "";

  function clockText(occurredAt: string): string {
    const at = new Date(occurredAt);
    return Number.isNaN(at.getTime()) ? "--:--:--" : clock.format(at);
  }

  function label(event: ProgressEvent): string {
    if (event.kind === "context.assigned") {
      return event.payload.relation === "continue" ? "기존 작업 계속" : "새 작업으로 시작";
    }
    return eventLabels[event.kind] ?? sanitizeDisplayText(event.kind);
  }

  function body(event: ProgressEvent): string {
    const text = ["request.completed", "request.failed", "recovery.required"].includes(event.kind)
      ? sanitizeResultText(event.payload.text) : sanitizeDisplayText(event.payload.text);
    if (text !== "") return text;
    return event.kind === "context.assigned" ? sanitizeDisplayText(event.payload.title) : "";
  }

  function remember(eventKey: string): void {
    seen.add(eventKey);
    if (seen.size > seenEventKeyLimit) {
      const oldest = seen.values().next();
      if (!oldest.done) seen.delete(oldest.value);
    }
  }

  return {
    get cursor() { return cursor; },

    header(snapshot) {
      const title = sanitizeDisplayText(snapshot.title);
      contextState = sanitizeDisplayText(snapshot.state);
      const summary = sanitizeResultText(snapshot.summary);
      const state = sanitizeDisplayText(snapshot.state);
      const projects = snapshot.projectIds.map(sanitizeDisplayText).filter(entry => entry !== "").join(", ");
      const lines = [
        `HQ 진행 · ${title === "" ? "제목 없음" : title} [${sanitizeDisplayText(snapshot.contextId)}]`,
        `상태 ${state === "" ? "알 수 없음" : state}${projects === "" ? "" : ` · 프로젝트 ${projects}`}`
      ];
      if (summary !== "") lines.push(`요약 ${summary}`);
      return lines.join("\n");
    },

    event(frame) {
      // A heartbeat proves the connection is alive; it is never progress on the work itself.
      if (!isProgressEvent(frame)) {
        connection = "connected";
        return undefined;
      }
      if (frame.contextId !== null && frame.contextId !== options.contextId) return undefined;
      if (frame.contextId === null && ["request.completed", "request.failed"].includes(frame.kind)) return undefined;
      if (frame.seq <= cursor || seen.has(frame.eventKey)) return undefined;
      cursor = frame.seq;
      remember(frame.eventKey);
      connection = "connected";
      lastEventAt = frame.occurredAt;
      const kindLabel = label(frame);
      const text = body(frame);
      return text === ""
        ? `${clockText(frame.occurredAt)} ${kindLabel}`
        : `${clockText(frame.occurredAt)} ${kindLabel} · ${text}`;
    },

    status(nowMs) {
      const elapsed = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
      const minutes = String(Math.floor(elapsed / 60)).padStart(2, "0");
      const seconds = String(elapsed % 60).padStart(2, "0");
      const last = lastEventAt === undefined ? "없음" : clockText(lastEventAt);
      const connectionText = connection === "connected" ? "연결됨" : "재연결 중";
      // The context state is the server's, never inferred from the last rendered event label.
      return `상태 ${contextState === "" ? "확인 중" : contextState} · 경과 ${minutes}:${seconds} · 마지막 진행 ${last} · 연결 ${connectionText}`;
    },

    clock(occurredAt) { return clockText(occurredAt); },

    setConnection(next) { connection = next; },

    setState(state) { contextState = sanitizeDisplayText(state); },

    skipTo(seq) { if (seq > cursor) cursor = seq; }
  };
}

export interface RunWatchOptions {
  readonly client: ProgressClient;
  readonly contextId: string;
  readonly output: Pick<typeof process.stdout, "write">;
  readonly signal?: AbortSignal;
  /** Lease already reserved by the opener; when absent the viewer reserves its own. */
  readonly viewer?: ViewerLeaseHolder;
  readonly viewerInstanceId?: string;
  readonly timeZone?: string;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly viewerHeartbeatMs?: number;
  readonly reconnectDelayMs?: number;
}

export interface WatchOutcome {
  readonly exitCode: number;
  readonly reason: string;
}

function isMissing(error: unknown): boolean {
  return error instanceof ProgressRequestFailed && error.status === 404;
}

function isLeaseConflict(error: unknown): boolean {
  return error instanceof ProgressRequestFailed && (error.status === 409 || error.status === 404);
}

/**
 * Renders one work context's progress until the operator closes the viewer. Closing is an
 * observation change only: it releases the viewer lease and never stops or cancels the work.
 */
export async function runWatch(options: RunWatchOptions): Promise<WatchOutcome> {
  const { client, contextId, output } = options;
  const now = options.now ?? Date.now;
  const viewerHeartbeatMs = options.viewerHeartbeatMs ?? defaultViewerHeartbeatMs;
  const reconnectDelayMs = options.reconnectDelayMs ?? defaultReconnectDelayMs;
  const write = (text: string) => { output.write(`${text}\n`); };

  const stopper = new AbortController();
  const stopped = () => stopper.signal.aborted || options.signal?.aborted === true;
  const external = options.signal;
  const abort = () => stopper.abort();
  if (external !== undefined) {
    if (external.aborted) stopper.abort();
    else external.addEventListener("abort", abort, { once: true });
  }

  /** Waiting must end the moment the viewer closes, so no timer can outlive the run. */
  async function delay(milliseconds: number): Promise<void> {
    if (stopped()) return;
    await new Promise<void>(resolve => {
      const finish = () => {
        clearTimeout(timer);
        stopper.signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, milliseconds);
      stopper.signal.addEventListener("abort", finish, { once: true });
    });
  }
  const sleep = options.sleep ?? delay;

  let holder: ViewerLeaseHolder | undefined = options.viewer;
  if (holder === undefined) {
    const lease = await client.acquireViewerLease(contextId, options.viewerInstanceId ?? randomUUID());
    if (!lease.acquired || lease.leaseToken === undefined) {
      write(`이 작업의 진행 창이 이미 열려 있습니다. 열려 있는 창에서 계속 확인하세요. [${contextId}]`);
      external?.removeEventListener("abort", abort);
      return { exitCode: 1, reason: "viewer_active" };
    }
    holder = { viewerInstanceId: lease.viewerInstanceId, leaseToken: lease.leaseToken };
  }

  const renderer = createWatchRenderer({
    contextId,
    startedAtMs: now(),
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone })
  });

  async function showSnapshot(): Promise<void> {
    write(renderer.header(await client.getContext(contextId)));
  }

  let reason = "closed";
  const keepAlive = (async () => {
    while (!stopped()) {
      await delay(viewerHeartbeatMs);
      if (stopped()) return;
      try {
        await client.heartbeatViewerLease(contextId, holder!);
      } catch (error) {
        if (!isLeaseConflict(error)) continue;
        // A newer window owns this context; two viewers must never render the same work.
        write("다른 진행 창이 이 작업을 이어받았습니다. 이 창을 닫습니다.");
        reason = "lease_lost";
        stopper.abort();
        return;
      }
      try { renderer.setState((await client.getContext(contextId)).state); } catch { renderer.setConnection("reconnecting"); }
      write(renderer.status(now()));
    }
  })();

  try {
    // Inside the release scope: a failed snapshot read must not strand the viewer lease.
    if (options.viewer !== undefined) {
      try { await client.heartbeatViewerLease(contextId, holder); }
      catch (error) {
        if (isLeaseConflict(error)) return { exitCode: 1, reason: "lease_lost" };
        throw error;
      }
    }
    await showSnapshot();
    let attempt = 0;
    let requestId: string | undefined;
    for (;;) {
      let received = false;
      try {
        for await (const frame of client.streamEvents({
          contextId,
          after: renderer.cursor,
          signal: stopper.signal
        })) {
          received = true;
          if (isProgressCompaction(frame)) {
            // Retention control frame: the snapshots replace history and the cursor jumps forward,
            // because the server follows from latestSeq even when no retained event replays.
            write(`${renderer.clock(frame.occurredAt)} 이전 기록 정리 · 요약으로 대체했습니다`);
            const own = frame.snapshots.find(entry => entry.contextId === contextId);
            if (own !== undefined) renderer.setState(own.state);
            renderer.skipTo(frame.latestSeq);
            await showSnapshot();
            continue;
          }
          let displayFrame = frame;
          if (isProgressEvent(frame) && frame.contextId === contextId
            && ["request.completed", "request.failed", "recovery.required"].includes(frame.kind)
            && typeof frame.payload.text === "string" && frame.payload.text.endsWith("…")) {
            try {
              const current = await client.getContext(contextId);
              renderer.setState(current.state);
              // Only replace a bounded preview with its matching context report, never another context's aggregate.
              if (current.summary.startsWith(frame.payload.text.slice(0, -1))) {
                displayFrame = { ...frame, payload: { ...frame.payload, text: current.summary } };
              }
            } catch { /* Preserve the observed preview while the snapshot reconnects. */ }
          }
          const line = renderer.event(displayFrame);
          if (line !== undefined) {
            if (isProgressEvent(frame) && requestId !== frame.requestId) {
              requestId = frame.requestId;
              write(`요청 [${sanitizeDisplayText(requestId)}]`);
            }
            write(line);
            if (isProgressEvent(frame) && /^(request\.|agent\.|job\.|recovery\.)/u.test(frame.kind)) {
              try { renderer.setState((await client.getContext(contextId)).state); }
              catch { renderer.setConnection("reconnecting"); }
              write(renderer.status(now()));
            }
          }
        }
      } catch (error) {
        if (stopped()) break;
        if (isMissing(error)) {
          write(`이 작업 맥락을 찾을 수 없습니다. [${contextId}]`);
          reason = "context_missing";
          return { exitCode: 1, reason };
        }
      }
      if (stopped()) break;
      renderer.setConnection("reconnecting");
      if (received || attempt === 0) write(renderer.status(now()));
      attempt = received ? 1 : attempt + 1;
      // Yield to the event loop so the viewer heartbeat timer can run between attempts.
      await new Promise<void>(resolve => setImmediate(resolve));
      await sleep(reconnectDelayMs * reconnectMultipliers[Math.min(attempt - 1, reconnectMultipliers.length - 1)]!);
      if (stopped()) break;
    }
  } finally {
    stopper.abort();
    external?.removeEventListener("abort", abort);
    await keepAlive.catch(() => undefined);
    try {
      await client.releaseViewerLease(contextId, holder);
    } catch {
      // The lease expires on its own; failing to hand it back must not fail the viewer.
    }
  }

  write("진행 창을 닫습니다. 실행 중인 작업은 계속됩니다. 중지가 필요하면 HQ에 중지를 지시하세요.");
  return { exitCode: reason === "lease_lost" ? 1 : 0, reason };
}
