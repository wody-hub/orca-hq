import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

import {
  ProgressRequestFailed,
  type ContextSnapshot,
  type ProgressClient,
  type ProgressFrame,
  type ProgressStreamOptions,
  type ViewerLease,
  type ViewerLeaseHolder
} from "../src/progress-client.js";
import { createWatchRenderer, runWatch } from "../src/watch.js";

const escape = String.fromCharCode(0x1b);

function snapshot(overrides: Partial<ContextSnapshot> = {}): ContextSnapshot {
  return {
    contextId: "ctx_a",
    title: "법령 이력관리",
    state: "running",
    summary: "구현 현황 검토",
    projectIds: ["gh"],
    jobIds: [],
    createdAt: "2026-09-08T02:00:00.000Z",
    updatedAt: "2026-09-08T02:00:00.000Z",
    lastSeq: 0,
    ...overrides
  };
}

function event(seq: number, kind: string, payload: Record<string, unknown>, contextId: string | null = "ctx_a"): ProgressFrame {
  return {
    seq,
    eventKey: `k${seq}`,
    requestId: "req_1",
    contextId,
    kind,
    source: "hq",
    occurredAt: `2026-09-08T02:00:${String(seq).padStart(2, "0")}.000Z`,
    payload
  };
}

interface FakeClientOptions {
  readonly snapshots?: readonly ContextSnapshot[];
  readonly batches?: readonly (readonly ProgressFrame[])[];
  readonly lease?: ViewerLease;
  readonly heartbeatFailure?: ProgressRequestFailed;
  readonly streamFailure?: unknown;
}

interface FakeClient extends ProgressClient {
  readonly cursors: number[];
  readonly leaseCalls: string[];
  readonly heartbeats: number[];
  readonly released: ViewerLeaseHolder[];
  readonly snapshotReads: number[];
}

function fakeClient(options: FakeClientOptions = {}): FakeClient {
  const cursors: number[] = [];
  const leaseCalls: string[] = [];
  const heartbeats: number[] = [];
  const released: ViewerLeaseHolder[] = [];
  const snapshotReads: number[] = [];
  const batches = options.batches ?? [];
  const snapshots = options.snapshots ?? [snapshot()];
  let attempt = 0;
  let heartbeatCount = 0;
  return {
    cursors,
    leaseCalls,
    heartbeats,
    released,
    snapshotReads,
    async submitRequest() { throw new Error("unused"); },
    async getRequest() { throw new Error("unused"); },
    async listContexts() { return []; },
    async getContext() {
      const index = Math.min(snapshotReads.length, snapshots.length - 1);
      snapshotReads.push(index);
      return snapshots[index]!;
    },
    async acquireViewerLease(contextId, viewerInstanceId) {
      leaseCalls.push(`${contextId}:${viewerInstanceId}`);
      return options.lease ?? {
        acquired: true,
        viewerInstanceId,
        leaseToken: "token-1",
        expiresAt: "2026-09-08T02:05:00.000Z"
      };
    },
    async heartbeatViewerLease() {
      heartbeatCount += 1;
      heartbeats.push(heartbeatCount);
      if (options.heartbeatFailure !== undefined) throw options.heartbeatFailure;
    },
    async releaseViewerLease(_contextId, holder) { released.push(holder); },
    streamEvents(streamOptions: ProgressStreamOptions) {
      cursors.push(streamOptions.after);
      const batch = batches[attempt] ?? [];
      attempt += 1;
      const failure = options.streamFailure;
      return {
        async *[Symbol.asyncIterator]() {
          for (const frame of batch) yield frame;
          if (failure !== undefined) throw failure;
        }
      };
    }
  };
}

function collector(): { write(text: string): boolean; readonly lines: string[]; text(): string } {
  const chunks: string[] = [];
  return {
    write(text: string) { chunks.push(text); return true; },
    get lines() { return chunks.join("").split("\n").filter(line => line.trim() !== ""); },
    text() { return chunks.join(""); }
  };
}

