import { execFile } from "node:child_process";
import { request } from "node:http";
import { controlSocketPath } from "./control.js";

export interface ConsoleClaim { readonly url: string; readonly expiresAt: string }
export type ConsoleOpen = (executable: string, arguments_: readonly string[], options: Readonly<{ shell: false; timeout: number; maxBuffer: number }>) => Promise<void>;
export interface LaunchConsoleOptions {
  readonly socketPath?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly maxBodyBytes?: number;
  readonly open?: ConsoleOpen;
}

const openBrowser: ConsoleOpen = async (executable, arguments_, options) => await new Promise<void>((resolve, reject) => {
  execFile(executable, [...arguments_], options, (error) => error ? reject(new Error("console_open_failed")) : resolve());
});

function parseClaim(value: unknown): ConsoleClaim {
  if (!value || typeof value !== "object") throw new Error("console_claim_invalid");
  const { url, expiresAt } = value as { url?: unknown; expiresAt?: unknown };
  if (typeof url !== "string" || typeof expiresAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(expiresAt) || Number.isNaN(Date.parse(expiresAt))) throw new Error("console_claim_invalid");
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("console_claim_invalid"); }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || !/^#claim=[A-Za-z0-9_-]{43}$/u.test(parsed.hash)) throw new Error("console_claim_invalid");
  return { url, expiresAt };
}

export async function launchConsole(options: LaunchConsoleOptions = {}): Promise<ConsoleClaim> {
  const socketPath = options.socketPath ?? controlSocketPath(options.env);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBodyBytes = options.maxBodyBytes ?? 16 * 1024;
  const claim = await new Promise<ConsoleClaim>((resolve, reject) => {
    const outgoing = request({ socketPath, path: "/v1/operations/session", method: "POST", headers: { "content-type": "application/json", "content-length": 2 } }, (response) => {
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > maxBodyBytes) response.destroy(new Error("console_claim_too_large")); else chunks.push(chunk); });
      response.once("error", reject);
      response.once("end", () => {
        if (response.statusCode !== 200) { reject(new Error("console_claim_failed")); return; }
        try { resolve(parseClaim(JSON.parse(Buffer.concat(chunks).toString("utf8")))); } catch (error) { reject(error); }
      });
    });
    outgoing.once("error", reject);
    const deadline = setTimeout(() => outgoing.destroy(new Error("console_claim_timeout")), timeoutMs);
    outgoing.once("close", () => clearTimeout(deadline));
    outgoing.end("{}");
  });
  await (options.open ?? openBrowser)("/usr/bin/open", [claim.url], { shell: false, timeout: 10_000, maxBuffer: 64 * 1024 });
  return claim;
}
