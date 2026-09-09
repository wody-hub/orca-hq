import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createProgressClient,
  ProgressRequestFailed,
  sanitizeDisplayText,
  type ProgressClient,
  type ProgressFrame
} from "../src/progress-client.js";

type Handler = (request: IncomingMessage, response: ServerResponse, body: string) => void | Promise<void>;

interface Fixture {
  client: ProgressClient;
  readonly received: { method: string; url: string; body: string }[];
  handler: Handler;
}

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function fixture(handler: Handler): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "hq-progress-client-"));
  const socketPath = join(directory, "control.sock");
  const received: { method: string; url: string; body: string }[] = [];
  const state: Fixture = {
    handler,
    received,
    client: undefined as unknown as ProgressClient
  };
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    received.push({ method: request.method ?? "", url: request.url ?? "", body });
    await state.handler(request, response, body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  state.client = createProgressClient({ socketPath, idleTimeoutMs: 400, timeoutMs: 400 });
  return state;
}

function jsonHandler(status: number, payload: unknown): Handler {
  return (_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  };
}

describe("progress submission", () => {
  it("posts the caller's durable request id and returns the queued acknowledgement", async () => {
    // Break caught: a client-generated retry id would replay the same instruction as new work.
    const test = await fixture(jsonHandler(202, { requestId: "req_1", state: "queued" }));

    const accepted = await test.client.submitRequest({
      requestId: "req_1",
      sessionId: "session-1",
      text: "GH 법령 이력관리 구현 현황 검토",
      contextHint: { mode: "continue", contextId: "ctx_a" }
    });

    expect(accepted).toEqual({ requestId: "req_1", state: "queued" });
    expect(test.received).toEqual([{
      method: "POST",
      url: "/v1/progress/requests",
      body: JSON.stringify({
        requestId: "req_1",
        sessionId: "session-1",
        text: "GH 법령 이력관리 구현 현황 검토",
        contextHint: { mode: "continue", contextId: "ctx_a" }
      })
    }]);
  });

  it("omits an absent context hint instead of sending an undefined field", async () => {
    // Break caught: a serialized null hint would be rejected by the server as malformed input.
    const test = await fixture(jsonHandler(202, { requestId: "req_2", state: "queued" }));
    await test.client.submitRequest({ requestId: "req_2", sessionId: "session-1", text: "하만 로그인 오류 확인" });
    expect(JSON.parse(test.received[0]!.body)).toEqual({
      requestId: "req_2",
      sessionId: "session-1",
      text: "하만 로그인 오류 확인"
    });
  });

  it("surfaces the server status and error text without inventing an acceptance", async () => {
    // Break caught: treating a 409 collision as accepted would hide a conflicting duplicate id.
    const test = await fixture(jsonHandler(409, { text: "동일 요청 ID에 다른 본문이 있습니다." }));

    const failure = await test.client
      .submitRequest({ requestId: "req_3", sessionId: "session-1", text: "충돌" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProgressRequestFailed);
    expect(failure).toMatchObject({ status: 409, text: "동일 요청 ID에 다른 본문이 있습니다." });
  });

  it("rejects a malformed acceptance body rather than reporting a queued request", async () => {
    // Break caught: a truncated or renamed acknowledgement would look like durable acceptance.
    const test = await fixture(jsonHandler(202, { requestId: "req_4" }));
    await expect(test.client.submitRequest({ requestId: "req_4", sessionId: "s", text: "x" }))
      .rejects.toThrow("progress_response_invalid");
  });
});

describe("progress discovery", () => {
  const snapshot = {
    contextId: "ctx_a",
    title: "법령 이력관리",
    state: "running",
    summary: "구현 현황 검토 중",
    projectIds: ["gh"],
    jobIds: ["job_1"],
    createdAt: "2026-09-08T02:00:00.000Z",
    updatedAt: "2026-09-08T02:00:05.000Z",
    lastSeq: 12
  };

  it("reads request state, context snapshots and the context list over GET only", async () => {
    // Break caught: resume discovery that re-posts the request would duplicate execution.
    const test = await fixture((request, response) => {
      if (request.url === "/v1/progress/requests/req_1") {
        jsonHandler(200, {
          requestId: "req_1",
          sessionId: "session-1",
          state: "running",
          contextIds: ["ctx_a", "ctx_b"],
          result: { text: "검토 완료", jobId: "job_1" }
        })(request, response, "");
        return;
      }
      if (request.url === "/v1/progress/contexts/ctx_a") {
        jsonHandler(200, snapshot)(request, response, "");
        return;
      }
      jsonHandler(200, { contexts: [snapshot] })(request, response, "");
    });

    const status = await test.client.getRequest("req_1");
    const context = await test.client.getContext("ctx_a");
    const listed = await test.client.listContexts("session-1");

    expect(status).toEqual({
      requestId: "req_1",
      sessionId: "session-1",
      state: "running",
      contextIds: ["ctx_a", "ctx_b"],
      result: { text: "검토 완료", jobId: "job_1" }
    });
    expect(context).toMatchObject(snapshot);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject(snapshot);
    expect(test.received.map(entry => `${entry.method} ${entry.url}`)).toEqual([
      "GET /v1/progress/requests/req_1",
      "GET /v1/progress/contexts/ctx_a",
      "GET /v1/progress/contexts?sessionId=session-1"
    ]);
    expect(test.received.every(entry => entry.body === "")).toBe(true);
  });

  it("refuses identifiers that are not opaque tokens before opening the socket", async () => {
    // Break caught: an unvalidated id reaches the request path and can address another owner's item.
    const test = await fixture(jsonHandler(200, {}));
    for (const bad of ["", "../other", "ctx a", "ctx/../x", "a".repeat(201)]) {
      await expect(test.client.getContext(bad)).rejects.toThrow("progress_identifier_invalid");
      await expect(test.client.getRequest(bad)).rejects.toThrow("progress_identifier_invalid");
    }
    expect(test.received).toEqual([]);
  });

  it("drops a context snapshot whose fields are renamed or mistyped", async () => {
    // Break caught: rendering an unvalidated snapshot would print `undefined` as a work title.
    const test = await fixture(jsonHandler(200, { contextId: "ctx_a", title: 5, state: "running" }));
    await expect(test.client.getContext("ctx_a")).rejects.toThrow("progress_response_invalid");
  });

  it("keeps augmented snapshot fields available instead of failing on them", async () => {
    // Break caught: the contract allows added fields, so strict rejection would break on a server upgrade.
    const test = await fixture(jsonHandler(200, { ...snapshot, ownerKey: "local" }));
    await expect(test.client.getContext("ctx_a")).resolves.toMatchObject({ contextId: "ctx_a", lastSeq: 12 });
  });
});

describe("viewer leases", () => {
  it("acquires, heartbeats and releases a lease with the issued token", async () => {
    // Break caught: a client-invented lease token would let a second viewer claim a live window.
    const test = await fixture((request, response) => {
      if (request.method === "POST" && request.url!.endsWith("/viewer-lease")) {
        jsonHandler(200, {
          acquired: true,
          viewerInstanceId: "viewer-1",
          leaseToken: "token-1",
          expiresAt: "2026-09-08T02:01:00.000Z"
        })(request, response, "");
        return;
      }
      jsonHandler(200, { ok: true })(request, response, "");
    });

    const lease = await test.client.acquireViewerLease("ctx_a", "viewer-1");
    expect(lease).toEqual({
      acquired: true,
      viewerInstanceId: "viewer-1",
      leaseToken: "token-1",
      expiresAt: "2026-09-08T02:01:00.000Z"
    });

    await test.client.heartbeatViewerLease("ctx_a", { viewerInstanceId: "viewer-1", leaseToken: "token-1" });
    await test.client.releaseViewerLease("ctx_a", { viewerInstanceId: "viewer-1", leaseToken: "token-1" });

    expect(test.received.map(entry => `${entry.method} ${entry.url}`)).toEqual([
      "POST /v1/progress/contexts/ctx_a/viewer-lease",
      "POST /v1/progress/contexts/ctx_a/viewer-heartbeat",
      "DELETE /v1/progress/contexts/ctx_a/viewer-lease"
    ]);
    expect(JSON.parse(test.received[2]!.body)).toEqual({ viewerInstanceId: "viewer-1", leaseToken: "token-1" });
  });

  it("keeps a denied acquisition without a token instead of fabricating one", async () => {
    // Break caught: accepting a token on a denied lease would open a duplicate progress window.
    const test = await fixture(jsonHandler(200, {
      acquired: false,
      viewerInstanceId: "viewer-2",
      expiresAt: "2026-09-08T02:01:00.000Z"
    }));
    const lease = await test.client.acquireViewerLease("ctx_a", "viewer-2");
    expect(lease.acquired).toBe(false);
    expect(lease.leaseToken).toBeUndefined();
  });

  it("reports a stale-token conflict as a failure with the server status", async () => {
    // Break caught: a silently swallowed 409 would let an expired viewer keep claiming the context.
    const test = await fixture(jsonHandler(409, { text: "lease_token_stale" }));
    await expect(test.client.heartbeatViewerLease("ctx_a", { viewerInstanceId: "v", leaseToken: "old" }))
      .rejects.toMatchObject({ status: 409, text: "lease_token_stale" });
  });
});

describe("event stream", () => {
  async function collect(frames: AsyncIterable<ProgressFrame>, count: number): Promise<ProgressFrame[]> {
    const collected: ProgressFrame[] = [];
    for await (const frame of frames) {
      collected.push(frame);
      if (collected.length >= count) break;
    }
    return collected;
  }

  it("parses ordered NDJSON events split across chunk boundaries and keeps heartbeats seqless", async () => {
    // Break caught: chunk-aligned JSON parsing drops an event whose line spans two socket writes.
    const test = await fixture((_request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      const first = JSON.stringify({
        seq: 4, eventKey: "k4", requestId: "req_1", contextId: "ctx_a",
        kind: "tool.started", source: "tool", occurredAt: "2026-09-08T02:00:04.000Z",
        payload: { text: "GH 작업 조회" }
      });
      response.write(first.slice(0, 20));
      setTimeout(() => response.write(
        `${first.slice(20)}\n{"kind":"heartbeat","occurredAt":"2026-09-08T02:00:05.000Z"}\n`
      ), 5);
      setTimeout(() => response.write(`${JSON.stringify({
        seq: 5, eventKey: "k5", requestId: "req_1", contextId: "ctx_a",
        kind: "request.completed", source: "hq", occurredAt: "2026-09-08T02:00:06.000Z",
        payload: { text: "완료" }
      })}\n`), 10);
    });

    const frames = await collect(test.client.streamEvents({ contextId: "ctx_a", after: 3 }), 3);

    expect(test.received[0]!.url).toBe("/v1/progress/events?contextId=ctx_a&after=3&follow=1");
    expect(frames[0]).toMatchObject({ seq: 4, kind: "tool.started", payload: { text: "GH 작업 조회" } });
    expect(frames[1]).toEqual({ kind: "heartbeat", occurredAt: "2026-09-08T02:00:05.000Z" });
    expect(frames[2]).toMatchObject({ seq: 5, kind: "request.completed" });
  });

  it("streams by session id when no context is given", async () => {
    // Break caught: a session subscription that silently becomes a context subscription hides new work.
    const test = await fixture((_request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.end(`${JSON.stringify({
        seq: 1, eventKey: "k1", requestId: "req_1", contextId: null,
        kind: "request.accepted", source: "system", occurredAt: "2026-09-08T02:00:00.000Z", payload: {}
      })}\n`);
    });

    const frames = await collect(test.client.streamEvents({ sessionId: "session-1", after: 0 }), 1);
    expect(test.received[0]!.url).toBe("/v1/progress/events?sessionId=session-1&after=0&follow=1");
    expect(frames[0]).toMatchObject({ seq: 1, contextId: null, kind: "request.accepted" });
  });

  it("skips malformed and mistyped lines instead of ending a live subscription", async () => {
    // Break caught: one bad frame would end the stream and strand the viewer without progress.
    const test = await fixture((_request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.end([
        "not json",
        JSON.stringify({ seq: 2, eventKey: "k2", requestId: "r", contextId: "ctx_a", kind: "x", source: "hq", occurredAt: "t", payload: 3 }),
        JSON.stringify({
          seq: 3, eventKey: "k3", requestId: "req_1", contextId: "ctx_a",
          kind: "hq.progress", source: "hq", occurredAt: "2026-09-08T02:00:03.000Z", payload: { text: "확인" }
        }),
        ""
      ].join("\n"));
    });

    const frames = await collect(test.client.streamEvents({ contextId: "ctx_a", after: 1 }), 1);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ seq: 3, kind: "hq.progress" });
  });

  it("fails the subscription when the connection goes silent past the idle timeout", async () => {
    // Break caught: a dead socket with no heartbeat would look like a quiet but healthy run forever.
    const test = await fixture((_request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.write("");
    });

    await expect(collect(test.client.streamEvents({ contextId: "ctx_a", after: 0 }), 1))
      .rejects.toThrow("progress_stream_stalled");
  });

  it("ends the subscription quietly when the caller aborts", async () => {
    // Break caught: Ctrl+C in a viewer must close the subscription without an unhandled rejection.
    const test = await fixture((_request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.write(`${JSON.stringify({
        seq: 1, eventKey: "k1", requestId: "req_1", contextId: "ctx_a",
        kind: "hq.progress", source: "hq", occurredAt: "2026-09-08T02:00:01.000Z", payload: { text: "확인" }
      })}\n`);
    });
    const controller = new AbortController();
    const collected: ProgressFrame[] = [];

    for await (const frame of test.client.streamEvents({ contextId: "ctx_a", after: 0, signal: controller.signal })) {
      collected.push(frame);
      controller.abort();
    }

    expect(collected).toHaveLength(1);
  });

  it("rejects a subscription that names neither a session nor a context", async () => {
    // Break caught: an unscoped stream would show another work context's tool output.
    const test = await fixture(jsonHandler(200, {}));
    await expect(collect(test.client.streamEvents({ after: 0 } as never), 1))
      .rejects.toThrow("progress_stream_scope_invalid");
    expect(test.received).toEqual([]);
  });

  it("fails a subscription the server refuses instead of looping on an error body", async () => {
    // Break caught: a 404 for an unknown context would be parsed as an empty but healthy stream.
    const test = await fixture(jsonHandler(404, { text: "context_missing" }));
    await expect(collect(test.client.streamEvents({ contextId: "ctx_gone", after: 0 }), 1))
      .rejects.toMatchObject({ status: 404, text: "context_missing" });
  });
});

