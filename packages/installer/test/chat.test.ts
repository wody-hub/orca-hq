import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { createControlClient, type ControlClientOptions } from "../src/control.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function gateway() {
  const directory = await mkdtemp(join(tmpdir(), "hq-chat-"));
  const socketPath = join(directory, "control.sock");
  const received: { text: string; sessionId?: string; id: string }[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    received.push(body);
    // Delay delivery so lines arriving while a request is pending cannot be dropped.
    setTimeout(() => response.end(JSON.stringify({ text: `답변: ${body.text}`, jobId: "job-chat" })), 5);
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  cleanup.push(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  let output = "";
  return {
    received,
    get output() { return output; },
    dependencies: {
      control: { async send() { throw new Error("default_transport_forbidden"); } },
      stdout: { write(text: string) { output += text; return true; } },
      controlFactory: (options: ControlClientOptions) => createControlClient({ ...options, socketPath })
    }
  };
}

describe("terminal conversations", () => {
  it("drains multiple streamed questions in one session through EOF and can resume it with ask", async () => {
    // Break caught: repeated readline.question calls lose buffered lines or generate a new session per request.
    const fixture = await gateway();
    const stdin = Readable.from(["첫 질문\n두 번째 질문\n"]);
    expect(await runCli(["chat"], { ...fixture.dependencies, stdin })).toBe(0);
    expect(fixture.received.map(body => body.text)).toEqual(["첫 질문", "두 번째 질문"]);
    const sessionId = fixture.received[0]!.sessionId!;
    expect(sessionId).toMatch(/^[A-Za-z0-9_-]{1,100}$/);
    expect(fixture.received[1]!.sessionId).toBe(sessionId);
    expect(fixture.received[1]!.id).not.toBe(fixture.received[0]!.id);
    expect(fixture.output).toContain(`hq chat --session ${sessionId}`);
    expect(fixture.output).toContain("답변: 두 번째 질문");
    expect(fixture.output).toContain("작업 ID: job-chat");
    expect(await runCli(["ask", "--session", sessionId, "이어서", "질문"], fixture.dependencies)).toBe(0);
    expect(fixture.received[2]).toMatchObject({ text: "이어서 질문", sessionId });
  });

  it("starts a distinct session on /new and /exit closes an input stream that stays open", async () => {
    // Break caught: /new retains conversation state or /exit waits indefinitely for EOF.
    const fixture = await gateway();
    const stdin = new PassThrough();
    const result = runCli(["chat", "--session", "existing-session"], { ...fixture.dependencies, stdin });
    stdin.write("\n기존 질문\n/new\n새 질문\n/exit\n무시할 질문\n");
    expect(await result).toBe(0);
    expect(fixture.received.map(body => body.text)).toEqual(["기존 질문", "새 질문"]);
    expect(fixture.received[0]!.sessionId).toBe("existing-session");
    expect(fixture.received[1]!.sessionId).toMatch(/^[A-Za-z0-9_-]{1,100}$/);
    expect(fixture.received[1]!.sessionId).not.toBe("existing-session");
    stdin.destroy();
  });

  it.each(["", "../other", "two words", "a".repeat(101), "세션"])("rejects invalid session %j without opening transport", async sessionId => {
    const fixture = await gateway();
    for (const command of ["ask", "chat"]) {
      const input = [command, "--session", sessionId, ...(command === "ask" ? ["질문"] : [])];
      expect(await runCli(input, { ...fixture.dependencies, stdin: Readable.from([]) })).toBe(2);
    }
    expect(fixture.received).toEqual([]);
    expect(() => createControlClient({ sessionId })).toThrow("control_session_invalid");
  });

  it.each([["chat", "extra"], ["chat", "--session"], ["ask", "--session"], ["ask", "--session", "valid"]])("rejects incomplete session syntax: %j", async input => {
    const fixture = await gateway();
    expect(await runCli(input, { ...fixture.dependencies, stdin: Readable.from([]) })).toBe(2);
    expect(fixture.received).toEqual([]);
  });

  it("redacts a failed chat request and releases the input reader", async () => {
    const stdin = new PassThrough();
    let output = "";
    const result = runCli(["chat"], {
      stdin, stdout: { write(text: string) { output += text; return true; } },
      control: { async send() { throw new Error("private diagnostic"); } }
    });
    stdin.write("질문\n");
    expect(await result).toBe(1);
    expect(output).not.toContain("private diagnostic");
    expect(output).toContain("hq start");
    expect(stdin.listenerCount("data")).toBe(0);
    stdin.destroy();
  });
});