describe("watch renderer", () => {
  it("renders a sanitized header and one line per observed event with its own timestamp", () => {
    // Break caught: a model-written title carrying OSC codes would relabel the operator's window.
    const renderer = createWatchRenderer({ contextId: "ctx_a", timeZone: "UTC" });
    const header = renderer.header(snapshot({ title: `${escape}]0;가짜${escape}\\법령 이력관리` }));
    const lines = [
      renderer.event(event(1, "request.accepted", { text: "구현 현황 검토" })),
      renderer.event(event(2, "context.assigned", { title: "법령 이력관리", relation: "new", contextId: "ctx_a" })),
      renderer.event(event(3, "tool.started", { text: "GH 작업 조회" })),
      renderer.event(event(4, "tool.completed", { text: "작업 공간 1개 확인" })),
      renderer.event(event(5, "job.linked", { text: "task_123" })),
      renderer.event(event(6, "job.state", { text: "실행 중" }))
    ];

    expect(header).toContain("법령 이력관리");
    expect(header).toContain("ctx_a");
    expect(header).not.toContain("가짜");
    expect(lines).toEqual([
      "02:00:01 요청 접수 · 구현 현황 검토",
      "02:00:02 새 작업으로 시작 · 법령 이력관리",
      "02:00:03 도구 시작 · GH 작업 조회",
      "02:00:04 도구 완료 · 작업 공간 1개 확인",
      "02:00:05 Orca 작업 접수 · task_123",
      "02:00:06 작업자 상태 · 실행 중"
    ]);
  });

  it("names a continued context by its relation instead of announcing new work", () => {
    // Break caught: showing a follow-up as new work would suggest a duplicate agent was started.
    const renderer = createWatchRenderer({ contextId: "ctx_a", timeZone: "UTC" });
    expect(renderer.event(event(1, "context.assigned", { title: "법령 이력관리", relation: "continue" })))
      .toBe("02:00:01 기존 작업 계속 · 법령 이력관리");
  });

  it("advances the cursor only on valid sequences and drops replays and foreign contexts", () => {
    // Break caught: a reconnect replay or another context's tool output would appear as new progress.
    const renderer = createWatchRenderer({ contextId: "ctx_a", timeZone: "UTC" });

    expect(renderer.event(event(4, "hq.progress", { text: "확인" }))).toBe("02:00:04 HQ 진행 설명 · 확인");
    expect(renderer.cursor).toBe(4);
    expect(renderer.event(event(4, "hq.progress", { text: "확인" }))).toBeUndefined();
    expect(renderer.event(event(3, "hq.progress", { text: "과거" }))).toBeUndefined();
    expect(renderer.event(event(5, "tool.started", { text: "다른 업무" }, "ctx_b"))).toBeUndefined();
    expect(renderer.cursor).toBe(4);
    expect(renderer.event({ kind: "heartbeat", occurredAt: "2026-09-08T02:00:10.000Z" })).toBeUndefined();
    expect(renderer.cursor).toBe(4);
  });

  it("keeps a heartbeat out of the progress log while refreshing the connection status", () => {
    // Break caught: rendering heartbeats as steps would invent progress a silent model never made.
    const renderer = createWatchRenderer({ contextId: "ctx_a", timeZone: "UTC", startedAtMs: 0 });
    renderer.event(event(1, "hq.progress", { text: "확인" }));
    const quiet = renderer.status(42_000);
    renderer.event({ kind: "heartbeat", occurredAt: "2026-09-08T02:00:30.000Z" });
    const afterHeartbeat = renderer.status(45_000);

    expect(quiet).toContain("경과 00:42");
    expect(quiet).toContain("마지막 진행 02:00:01");
    expect(afterHeartbeat).toContain("경과 00:45");
    expect(afterHeartbeat).toContain("마지막 진행 02:00:01");
    expect(afterHeartbeat).toContain("연결 연결됨");
  });

  it("reports a lost connection without claiming the work stopped", () => {
    // Break caught: an observation failure must not be shown as an execution failure.
    const renderer = createWatchRenderer({ contextId: "ctx_a", timeZone: "UTC", startedAtMs: 0 });
    renderer.setConnection("reconnecting");
    const status = renderer.status(10_000);
    expect(status).toContain("연결 재연결 중");
    expect(status).not.toContain("실패");
  });

  it("labels an unfamiliar event kind instead of hiding a real observation", () => {
    // Break caught: dropping a newly added server event kind would silently lose progress.
    const renderer = createWatchRenderer({ contextId: "ctx_a", timeZone: "UTC" });
    expect(renderer.event(event(1, "agent.waiting", { text: "다른 작업의 수정 완료 대기" })))
      .toBe("02:00:01 대기 · 다른 작업의 수정 완료 대기");
    expect(renderer.event(event(2, "future.kind", { text: "새 관찰" }))).toBe("02:00:02 future.kind · 새 관찰");
  });
});