describe("display sanitizing", () => {
  const escape = String.fromCharCode(0x1b);
  const bell = String.fromCharCode(0x07);

  it("removes escape, OSC and control sequences that would rewrite the viewer terminal", () => {
    // Break caught: server text containing OSC or CSI codes could relabel the window or hide lines.
    expect(sanitizeDisplayText(`${escape}]0;가짜 제목${escape}\\정상 ${escape}[2J텍스트`)).toBe("정상 텍스트");
    expect(sanitizeDisplayText("줄1\r\n줄2")).toBe("줄1 줄2");
    expect(sanitizeDisplayText("탭\t유지")).toBe("탭 유지");
    expect(sanitizeDisplayText(`${escape}[31m빨강${escape}[0m`)).toBe("빨강");
    expect(sanitizeDisplayText(`경보${bell}끝`)).toBe("경보 끝");
  });

  it("bounds length and ignores non-string input without throwing", () => {
    // Break caught: an unbounded or non-string payload field would corrupt the fixed status area.
    expect(sanitizeDisplayText("가".repeat(500)).length).toBeLessThanOrEqual(400);
    expect(sanitizeDisplayText(undefined)).toBe("");
    expect(sanitizeDisplayText({ text: "x" })).toBe("");
  });
});

it("preserves UTF-8 text split inside a multi-byte character", async () => {
  const test = await fixture((_request, response) => {
    const body = Buffer.from(`${JSON.stringify({ seq: 1, eventKey: "k1", requestId: "r", contextId: "ctx_a", kind: "hq.progress", source: "hq", occurredAt: "now", payload: { text: "한글 완료" } })}\n`);
    const split = body.indexOf(Buffer.from("한")) + 1;
    response.write(body.subarray(0, split));
    setTimeout(() => response.end(body.subarray(split)), 5);
  });
  const frames = [];
  for await (const frame of test.client.streamEvents({ contextId: "ctx_a", after: 0 })) frames.push(frame);
  expect(frames[0]).toMatchObject({ payload: { text: "한글 완료" } });
});

