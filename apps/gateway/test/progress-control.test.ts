import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect, vi } from "vitest";
import { startManagedControl } from "../src/managed-control.js";
import {
  createProgressControl,
  type ProgressHttpPort,
} from "../src/progress-control.js";
it("accepts immediately over owner socket, preserves commands, and validates scope and identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "progress-http-"));
  const socketPath = join(directory, "control.sock");
  const submit = vi.fn();
  const port: ProgressHttpPort = {
    submit,
    request: () => ({ requestId: "r", state: "queued" }),
    contexts: () => [],
    context: (id) => (id === "c" ? { contextId: "c" } : undefined),
    events: () => ({ events: [{ seq: 1 }] }),
    viewer: () => ({ acquired: true }),
  };
  const server = await startManagedControl({
    socketPath,
    execute: async () => ({ text: "legacy" }),
    progress: createProgressControl(port, { pollMs: 5, heartbeatMs: 10 }),
  });
  const send = (method: string, path: string, data?: unknown) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = request(
        { socketPath, method, path, headers: { Connection: "close" } },
        (res) => {
          let text = "";
          res.on("data", (chunk) => (text += chunk));
          res.on("end", () => resolve({ status: res.statusCode!, text }));
        },
      );
      req.on("error", reject);
      req.end(data === undefined ? undefined : JSON.stringify(data));
    });
  try {
    expect(
      await send("POST", "/v1/progress/requests", {
        requestId: "r",
        sessionId: "s",
        text: "work",
      }),
    ).toMatchObject({ status: 202 });
    expect(submit).toHaveBeenCalledOnce();
    expect(
      await send("POST", "/v1/progress/requests", {
        requestId: "r",
        sessionId: "s",
        text: "work",
        ownerKey: "foreign",
      }),
    ).toMatchObject({ status: 400 });
    expect(
      await send("GET", "/v1/progress/events?sessionId=s&contextId=c"),
    ).toMatchObject({ status: 400 });
    expect(
      await send("GET", "/v1/progress/events?contextId=missing"),
    ).toMatchObject({ status: 404 });
    expect(
      await send("GET", "/v1/progress/events?sessionId=s&after=0"),
    ).toEqual({ status: 200, text: '{"seq":1}\n' });
    expect(
      await send("POST", "/commands", {
        id: "legacy",
        text: "hello",
        source: "terminal",
        userId: "local",
      }),
    ).toEqual({ status: 200, text: '{"text":"legacy"}' });
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
