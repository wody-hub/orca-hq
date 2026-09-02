import { spawn } from "node:child_process";

import {
  assertSuccessfulReceipt,
  OrcaInvalidReceiptError,
  parseOrcaReceipt
} from "./receipts.js";

export interface RunOrcaOptions {
  readonly executablePath: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly terminationGraceMs: number;
}

const ORCA_ENVIRONMENT_KEYS = Object.freeze([
  "HOME",
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TERM",
  "COLORTERM",
  "USER",
  "LOGNAME",
  "SHELL",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
  "__CF_USER_TEXT_ENCODING"
] as const);

export function boundedOrcaEnvironment(
  source: Readonly<NodeJS.ProcessEnv>
): Readonly<NodeJS.ProcessEnv> {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ORCA_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return Object.freeze(environment);
}

export class OrcaProcessError extends Error {
  readonly code = "orca_process_failed";
  readonly retryable = false;
  readonly exitCode: number | null;

  constructor(exitCode: number | null) {
    super("Orca CLI process failed");
    this.name = "OrcaProcessError";
    this.exitCode = exitCode;
  }
}

export class OrcaTimeoutError extends Error {
  readonly code = "orca_timeout";
  readonly retryable = false;
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super("Orca CLI process timed out");
    this.name = "OrcaTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class OrcaAbortedError extends Error {
  readonly code = "orca_aborted";
  readonly retryable = false;

  constructor() {
    super("Orca CLI process was aborted");
    this.name = "OrcaAbortedError";
  }
}

function parseJsonReceiptText(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new OrcaInvalidReceiptError();
  }
}

function classifyNonzeroExit(stdout: string, exitCode: number | null): Error {
  if (stdout.trim().length > 0) {
    try {
      const receipt = parseOrcaReceipt(JSON.parse(stdout) as unknown);
      assertSuccessfulReceipt(receipt);
    } catch (error) {
      if (
        error instanceof OrcaInvalidReceiptError
        || (error instanceof Error && "code" in error && error.code === "orca_stale_handle")
        || (error instanceof Error && "code" in error && error.code === "orca_command_failed")
      ) {
        return error;
      }
    }
  }
  return new OrcaProcessError(exitCode);
}

export async function runOrca(
  args: readonly string[],
  options: RunOrcaOptions
): Promise<unknown> {
  if (options.signal.aborted) throw new OrcaAbortedError();
  if (options.executablePath.length === 0) throw new TypeError("executablePath is required");
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(options.terminationGraceMs) || options.terminationGraceMs <= 0) {
    throw new TypeError("terminationGraceMs must be a positive safe integer");
  }
  if (args.includes("--json")) throw new TypeError("runOrca appends --json");

  return new Promise<unknown>((resolve, reject) => {
    const child = spawn(options.executablePath, [...args, "--json"], {
      env: boundedOrcaEnvironment(process.env),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let finished = false;
    let closed = false;
    let cancellationReason: "aborted" | "timeout" | undefined;
    let processError: OrcaProcessError | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let terminationGrace: ReturnType<typeof setTimeout> | undefined;

    const finish = (action: () => void): void => {
      if (finished) return;
      finished = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (terminationGrace !== undefined) clearTimeout(terminationGrace);
      options.signal.removeEventListener("abort", abort);
      action();
    };
    const cancel = (reason: "aborted" | "timeout"): void => {
      if (finished || cancellationReason !== undefined) return;
      cancellationReason = reason;
      child.kill("SIGTERM");
      terminationGrace = setTimeout(() => {
        if (!closed) child.kill("SIGKILL");
      }, options.terminationGraceMs);
    };
    const abort = (): void => { cancel("aborted"); };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.resume();
    child.on("error", () => {
      processError = new OrcaProcessError(null);
    });
    child.on("close", (exitCode) => {
      closed = true;
      finish(() => {
        if (cancellationReason === "aborted") {
          reject(new OrcaAbortedError());
        } else if (cancellationReason === "timeout") {
          reject(new OrcaTimeoutError(options.timeoutMs));
        } else if (processError !== undefined) {
          reject(processError);
        } else if (exitCode !== 0) {
          reject(classifyNonzeroExit(stdout, exitCode));
        } else {
          try {
            resolve(parseJsonReceiptText(stdout));
          } catch (error) {
            reject(error);
          }
        }
      });
    });
    timeout = setTimeout(() => { cancel("timeout"); }, options.timeoutMs);
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
  });
}
