import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { controlSocketPath, createControlClient } from "../src/control.js";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async path => rm(path, { recursive: true, force: true })));
});

async function socketFixture(): Promise<{ directory: string; socketPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "orca-hq-control-client-"));
  fixtures.push(directory);
  return { directory, socketPath: join(directory, "control.sock") };
}

describe("terminal control client", () => {
  it("posts a terminal command to the local UNIX socket and returns the gateway response", async () => {
    // Break caught: the terminal client could use TCP, the wrong route, or omit the local source identity.
    const fixture = await socketFixture();
    let received: unknown;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received = {
        method: request.method,
        url: request.url,
        contentType: request.headers["content-type"],
        body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ text: "프로젝트 5개를 찾았습니다.", jobId: "job-42" }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(fixture.socketPath, resolve);
    });

    try {
      const result = await createControlClient({ socketPath: fixture.socketPath }).send("프로젝트 보여줘");

      expect(result).toEqual({ text: "프로젝트 5개를 찾았습니다.", jobId: "job-42" });
      expect(received).toMatchObject({
        method: "POST",
        url: "/commands",
        contentType: "application/json",
        body: { text: "프로젝트 보여줘", source: "terminal", userId: "local" }
      });
      expect((received as { body: { id: string } }).body.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      );
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("uses XDG_CONFIG_HOME and otherwise the home config directory", () => {
    // Break caught: source installs with XDG_CONFIG_HOME could silently address another user's or a stale socket.
    expect(controlSocketPath({ XDG_CONFIG_HOME: "/tmp/hq-config", HOME: "/Users/pilot" }))
      .toBe("/tmp/hq-config/orca-hq/control.sock");
    expect(controlSocketPath({ HOME: "/Users/pilot" }))
      .toBe("/Users/pilot/.config/orca-hq/control.sock");
  });

  it("times out an unresponsive gateway and rejects oversized response bodies", async () => {
    // Break caught: a wedged or flooding local gateway could keep the terminal process alive or consume unbounded memory.
    for (const mode of ["timeout", "oversized"] as const) {
      const fixture = await socketFixture();
      const server = createServer((_request, response) => {
        if (mode === "oversized") response.end(JSON.stringify({ text: "x".repeat(128) }));
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(fixture.socketPath, resolve);
      });
      try {
        const request = createControlClient({
          socketPath: fixture.socketPath,
          timeoutMs: 20,
          maxBodyBytes: mode === "timeout" ? 1024 : 100
        }).send("상태");
        await expect(request).rejects.toThrow(mode === "timeout" ? "control_request_timeout" : "control_response_too_large");
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    }
  });

  it("bounds total response time even when a gateway keeps sending bytes", async () => {
    // Break caught: an inactivity-only timeout allows an unfinished streaming response to live forever.
    const fixture = await socketFixture();
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"text":"');
      const interval = setInterval(() => response.write("x"), 5);
      const finish = setTimeout(() => response.end('"}'), 150);
      response.on("close", () => { clearInterval(interval); clearTimeout(finish); });
    });
    await new Promise<void>(resolve => server.listen(fixture.socketPath, resolve));
    try {
      await expect(createControlClient({ socketPath: fixture.socketPath, timeoutMs: 30 }).send("질문"))
        .rejects.toThrow("control_request_timeout");
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("rejects a command body above the bounded local protocol size before opening the socket", async () => {
    // Break caught: arbitrarily large prompts could bypass the gateway's request-body cap.
    const fixture = await socketFixture();
    await expect(createControlClient({ socketPath: fixture.socketPath, maxBodyBytes: 64 }).send("x".repeat(128)))
      .rejects.toThrow("control_request_too_large");
    await expect(readFile(fixture.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
