import { createServer, request } from "node:http";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOperationsAssets } from "../src/operations-assets.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hq-assets-")); roots.push(root);
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), '<!doctype html><link rel="stylesheet" href="/assets/index-a1b2c3d4.css"><script type="module" src="/assets/index-e5f6a7b8.js"></script>');
  await writeFile(join(root, "assets/index-a1b2c3d4.css"), "body{color:#123}");
  await writeFile(join(root, "assets/index-e5f6a7b8.js"), "globalThis.__hq=true");
  return root;
}

async function get(handler: Awaited<ReturnType<typeof createOperationsAssets>>, path: string) {
  const server = createServer(async (req, res) => { if (!await handler.handle(req, res)) { res.writeHead(418); res.end("protected"); } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw Error("listener");
  const result = await new Promise<{ status: number; type?: string; body: string }>((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port: address.port, path }, (response) => { const chunks: Buffer[] = []; response.on("data", (chunk) => chunks.push(chunk)); response.on("end", () => resolve({ status: response.statusCode ?? 0, ...(typeof response.headers["content-type"] === "string" ? { type: response.headers["content-type"] } : {}), body: Buffer.concat(chunks).toString("utf8") })); });
    outgoing.once("error", reject); outgoing.end();
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return result;
}

describe("operations built assets", () => {
  it("serves only indexed built files and uses SPA fallback only for extensionless non-API paths", async () => {
    // Break caught: the gateway could expose arbitrary files or answer an API miss with HTML.
    const assets = await createOperationsAssets(await fixture());
    await expect(get(assets, "/overview")).resolves.toMatchObject({ status: 200, type: "text/html; charset=utf-8", body: expect.stringContaining("index-e5f6a7b8.js") });
    await expect(get(assets, "/assets/index-e5f6a7b8.js")).resolves.toMatchObject({ status: 200, type: "text/javascript; charset=utf-8" });
    await expect(get(assets, "/assets/index-a1b2c3d4.css")).resolves.toMatchObject({ status: 200, type: "text/css; charset=utf-8" });
    await expect(get(assets, "/assets/unlisted-a1b2c3d4.js")).resolves.toMatchObject({ status: 404 });
    await expect(get(assets, "/api/operations/missing")).resolves.toMatchObject({ status: 418, body: "protected" });
    await expect(get(assets, "/README.md")).resolves.toMatchObject({ status: 404 });
  });

  it("rejects traversal and symlinked build members", async () => {
    // Break caught: a crafted path or swapped build file could escape the fixed Vite artifact root.
    const root = await fixture();
    const assets = await createOperationsAssets(root);
    await expect(get(assets, "/assets/%2e%2e%2findex.html")).resolves.toMatchObject({ status: 404 });
    await rm(join(root, "assets/index-e5f6a7b8.js"));
    await symlink(join(root, "index.html"), join(root, "assets/index-e5f6a7b8.js"));
    await expect(createOperationsAssets(root)).rejects.toThrow("operations_assets_unsafe");
  });

  it("fails closed when the built index or an indexed asset is missing", async () => {
    // Break caught: service startup can silently fall back to source or a partial/stale web build.
    const root = await fixture();
    await rm(join(root, "assets/index-a1b2c3d4.css"));
    await expect(createOperationsAssets(root)).rejects.toThrow("operations_assets_missing");
    await expect(createOperationsAssets(join(root, "missing"))).rejects.toThrow("operations_assets_missing");
  });
});
