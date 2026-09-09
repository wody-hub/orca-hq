import { request, type IncomingMessage } from "node:http";
import { StringDecoder } from "node:string_decoder";

import { controlSocketPath } from "./control.js";

const defaultTimeoutMs = 15_000;
const defaultIdleTimeoutMs = 30_000;
const defaultMaxBodyBytes = 256 * 1024;
const defaultMaxLineBytes = 1024 * 1024;
const displayTextLimit = 400;

/** Opaque server-issued identifiers; nothing outside this shape may reach a request path or a window command. */
const opaqueIdentifier = /^[A-Za-z0-9_.:-]{1,200}$/;

export type ContextHintMode = "new" | "continue";

export interface ContextHint {
  readonly mode: ContextHintMode;
  readonly contextId?: string;
}

export interface SubmitProgressRequest {
  readonly requestId: string;
  readonly sessionId: string;
  readonly text: string;
  readonly contextHint?: ContextHint;
}

export interface ProgressAcceptance {
  readonly requestId: string;
  readonly state: string;
}

export interface ProgressRequestResult {
  readonly text: string;
  readonly jobId?: string;
}

export interface ProgressRequestStatus {
  readonly requestId: string;
  readonly sessionId: string;
  readonly state: string;
  readonly contextIds: readonly string[];
  readonly result?: ProgressRequestResult;
}

export interface ContextSnapshot {
  readonly contextId: string;
  readonly title: string;
  readonly state: string;
  readonly summary: string;
  readonly projectIds: readonly string[];
  readonly jobIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastSeq: number;
}

export interface ProgressEvent {
  readonly seq: number;
  readonly eventKey: string;
  readonly requestId: string;
  readonly contextId: string | null;
  readonly kind: string;
  readonly source: string;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ProgressHeartbeat {
  readonly kind: "heartbeat";
  readonly occurredAt: string;
}

/**
 * Retention control frame. It carries no `seq` because it is not an observation: the snapshots are
 * authoritative and the viewer must continue from `latestSeq`, even when no retained event replays.
 */
export interface ProgressCompaction {
  readonly kind: "history.compacted";
  readonly occurredAt: string;
  readonly oldestSeq: number;
  readonly latestSeq: number;
  readonly snapshots: readonly ContextSnapshot[];
}

export type ProgressFrame = ProgressEvent | ProgressHeartbeat | ProgressCompaction;

export interface ViewerLease {
  readonly acquired: boolean;
  readonly viewerInstanceId: string;
  readonly leaseToken?: string;
  readonly expiresAt: string;
}

export interface ViewerLeaseHolder {
  readonly viewerInstanceId: string;
  readonly leaseToken: string;
}

export interface ProgressStreamOptions {
  readonly sessionId?: string;
  readonly contextId?: string;
  readonly after: number;
  readonly signal?: AbortSignal;
}

export interface ProgressClient {
  submitRequest(input: SubmitProgressRequest): Promise<ProgressAcceptance>;
  getRequest(requestId: string): Promise<ProgressRequestStatus>;
  listContexts(sessionId?: string): Promise<readonly ContextSnapshot[]>;
  getContext(contextId: string): Promise<ContextSnapshot>;
  acquireViewerLease(contextId: string, viewerInstanceId: string): Promise<ViewerLease>;
  heartbeatViewerLease(contextId: string, holder: ViewerLeaseHolder): Promise<void>;
  releaseViewerLease(contextId: string, holder: ViewerLeaseHolder): Promise<void>;
  streamEvents(options: ProgressStreamOptions): AsyncIterable<ProgressFrame>;
}

export interface ProgressClientOptions {
  readonly socketPath?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly maxBodyBytes?: number;
}

/** A server refusal carrying the contract's `{text}` error body so callers can distinguish 404/409/400. */
export class ProgressRequestFailed extends Error {
  readonly status: number;
  readonly text: string;

  constructor(status: number, text: string) {
    super(`progress_request_failed_${status}`);
    this.name = "ProgressRequestFailed";
    this.status = status;
    this.text = text;
  }
}

const escape = String.fromCharCode(0x1b);
const operatingSystemCommand = new RegExp(`${escape}\\][\\s\\S]*?(?:\\u0007|${escape}\\\\|$)`, "g");
const controlSequence = new RegExp(`${escape}\\[[0-9;:?]*[ -/]*[@-~]`, "g");
const remainingEscape = new RegExp(`${escape}[\\s\\S]?`, "g");
const controlCharacters = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]", "g");

/**
 * Renders untrusted server text as a single safe line: terminal control sequences are removed so a
 * work title or tool summary cannot relabel the window, clear the screen, or hide later output.
 */
