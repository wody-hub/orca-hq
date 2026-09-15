import type { IncomingMessage, ServerResponse } from "node:http";
import { lstat, readFile, realpath } from "node:fs/promises";
import { extname, join } from "node:path";

type Asset = Readonly<{ body: Buffer; type: string }>;

async function safeFile(root: string, relative: string): Promise<Buffer> {
  try {
    const path = join(root, relative);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || await realpath(path) !== path) throw new Error("operations_assets_unsafe");
    return await readFile(path);
  } catch (error) {
    if (error instanceof Error && error.message === "operations_assets_unsafe") throw error;
    throw new Error("operations_assets_missing");
  }
}

export async function createOperationsAssets(inputRoot: string) {
  let root: string;
  try {
    const stat = await lstat(inputRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("operations_assets_unsafe");
    root = await realpath(inputRoot);
  } catch (error) {
    if (error instanceof Error && error.message === "operations_assets_unsafe") throw error;
    throw new Error("operations_assets_missing");
  }
  const index = await safeFile(root, "index.html");
  const html = index.toString("utf8");
  const referenced = [...html.matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/gu)].map((match) => match[1]!);
  if (!referenced.some((path) => path.endsWith(".js"))) throw new Error("operations_assets_missing");
  const assets = new Map<string, Asset>();
  for (const path of new Set(referenced)) {
    if (!/^\/assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.(?:js|css)$/u.test(path)) throw new Error("operations_assets_unsafe");
    assets.set(path, { body: await safeFile(root, path.slice(1)), type: path.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8" });
  }
  const send = (res: ServerResponse, status: number, body?: Buffer, type?: string, cache = "no-store") => {
    res.setHeader("Cache-Control", cache);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (type) res.setHeader("Content-Type", type);
    res.writeHead(status);
    res.end(body);
  };
  return Object.freeze({
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      if (!req.url || req.url.startsWith("/api/") || req.url.startsWith("/auth/") || !["GET", "HEAD"].includes(req.method ?? "")) return false;
      if (/%(?:2e|2f|5c)/iu.test(req.url) || req.url.includes("\\")) { send(res, 404); return true; }
      const pathname = new URL(req.url, "http://127.0.0.1").pathname;
      const asset = assets.get(pathname);
      if (asset) { send(res, 200, req.method === "HEAD" ? undefined : asset.body, asset.type, "public, max-age=31536000, immutable"); return true; }
      if (pathname.startsWith("/assets/") || extname(pathname) !== "") { send(res, 404); return true; }
      res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
      send(res, 200, req.method === "HEAD" ? undefined : index, "text/html; charset=utf-8");
      return true;
    },
  });
}
