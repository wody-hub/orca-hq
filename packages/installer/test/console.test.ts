import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { launchConsole } from "../src/console.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function socketServer(value: unknown) {
  const root = await mkdtemp(join(tmpdir(), "hq-console-")); roots.push(root);
  const socketPath = join(root, "control.sock");
  const seen: Array<{ method?: string; path?: string; body: string }> = [];
  const server = createServer(async (req, res) => { let body = ""; for await (const chunk of req) body += String(chunk); seen.push({ method: req.method, path: req.url, body }); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return { socketPath, seen, stop: async () => await new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe("hq console launcher", () => {
  it("claims through the owner socket and opens exactly one fragment URL argv without a shell", async () => {
    // Break caught: a claim can leak through shell interpolation or be requested from a non-owner transport.
    const url = `http://127.0.0.1:4310/#claim=${"a".repeat(43)}`;
    const server = await socketServer({ url, expiresAt: "2026-09-15T09:01:00.000Z" });
    const open = vi.fn().mockResolvedValue(undefined);
    try { await expect(launchConsole({ socketPath: server.socketPath, open })).resolves.toEqual({ url, expiresAt: "2026-09-15T09:01:00.000Z" }); }
    finally { await server.stop(); }
    expect(server.seen).toEqual([{ method: "POST", path: "/v1/operations/session", body: "{}" }]);
    expect(open).toHaveBeenCalledWith("/usr/bin/open", [url], expect.objectContaining({ shell: false }));
  });

  it.each([
    { url: `https://127.0.0.1:4310/#claim=${"a".repeat(43)}`, expiresAt: "2026-09-15T09:01:00.000Z" },
    { url: `http://example.test/#claim=${"a".repeat(43)}`, expiresAt: "2026-09-15T09:01:00.000Z" },
    { url: "http://127.0.0.1:4310/#claim=short", expiresAt: "2026-09-15T09:01:00.000Z" },
  ])("refuses a malformed claim response without invoking the browser", async (value) => {
    // Break caught: a compromised socket response can redirect the privileged launcher off loopback.
    const server = await socketServer(value); const open = vi.fn();
    try { await expect(launchConsole({ socketPath: server.socketPath, open })).rejects.toThrow("console_claim_invalid"); }
    finally { await server.stop(); }
    expect(open).not.toHaveBeenCalled();
  });
});
