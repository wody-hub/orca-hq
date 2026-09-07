import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const defaultTimeoutMs = 60_000;
const defaultMaxBodyBytes = 64 * 1024;

export interface ControlResponse {
  readonly text: string;
  readonly jobId?: string;
}

export interface ControlClient {
  send(text: string): Promise<ControlResponse>;
}

export interface ControlClientOptions {
  readonly sessionId?: string;
  readonly socketPath?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly maxBodyBytes?: number;
}

export function controlSocketPath(
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  const configHome = env.XDG_CONFIG_HOME?.trim();
  const home = env.HOME?.trim() || homedir();
  return join(configHome || join(home, ".config"), "orca-hq", "control.sock");
}

function responseBody(value: unknown): ControlResponse {
  if (value === null || typeof value !== "object") throw new Error("control_response_invalid");
  const candidate = value as { text?: unknown; jobId?: unknown };
  if (typeof candidate.text !== "string"
    || (candidate.jobId !== undefined && typeof candidate.jobId !== "string")) {
    throw new Error("control_response_invalid");
  }
  return candidate.jobId === undefined
    ? { text: candidate.text }
    : { text: candidate.text, jobId: candidate.jobId };
}

export function validSessionId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,100}$/.test(value);
}

export function createControlClient(options: ControlClientOptions = {}): ControlClient {
  if (options.sessionId !== undefined && !validSessionId(options.sessionId)) {
    throw new Error("control_session_invalid");
  }
  const socketPath = options.socketPath ?? controlSocketPath(options.env);
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const maxBodyBytes = options.maxBodyBytes ?? defaultMaxBodyBytes;
  return {
    async send(text) {
      const body = JSON.stringify({ id: randomUUID(), text, source: "terminal", userId: "local", sessionId: options.sessionId });
      if (Buffer.byteLength(body) > maxBodyBytes) throw new Error("control_request_too_large");
      return await new Promise<ControlResponse>((resolve, reject) => {
        const outgoing = request({
          socketPath,
          path: "/commands",
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body)
          }
        }, response => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBodyBytes) {
              response.destroy(new Error("control_response_too_large"));
              return;
            }
            chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () => {
            if (response.statusCode === undefined || response.statusCode < 200 || response.statusCode >= 300) {
              reject(new Error("control_response_failed"));
              return;
            }
            try {
              resolve(responseBody(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
            } catch (error) {
              reject(error);
            }
          });
        });
        outgoing.once("error", reject);
        const deadline = setTimeout(() => outgoing.destroy(new Error("control_request_timeout")), timeoutMs);
        outgoing.once("close", () => clearTimeout(deadline));
        outgoing.end(body);
      });
    }
  };
}
