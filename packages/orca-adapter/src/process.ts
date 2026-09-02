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
  if (args.includes("--json")) throw new TypeError("runOrca appends --json");

  return new Promise<unknown>((resolve, reject) => {
    const child = spawn(options.executablePath, [...args, "--json"], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let finished = false;
    let aborted = false;
    let timedOut = false;

    const finish = (action: () => void): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", abort);
      action();
    };
    const abort = (): void => {
      aborted = true;
      child.kill("SIGTERM");
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);

    options.signal.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.resume();
    child.on("error", () => {
      finish(() => reject(aborted ? new OrcaAbortedError() : new OrcaProcessError(null)));
    });
    child.on("close", (exitCode) => {
      finish(() => {
        if (aborted) {
          reject(new OrcaAbortedError());
        } else if (timedOut) {
          reject(new OrcaTimeoutError(options.timeoutMs));
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
  });
}