export function sanitizeDisplayText(value: unknown): string {
  if (typeof value !== "string") return "";
  const stripped = value
    .replace(operatingSystemCommand, "")
    .replace(controlSequence, "")
    .replace(remainingEscape, "")
    .replace(controlCharacters, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return stripped.length <= displayTextLimit
    ? stripped
    : `${stripped.slice(0, displayTextLimit - 1)}…`;
}

/** Final reports preserve paragraphs; only control codes are removed, with an explicit bound notice. */
export function sanitizeResultText(value: unknown): string {
  if (typeof value !== "string") return "";
  const stripped = value
    .replace(operatingSystemCommand, "")
    .replace(controlSequence, "")
    .replace(remainingEscape, "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/gu, " ")
    .trim();
  const limit = 64 * 1024;
  return stripped.length <= limit ? stripped : `${stripped.slice(0, limit)}\n[표시 길이 제한으로 이후 내용을 생략했습니다.]`;
}

function assertIdentifier(value: string): string {
  if (!opaqueIdentifier.test(value)) throw new Error("progress_identifier_invalid");
  return value;
}

/** True only for identifiers safe to place in a request path or a fixed window command argument. */
export function validProgressIdentifier(value: unknown): value is string {
  return typeof value === "string" && opaqueIdentifier.test(value);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("progress_response_invalid");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("progress_response_invalid");
  return value;
}

function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== "string")) {
    throw new Error("progress_response_invalid");
  }
  return Object.freeze([...(value as string[])]);
}

function acceptance(value: unknown): ProgressAcceptance {
  const body = record(value);
  return Object.freeze({ requestId: text(body.requestId), state: text(body.state) });
}

function requestStatus(value: unknown): ProgressRequestStatus {
  const body = record(value);
  const base = {
    requestId: text(body.requestId),
    sessionId: text(body.sessionId),
    state: text(body.state),
    contextIds: stringList(body.contextIds)
  };
  if (body.result === undefined || body.result === null) return Object.freeze(base);
  const result = record(body.result);
  const jobId = result.jobId;
  if (jobId !== undefined && jobId !== null && typeof jobId !== "string") {
    throw new Error("progress_response_invalid");
  }
  return Object.freeze({
    ...base,
    result: Object.freeze(typeof jobId === "string"
      ? { text: text(result.text), jobId }
      : { text: text(result.text) })
  });
}

/** Accepts augmented snapshots but never a renamed or mistyped contract field. */
function contextSnapshot(value: unknown): ContextSnapshot {
  const body = record(value);
  if (typeof body.lastSeq !== "number" || !Number.isSafeInteger(body.lastSeq) || body.lastSeq < 0) {
    throw new Error("progress_response_invalid");
  }
  return Object.freeze({
    contextId: text(body.contextId),
    title: text(body.title),
    state: text(body.state),
    summary: text(body.summary),
    projectIds: stringList(body.projectIds),
    jobIds: stringList(body.jobIds),
    createdAt: text(body.createdAt),
    updatedAt: text(body.updatedAt),
    lastSeq: body.lastSeq
  });
}

/** Frame parsing skips a bad frame instead of ending the subscription, so validation cannot throw here. */
function readSnapshot(value: unknown): ContextSnapshot | undefined {
  try {
    return contextSnapshot(value);
  } catch {
    return undefined;
  }
}

function viewerLease(value: unknown): ViewerLease {
  const body = record(value);
  if (typeof body.acquired !== "boolean") throw new Error("progress_response_invalid");
  const base = {
    acquired: body.acquired,
    viewerInstanceId: text(body.viewerInstanceId),
    expiresAt: text(body.expiresAt)
  };
  // A token is only meaningful on a successful acquisition; a denied lease must never carry one.
  if (!body.acquired || body.leaseToken === undefined || body.leaseToken === null) {
    return Object.freeze(base);
  }
  return Object.freeze({ ...base, leaseToken: assertIdentifier(text(body.leaseToken)) });
}