describe("watch process", () => {
  it("acquires its own lease, subscribes from the snapshot cursor and releases on abort", async () => {
    // Break caught: a direct `hq watch` without a lease would let two windows own one context.
    const client = fakeClient({
      snapshots: [snapshot({ lastSeq: 7 })],
      batches: [[event(8, "hq.progress", { text: "확인" })]]
    });
    const output = collector();
    const controller = new AbortController();

    const result = await runWatch({
      client,
      contextId: "ctx_a",
      output,
      signal: controller.signal,
      timeZone: "UTC",
      viewerInstanceId: "viewer-1",
      sleep: async () => { controller.abort(); },
      now: () => 0
    });

    expect(client.leaseCalls).toEqual(["ctx_a:viewer-1"]);
    expect(client.cursors).toEqual([0]);
    expect(result.exitCode).toBe(0);
    expect(client.released).toEqual([{ viewerInstanceId: "viewer-1", leaseToken: "token-1" }]);
    expect(output.text()).toContain("02:00:08 HQ 진행 설명 · 확인");
    expect(output.text()).toContain("실행 중인 작업은 계속됩니다");
  });

  it("reuses the lease the opener already reserved rather than acquiring a second one", async () => {
    // Break caught: re-acquiring in the opened window would race its own opener and be denied.
    const client = fakeClient({ batches: [[event(1, "hq.progress", { text: "확인" })]] });
    const output = collector();
    const controller = new AbortController();

    await runWatch({
      client,
      contextId: "ctx_a",
      output,
      signal: controller.signal,
      timeZone: "UTC",
      viewer: { viewerInstanceId: "viewer-9", leaseToken: "token-9" },
      sleep: async () => { controller.abort(); },
      now: () => 0
    });

    expect(client.leaseCalls).toEqual([]);
    expect(client.released).toEqual([{ viewerInstanceId: "viewer-9", leaseToken: "token-9" }]);
  });

  it("refuses to open a second viewer when the lease is already held", async () => {
    // Break caught: two live viewers on one context would duplicate windows for the same work.
    const client = fakeClient({
      lease: { acquired: false, viewerInstanceId: "viewer-1", expiresAt: "2026-09-08T02:05:00.000Z" }
    });
    const output = collector();

    const result = await runWatch({
      client,
      contextId: "ctx_a",
      output,
      timeZone: "UTC",
      viewerInstanceId: "viewer-1",
      signal: new AbortController().signal,
      now: () => 0
    });

    expect(result.exitCode).toBe(1);
    expect(result.reason).toBe("viewer_active");
    expect(client.cursors).toEqual([]);
    expect(output.text()).toContain("이미 열려 있습니다");
  });

  it("resumes from the last received sequence after a dropped connection", async () => {
    // Break caught: reconnecting from zero would replay history or, from the snapshot, skip events.
    const client = fakeClient({
      snapshots: [snapshot({ lastSeq: 3 })],
      batches: [
        [event(4, "hq.progress", { text: "첫 확인" })],
        [event(5, "tool.started", { text: "두번째" })]
      ]
    });
    const output = collector();
    const controller = new AbortController();
    let sleeps = 0;

    await runWatch({
      client,
      contextId: "ctx_a",
      output,
      signal: controller.signal,
      timeZone: "UTC",
      viewerInstanceId: "viewer-1",
      sleep: async () => {
        sleeps += 1;
        if (sleeps >= 2) controller.abort();
      },
      now: () => 0
    });

    expect(client.cursors).toEqual([0, 4]);
    expect(output.text()).toContain("연결 재연결 중");
    expect(output.text()).toContain("02:00:05 도구 시작 · 두번째");
  });

  it("stops the viewer when its lease token has gone stale", async () => {
    // Break caught: a viewer that ignored a lost lease would keep rendering next to a newer window.
    const client = fakeClient({
      batches: [[event(1, "hq.progress", { text: "확인" })]],
      heartbeatFailure: new ProgressRequestFailed(409, "lease_token_stale")
    });
    const output = collector();

    const result = await runWatch({
      client,
      contextId: "ctx_a",
      output,
      timeZone: "UTC",
      viewerInstanceId: "viewer-1",
      signal: new AbortController().signal,
      sleep: async () => undefined,
      viewerHeartbeatMs: 0,
      now: () => 0
    });

    expect(result.reason).toBe("lease_lost");
    expect(output.text()).toContain("다른 진행 창");
  });

  it("keeps the viewer open after the request completes so a follow-up stays visible", async () => {
    // Break caught: exiting on completion would close the window the user needs for follow-ups.
    const client = fakeClient({
      batches: [[
        event(1, "request.completed", { text: "검토 완료" })
      ]]
    });
    const output = collector();
    const controller = new AbortController();
    let sleeps = 0;

    const result = await runWatch({
      client,
      contextId: "ctx_a",
      output,
      signal: controller.signal,
      timeZone: "UTC",
      viewerInstanceId: "viewer-1",
      sleep: async () => {
        sleeps += 1;
        if (sleeps >= 3) controller.abort();
      },
      now: () => 0
    });

    expect(sleeps).toBeGreaterThanOrEqual(3);
    expect(result.exitCode).toBe(0);
    expect(output.text()).toContain("02:00:01 요청 완료 · 검토 완료");
  });

  it("reports a missing context once instead of reconnecting forever", async () => {
    // Break caught: retrying a 404 would spin a window on a context that no longer exists.
    const client = fakeClient({ streamFailure: new ProgressRequestFailed(404, "context_missing") });
    const output = collector();

    const result = await runWatch({
      client,
      contextId: "ctx_a",
      output,
      timeZone: "UTC",
      viewerInstanceId: "viewer-1",
      signal: new AbortController().signal,
      sleep: async () => undefined,
      now: () => 0
    });

    expect(result.exitCode).toBe(1);
    expect(result.reason).toBe("context_missing");
    expect(client.cursors).toHaveLength(1);
  });

  it("re-reads the snapshot and skips purged sequences after a retention compaction", async () => {
    // Break caught: staying on a purged cursor would ask for sequences the server can no longer serve.
    const client = fakeClient({
      snapshots: [snapshot({ lastSeq: 0 }), snapshot({ lastSeq: 40, summary: "압축 후 요약" })],
      batches: [
        [{
          kind: "history.compacted" as const,
          occurredAt: "2026-09-08T02:00:09.000Z",
          oldestSeq: 41,
          latestSeq: 41,
          snapshots: [snapshot({ lastSeq: 41, summary: "압축 후 요약", state: "running" })]
        }],
        []
      ]
    });
    const output = collector();
    const controller = new AbortController();
    let sleeps = 0;

    await runWatch({
      client,
      contextId: "ctx_a",
      output,
      signal: controller.signal,
      timeZone: "UTC",
      viewerInstanceId: "viewer-1",
      sleep: async () => {
        sleeps += 1;
        if (sleeps >= 2) controller.abort();
      },
      now: () => 0
    });

    expect(client.snapshotReads).toHaveLength(2);
    // The seq-less control frame advances the cursor to latestSeq; replay may legitimately be empty.
    expect(client.cursors).toEqual([0, 41]);
    expect(output.text()).toContain("압축 후 요약");
    expect(output.text()).toContain("이전 기록 정리");
  });
});

