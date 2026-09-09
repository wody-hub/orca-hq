import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/u);
const Submit = z
  .object({
    requestId: identifier,
    sessionId: identifier,
    text: z.string().trim().min(1).max(8000),
    contextHint: z
      .discriminatedUnion("mode", [
        z.object({ mode: z.literal("new") }).strict(),
        z
          .object({ mode: z.literal("continue"), contextId: identifier })
          .strict(),
      ])
      .optional(),
  })
  .strict();
export type ProgressSubmission = z.infer<typeof Submit>;
export interface ProgressHttpPort {
  submit(input: ProgressSubmission): unknown;
  request(id: string): unknown;
  contexts(sessionId?: string): unknown[];
  context(id: string): unknown;
  events(filter: { sessionId?: string; contextId?: string; after: number }): {
    events: Array<{ seq: number }>;
    compacted?: unknown;
  };
  viewer(
    action: "acquire" | "heartbeat" | "release",
    contextId: string,
    input: { viewerInstanceId: string; leaseToken?: string },
  ): unknown;
}
async function body(request: IncomingMessage): Promise<unknown> {
  let data = "";
  for await (const chunk of request) {
    data += String(chunk);
    if (Buffer.byteLength(data) > 16384) throw new Error("input_too_large");
  }
  return JSON.parse(data);
}
export function createProgressControl(
  port: ProgressHttpPort,
  options: {
    pollMs?: number;
    heartbeatMs?: number;
    maxBufferedBytes?: number;
  } = {},
) {
  const subscribers = new Set<ServerResponse>();
  const json = (response: ServerResponse, code: number, value: unknown) => {
    response.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify(value));
  };
  return {
    async handle(
      request: IncomingMessage,
      response: ServerResponse,
    ): Promise<boolean> {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (!url.pathname.startsWith("/v1/progress/")) return false;
      try {
        if (
          request.method === "POST" &&
          url.pathname === "/v1/progress/requests"
        ) {
          const input = Submit.parse(await body(request));
          port.submit(input);
          json(response, 202, { requestId: input.requestId, state: "queued" });
          return true;
        }
        if (
          request.method === "GET" &&
          url.pathname === "/v1/progress/contexts"
        ) {
          const session = url.searchParams.get("sessionId");
          json(response, 200, {
            contexts: port.contexts(
              session === null ? undefined : identifier.parse(session),
            ),
          });
          return true;
        }
        const item = url.pathname.match(
          /^\/v1\/progress\/(requests|contexts)\/([^/]+)$/u,
        );
        if (request.method === "GET" && item) {
          const id = identifier.parse(decodeURIComponent(item[2]!));
          const result =
            item[1] === "requests" ? port.request(id) : port.context(id);
          if (!result)
            json(response, 404, { text: "항목을 찾을 수 없습니다." });
          else json(response, 200, result);
          return true;
        }
        const lease = url.pathname.match(
          /^\/v1\/progress\/contexts\/([^/]+)\/(viewer-lease|viewer-heartbeat)$/u,
        );
        if (lease) {
          const contextId = identifier.parse(decodeURIComponent(lease[1]!));
          if (!port.context(contextId)) {
            json(response, 404, { text: "맥락을 찾을 수 없습니다." });
            return true;
          }
          const action =
            request.method === "DELETE" && lease[2] === "viewer-lease"
              ? "release"
              : request.method === "POST"
                ? lease[2] === "viewer-lease"
                  ? "acquire"
                  : "heartbeat"
                : undefined;
          if (!action) {
            json(response, 404, { text: "경로를 찾을 수 없습니다." });
            return true;
          }
          const input = (
            action === "acquire"
              ? z.object({ viewerInstanceId: identifier }).strict()
              : z
                  .object({
                    viewerInstanceId: identifier,
                    leaseToken: z.string().min(1).max(512),
                  })
                  .strict()
          ).parse(await body(request));
          json(response, 200, port.viewer(action, contextId, input));
          return true;
        }
        if (
          request.method === "GET" &&
          url.pathname === "/v1/progress/events"
        ) {
          const session = url.searchParams.get("sessionId"),
            context = url.searchParams.get("contextId");
          if ((session === null) === (context === null))
            throw new Error("one_scope_required");
          const rawAfter = url.searchParams.get("after") ?? "0";
          if (!/^\d+$/u.test(rawAfter)) throw new Error("invalid_cursor");
          let after = Number(rawAfter);
          if (!Number.isSafeInteger(after)) throw new Error("invalid_cursor");
          const filter = {
            ...(session === null
              ? {}
              : { sessionId: identifier.parse(session) }),
            ...(context === null
              ? {}
              : { contextId: identifier.parse(context) }),
          };
          if (context !== null && !port.context(context)) {
            json(response, 404, { text: "맥락을 찾을 수 없습니다." });
            return true;
          }
          // Validate/replay before sending headers so malformed scopes have JSON errors.
          const initial = port.events({ ...filter, after });
          response.writeHead(200, {
            "Content-Type": "application/x-ndjson; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          });
          response.flushHeaders();
          const write = (frame: unknown) => {
            if (response.destroyed) return false;
            if (
              response.writableLength >
              (options.maxBufferedBytes ?? 1024 * 1024)
            ) {
              response.destroy();
              return false;
            }
            return response.write(JSON.stringify(frame) + "\n");
          };
          function emit(batch: ReturnType<ProgressHttpPort["events"]>) {
            if (batch.compacted) {
              write(batch.compacted);
              const frame = batch.compacted as { latestSeq?: number };
              if (Number.isSafeInteger(frame.latestSeq))
                after = Math.max(after, frame.latestSeq!);
              return;
            }
            for (const event of batch.events) {
              if (response.destroyed) break;
              write(event);
              after = event.seq;
            }
          }
          emit(initial);
          if (url.searchParams.get("follow") !== "1") {
            response.end();
            return true;
          }
          subscribers.add(response);
          let heartbeat = Date.now();
          const timer = setInterval(() => {
            try {
              emit(port.events({ ...filter, after }));
              if (Date.now() - heartbeat >= (options.heartbeatMs ?? 10000)) {
                write({
                  kind: "heartbeat",
                  occurredAt: new Date().toISOString(),
                });
                heartbeat = Date.now();
              }
            } catch {
              response.destroy();
            }
          }, options.pollMs ?? 250);
          timer.unref();
          response.once("close", () => {
            clearInterval(timer);
            subscribers.delete(response);
          });
          return true;
        }
        json(response, 404, { text: "경로를 찾을 수 없습니다." });
        return true;
      } catch (error) {
        if (response.headersSent) {
          response.destroy();
          return true;
        }
        const message =
          error instanceof Error ? error.name + " " + error.message : "";
        const status = /conflict|collision|lease|identity/iu.test(message)
          ? 409
          : /not_found|not found/iu.test(message)
            ? 404
            : 400;
        json(response, status, {
          text:
            status === 409
              ? "요청 ID 또는 표시 창 예약이 충돌합니다."
              : "요청을 처리하지 못했습니다. 입력을 확인해주세요.",
        });
        return true;
      }
    },
    close() {
      for (const response of subscribers) response.destroy();
      subscribers.clear();
    },
  };
}