/** Parses one NDJSON line into a persisted event or an ephemeral heartbeat, or nothing when invalid. */
export function parseProgressFrame(value: unknown): ProgressFrame | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const frame = value as Record<string, unknown>;
  if (frame.seq === undefined && frame.kind === "heartbeat") {
    return typeof frame.occurredAt === "string"
      ? Object.freeze({ kind: "heartbeat" as const, occurredAt: frame.occurredAt })
      : undefined;
  }
  if (frame.seq === undefined && frame.kind === "history.compacted") {
    if (typeof frame.occurredAt !== "string") return undefined;
    if (!Number.isSafeInteger(frame.oldestSeq) || !Number.isSafeInteger(frame.latestSeq)
      || (frame.oldestSeq as number) < 0 || (frame.latestSeq as number) < 0) return undefined;
    if (!Array.isArray(frame.snapshots)) return undefined;
    const snapshots: ContextSnapshot[] = [];
    for (const entry of frame.snapshots) {
      const snapshot = readSnapshot(entry);
      if (snapshot === undefined) return undefined;
      snapshots.push(snapshot);
    }
    return Object.freeze({
      kind: "history.compacted" as const,
      occurredAt: frame.occurredAt,
      oldestSeq: frame.oldestSeq as number,
      latestSeq: frame.latestSeq as number,
      snapshots: Object.freeze(snapshots)
    });
  }
  if (typeof frame.seq !== "number" || !Number.isSafeInteger(frame.seq) || frame.seq <= 0) return undefined;
  if (typeof frame.eventKey !== "string" || typeof frame.requestId !== "string") return undefined;
  if (typeof frame.kind !== "string" || typeof frame.source !== "string") return undefined;
  if (typeof frame.occurredAt !== "string") return undefined;
  if (frame.contextId !== null && typeof frame.contextId !== "string") return undefined;
  if (frame.payload === null || typeof frame.payload !== "object" || Array.isArray(frame.payload)) {
    return undefined;
  }
  return Object.freeze({
    seq: frame.seq,
    eventKey: frame.eventKey,
    requestId: frame.requestId,
    contextId: frame.contextId as string | null,
    kind: frame.kind,
    source: frame.source,
    occurredAt: frame.occurredAt,
    payload: Object.freeze({ ...(frame.payload as Record<string, unknown>) })
  });
}

export function isProgressEvent(frame: ProgressFrame): frame is ProgressEvent {
  return (frame as ProgressEvent).seq !== undefined;
}

export function isProgressCompaction(frame: ProgressFrame): frame is ProgressCompaction {
  return (frame as ProgressEvent).seq === undefined && frame.kind === "history.compacted";
}

function failure(status: number, body: string): ProgressRequestFailed {
  try {
    const parsed = JSON.parse(body) as { text?: unknown };
    if (typeof parsed.text === "string") return new ProgressRequestFailed(status, parsed.text);
  } catch {
    // A non-JSON error body still has to surface its status rather than look like success.
  }
  return new ProgressRequestFailed(status, `progress_request_failed_${status}`);
}