it("refreshes authoritative state after HQ completion while native work continues", async () => {
  const client = fakeClient({ snapshots: [snapshot({ state: "executing" }), snapshot({ state: "worker_running" })], batches: [[event(1, "request.completed", { text: "전달 완료" })]] });
  const output = collector();
  const controller = new AbortController();
  await runWatch({ client, contextId: "ctx_a", output, signal: controller.signal, sleep: async () => { controller.abort(); } });
  expect(client.snapshotReads.length).toBeGreaterThan(1);
  expect(output.text()).toContain("상태 worker_running");
});

it("releases its lease on initial snapshot failure without waiting for the heartbeat interval", async () => {
  const client = fakeClient();
  client.getContext = async () => { throw new Error("offline"); };
  const start = Date.now();
  await expect(runWatch({ client, contextId: "ctx_a", output: collector(), viewerHeartbeatMs: 60_000 })).rejects.toThrow("offline");
  expect(Date.now() - start).toBeLessThan(1000);
  expect(client.released).toHaveLength(1);
});

it("exits promptly on Ctrl+C during heartbeat sleep and never calls an execution endpoint", async () => {
  const client = fakeClient();
  const controller = new AbortController();
  const started = Date.now();
  const output = collector();
  client.streamEvents = () => ({ async *[Symbol.asyncIterator]() {
    controller.abort();
  } });
  await runWatch({ client, contextId: "ctx_a", output, signal: controller.signal, viewerHeartbeatMs: 60_000 });
  expect(Date.now() - started).toBeLessThan(1000);
  expect(client.released).toHaveLength(1);
});

