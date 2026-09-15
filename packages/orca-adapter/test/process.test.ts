import { describe, expect, it } from "vitest";

import { runOrca } from "../src/process.js";

describe("bounded Orca process", () => {
  it("bounds output and SIGKILLs a child that ignores overflow SIGTERM", async () => {
    // Break caught: overflow must use the hard cancellation path instead of buffering until command timeout.
    const source = "process.on('SIGTERM',()=>{}); setInterval(()=>process.stdout.write('x'.repeat(4096)),5)";
    const startedAt = Date.now();
    await expect(runOrca(["-e", source, "--"], {
      executablePath: process.execPath,
      signal: new AbortController().signal,
      timeoutMs: 5_000,
      terminationGraceMs: 20,
      maxOutputBytes: 1_024
    })).rejects.toMatchObject({ code: "orca_output_limit", retryable: false, maxOutputBytes: 1_024 });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
