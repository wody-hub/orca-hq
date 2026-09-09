import { spawn } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

it.skipIf(process.platform === "win32")("real PTY preserves partially typed input during progress and accepts new work before the first completes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hq-pty-"));
  const received: { requestId: string; text: string }[] = [];
  const routes: string[] = [];
  const streams = new Set<ServerResponse>();
  const timers: ReturnType<typeof setTimeout>[] = [];
  const server = createServer(async (request, response) => {
    routes.push(`${request.method} ${request.url}`);
    if (request.url?.startsWith("/v1/progress/events?")) {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.flushHeaders(); streams.add(response);
      response.on("close", () => streams.delete(response));
    } else if (request.method === "POST" && request.url === "/v1/progress/requests") {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      received.push(body);
      response.writeHead(202, { "content-type": "application/json" });
      response.end(JSON.stringify({ requestId: body.requestId, state: "queued" }));
      if (received.length === 1) timers.push(setTimeout(() => {
        for (const stream of streams) stream.write(`${JSON.stringify({ seq: 1, eventKey: "question", requestId: body.requestId, contextId: null, kind: "clarification.required", source: "hq", occurredAt: new Date().toISOString(), payload: { text: "확인 요청" } })}\n`);
      }, 150));
    } else if (request.url?.startsWith("/v1/progress/contexts?")) response.end('{"contexts":[]}');
    else { response.writeHead(404); response.end('{"text":"unexpected route"}'); }
  });
  try {
    // Run the exact source modules in a real child Node/PTY without depending on a prior dist build.
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    for (const name of ["chat", "control", "progress-client", "progress-window"]) {
      const source = await readFile(new URL(`../src/${name}.ts`, import.meta.url), "utf8");
      await writeFile(join(directory, `${name}.js`), ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }
      }).outputText);
    }
    const socketPath = join(directory, "control.sock");
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    const entry = join(directory, "entry.js");
    await writeFile(entry, `import {runChat} from './chat.js'; import {createProgressClient} from './progress-client.js'; await runChat({input:process.stdin,output:process.stdout,progressWindow:'off',client:createProgressClient({socketPath:${JSON.stringify(socketPath)}})});`);
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn("python3", [fileURLToPath(new URL("./fixtures/chat-pty.py", import.meta.url)), process.execPath, entry], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = ""; let stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.on("error", reject);
      child.on("exit", code => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
    });
    expect(received.map(request => request.text)).toEqual(["첫 질문", "두 번째 질문"]);
    expect(received[0]!.requestId).not.toBe(received[1]!.requestId);
    expect(JSON.parse(output).output).toContain("진행 창은 계속됩니다");
    expect(routes.every(route => route.startsWith("GET ") || route === "POST /v1/progress/requests")).toBe(true);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    for (const stream of streams) stream.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