it("rejects a stale inherited lease before subscribing to context events", async () => {
  const client = fakeClient({ heartbeatFailure: new ProgressRequestFailed(409, "stale") });
  expect(await runWatch({ client, contextId: "ctx_a", output: collector(), viewer: { viewerInstanceId: "old", leaseToken: "old" } }))
    .toMatchObject({ exitCode: 1, reason: "lease_lost" });
  expect(client.cursors).toEqual([]);
});

it("shows complete multiline context results beyond the short progress-line limit", () => {
  const report = `결과\n${"상세 검토\n".repeat(1000)}최종 결론`;
  const renderer = createWatchRenderer({ contextId: "ctx_a" });
  expect(renderer.event(event(1, "request.completed", { text: `${escape}[2J${report}` }))).toContain(report);
});

it("hydrates bounded final event text from the authoritative context summary", async () => {
  const report = `긴 결과\n${"상세\n".repeat(2000)}끝`;
  const client = fakeClient({ snapshots: [snapshot(), snapshot({ summary: report })], batches: [[event(1, "request.completed", { text: "긴 결과…" })]] });
  const controller = new AbortController();
  const output = collector();
  await runWatch({ client, contextId: "ctx_a", output, signal: controller.signal, sleep: async () => { controller.abort(); } });
  expect(output.text()).toContain(report);
});


it("wires hq watch inherited lease flags and removes its process signal handlers on detach", async () => {
  const client = fakeClient();
  const controller = new AbortController();
  const before = ["SIGINT", "SIGTERM", "SIGHUP"].map(signal => process.listenerCount(signal));
  client.streamEvents = () => ({ async *[Symbol.asyncIterator]() { controller.abort(); } });
  expect(await runCli(["watch", "--context", "ctx_a", "--viewer-instance", "viewer", "--lease-token", "token"], {
    progress: client, stdout: collector(), signal: controller.signal
  })).toBe(0);
  expect(client.leaseCalls).toEqual([]);
  expect(client.released).toEqual([{ viewerInstanceId: "viewer", leaseToken: "token" }]);
  expect(["SIGINT", "SIGTERM", "SIGHUP"].map(signal => process.listenerCount(signal))).toEqual(before);
});