it("removes abort listeners across repeated stream reconnections", async () => {
  const { default: EventEmitter } = await import("node:events");
  const test = await fixture((_request, response) => { response.end('{"kind":"heartbeat","occurredAt":"now"}\n'); });
  const controller = new AbortController();
  for (let attempt = 0; attempt < 12; attempt++) {
    for await (const _frame of test.client.streamEvents({ contextId: "ctx_a", after: 0, signal: controller.signal })) { /* consume */ }
  }
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(EventEmitter.getEventListeners(controller.signal, "abort")).toHaveLength(0);
});

it("treats an already aborted subscription as closed", async () => {
  const test = await fixture(jsonHandler(200, {}));
  const controller = new AbortController(); controller.abort();
  const frames = [];
  for await (const frame of test.client.streamEvents({ contextId: "ctx_a", after: 0, signal: controller.signal })) frames.push(frame);
  expect(frames).toEqual([]);
  expect(test.received).toEqual([]);
});

it("deadlines an error response whose headers arrive but whose body never finishes", async () => {
  const test = await fixture((_request, response) => {
    response.writeHead(503, { "content-type": "application/json" });
    response.flushHeaders();
  });
  const frames = (async () => { for await (const _frame of test.client.streamEvents({ contextId: "ctx_a", after: 0 })) { /* consume */ } })();
  await expect(frames).rejects.toThrow("progress_request_timeout");
}, 1000);