export function createProgressClient(options: ProgressClientOptions = {}): ProgressClient {
  const socketPath = options.socketPath ?? controlSocketPath(options.env);
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const idleTimeoutMs = options.idleTimeoutMs ?? defaultIdleTimeoutMs;
  const maxBodyBytes = options.maxBodyBytes ?? defaultMaxBodyBytes;

  async function call(method: string, path: string, payload?: unknown): Promise<unknown> {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    if (body !== undefined && Buffer.byteLength(body) > maxBodyBytes) {
      throw new Error("progress_request_too_large");
    }
    return await new Promise<unknown>((resolve, reject) => {
      const outgoing = request({
        socketPath,
        path,
        method,
        headers: body === undefined
          ? { accept: "application/json" }
          : { accept: "application/json", "content-type": "application/json", "content-length": Buffer.byteLength(body) }
      }, response => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBodyBytes) {
            response.destroy(new Error("progress_response_too_large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(failure(status, raw));
            return;
          }
          if (raw.trim() === "") {
            resolve(undefined);
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch {
            reject(new Error("progress_response_invalid"));
          }
        });
      });
      outgoing.once("error", reject);
      const deadline = setTimeout(() => outgoing.destroy(new Error("progress_request_timeout")), timeoutMs);
      outgoing.once("close", () => clearTimeout(deadline));
      outgoing.end(body);
    });
  }

  async function openStream(path: string, signal?: AbortSignal): Promise<IncomingMessage> {
    return await new Promise<IncomingMessage>((resolve, reject) => {
      const outgoing = request({
        socketPath,
        path,
        method: "GET",
        headers: { accept: "application/x-ndjson" }
      }, response => {
        const status = response.statusCode ?? 0;
        if (status >= 200 && status < 300) {
          resolve(response);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        const errorDeadline = setTimeout(() => response.destroy(new Error("progress_request_timeout")), timeoutMs);
        response.once("close", () => clearTimeout(errorDeadline));
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBodyBytes) { response.destroy(new Error("progress_response_too_large")); return; }
          chunks.push(chunk);
        });
        response.on("end", () => reject(failure(status, Buffer.concat(chunks).toString("utf8"))));
        response.on("error", reject);
      });
      outgoing.once("error", reject);
      // The stream stays open for the life of the subscription, so only the handshake is deadlined.
      const handshake = setTimeout(() => outgoing.destroy(new Error("progress_request_timeout")), timeoutMs);
      outgoing.once("response", () => clearTimeout(handshake));
      outgoing.once("close", () => clearTimeout(handshake));
      if (signal !== undefined) {
        if (signal.aborted) {
          clearTimeout(handshake);
          outgoing.destroy();
          reject(new Error("progress_stream_aborted"));
          return;
        }
        const abort = () => outgoing.destroy(new Error("progress_stream_aborted"));
        signal.addEventListener("abort", abort, { once: true });
        outgoing.once("close", () => signal.removeEventListener("abort", abort));
      }
      outgoing.end();
    });
  }

  async function* frames(streamOptions: ProgressStreamOptions): AsyncGenerator<ProgressFrame> {
    const scope = streamOptions.contextId !== undefined
      ? `contextId=${assertIdentifier(streamOptions.contextId)}`
      : streamOptions.sessionId !== undefined
        ? `sessionId=${assertIdentifier(streamOptions.sessionId)}`
        : undefined;
    if (scope === undefined) throw new Error("progress_stream_scope_invalid");
    const after = streamOptions.after;
    if (!Number.isSafeInteger(after) || after < 0) throw new Error("progress_stream_cursor_invalid");

    if (streamOptions.signal?.aborted) return;
    let response: IncomingMessage;
    try { response = await openStream(`/v1/progress/events?${scope}&after=${after}&follow=1`, streamOptions.signal); }
    catch (error) { if (streamOptions.signal?.aborted) return; throw error; }
    const decoder = new StringDecoder("utf8");
    const stall = setTimeout(() => response.destroy(new Error("progress_stream_stalled")), idleTimeoutMs);
    let buffer = "";
    try {
      for await (const chunk of response) {
        stall.refresh();
        buffer += decoder.write(chunk as Buffer);
        if (Buffer.byteLength(buffer) > defaultMaxLineBytes) throw new Error("progress_stream_line_too_large");
        let boundary = buffer.indexOf("\n");
        while (boundary >= 0) {
          const line = buffer.slice(0, boundary).trim();
          buffer = buffer.slice(boundary + 1);
          if (line !== "") {
            let parsed: unknown;
            try {
              parsed = JSON.parse(line);
            } catch {
              parsed = undefined;
            }
            // One unreadable frame must not end a live subscription and strand the viewer.
            const frame = parsed === undefined ? undefined : parseProgressFrame(parsed);
            if (frame !== undefined) yield frame;
          }
          boundary = buffer.indexOf("\n");
        }
      }
    } catch (error) {
      if (streamOptions.signal?.aborted === true) return;
      throw error;
    } finally {
      clearTimeout(stall);
      response.destroy();
    }
  }

  return Object.freeze<ProgressClient>({
    async submitRequest(input) {
      assertIdentifier(input.requestId);
      assertIdentifier(input.sessionId);
      if (input.text.trim() === "") throw new Error("progress_request_text_empty");
      const hint = input.contextHint;
      if (hint !== undefined && hint.contextId !== undefined) assertIdentifier(hint.contextId);
      // Same id plus same body is idempotent server-side; the caller must never mint a retry id.
      const payload = hint === undefined
        ? { requestId: input.requestId, sessionId: input.sessionId, text: input.text }
        : { requestId: input.requestId, sessionId: input.sessionId, text: input.text, contextHint: hint };
      return acceptance(await call("POST", "/v1/progress/requests", payload));
    },

    async getRequest(requestId) {
      return requestStatus(await call("GET", `/v1/progress/requests/${assertIdentifier(requestId)}`));
    },

    async listContexts(sessionId) {
      const path = sessionId === undefined
        ? "/v1/progress/contexts"
        : `/v1/progress/contexts?sessionId=${assertIdentifier(sessionId)}`;
      const body = record(await call("GET", path));
      if (!Array.isArray(body.contexts)) throw new Error("progress_response_invalid");
      return Object.freeze(body.contexts.map(contextSnapshot));
    },

    async getContext(contextId) {
      return contextSnapshot(await call("GET", `/v1/progress/contexts/${assertIdentifier(contextId)}`));
    },

    async acquireViewerLease(contextId, viewerInstanceId) {
      assertIdentifier(viewerInstanceId);
      return viewerLease(await call(
        "POST",
        `/v1/progress/contexts/${assertIdentifier(contextId)}/viewer-lease`,
        { viewerInstanceId }
      ));
    },

    async heartbeatViewerLease(contextId, holder) {
      assertIdentifier(holder.viewerInstanceId);
      assertIdentifier(holder.leaseToken);
      await call("POST", `/v1/progress/contexts/${assertIdentifier(contextId)}/viewer-heartbeat`, {
        viewerInstanceId: holder.viewerInstanceId,
        leaseToken: holder.leaseToken
      });
    },

    async releaseViewerLease(contextId, holder) {
      assertIdentifier(holder.viewerInstanceId);
      assertIdentifier(holder.leaseToken);
      await call("DELETE", `/v1/progress/contexts/${assertIdentifier(contextId)}/viewer-lease`, {
        viewerInstanceId: holder.viewerInstanceId,
        leaseToken: holder.leaseToken
      });
    },

    streamEvents(streamOptions) {
      return frames(streamOptions);
    }
  });
}
