import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

const observability = await import("../src/index.js").catch(() => ({}));
const { createLogger, createPilotCounters, diagnostics, redactDeep } = observability as {
  createLogger?: (destination?: Writable) => { info: (event: unknown, message?: string) => void };
  createPilotCounters?: (initial?: Readonly<Record<string, number>>) => {
    increment: (name: string, amount?: number) => void;
    snapshot: () => Readonly<Record<string, number>>;
  };
  diagnostics?: {
    create: (input: {
      version: string;
      capabilities: readonly string[];
      schema: string;
      health: unknown;
      counters: Record<string, number>;
      auditReferences: readonly string[];
      includeFullContent: false;
      secretPatterns: readonly RegExp[];
      pathDisclosure: "basename";
    }) => Promise<{
      stagingPath: string;
      manifest: { files: readonly string[]; auditReferences: readonly string[] };
      text: () => string;
    }>;
  };
  redactDeep?: (value: unknown, options?: { secretPatterns?: readonly RegExp[]; pathDisclosure?: "basename" }) => unknown;
};

describe("observability privacy boundary", () => {
  it.each(["authorization", "token", "cookie", "voiceUrl", "signedUrl"])(
    "redacts %s wherever it appears in structured data",
    (key) => {
      // Break caught: adding a new event field bypasses the key-based secret filter.
      expect(redactDeep?.({ outer: { [key]: "secret-value" } })).toEqual({
        outer: { [key]: "[Redacted]" }
      });
    }
  );

  it("redacts configured patterns, company paths, prompts, and transcripts", () => {
    // Break caught: an unrecognized secret or company content reaches a diagnostic payload.
    expect(
      redactDeep?.(
        {
          note: "api_key=secret-pattern company-project-path",
          prompt: "private customer prompt",
          transcript: "private call transcript",
          sourcePath: "/company-project-path/private/runtime.sqlite"
        },
        { secretPatterns: [/api_key=[^\s]+/], pathDisclosure: "basename" }
      )
    ).toEqual({
      note: "[Redacted] [Redacted]",
      prompt: "[Redacted]",
      transcript: "[Redacted]",
      sourcePath: "runtime.sqlite"
    });
  });

  it("exports a reviewable manifest without raw prompts or transcripts", async () => {
    // Break caught: staged diagnostics include raw runtime data before user archive confirmation.
    const bundle = await diagnostics?.create({
      version: "2026.09.01",
      capabilities: ["gateway.health"],
      schema: "orca-hq.diagnostics.v1",
      health: { workspace: "company-project-path", authorization: "Bearer secret-value" },
      counters: { commandsProcessed: 3 },
      auditReferences: ["audit:dispatch:123"],
      includeFullContent: false,
      secretPatterns: [/secret-value/],
      pathDisclosure: "basename"
    });

    expect(bundle?.stagingPath).toContain("diagnostics");
    expect(bundle?.manifest.files).toEqual(["manifest.json"]);
    expect(bundle?.manifest.files).not.toContain("runtime.sqlite");
    expect(bundle?.manifest.auditReferences).toEqual(["audit:dispatch:123"]);
    expect(bundle?.text()).not.toContain("company-project-path");
    expect(bundle?.text()).not.toContain("secret-value");
    expect(bundle?.text()).not.toContain("prompt");
    expect(bundle?.text()).not.toContain("transcript");
  });

  it("keeps Pino logs redacted at the destination boundary", () => {
    // Break caught: a logger writes secrets before redaction is applied.
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      }
    });

    createLogger?.(destination).info(
      { authorization: "Bearer secret-value", nested: { signedUrl: "https://signed.example/secret" } },
      "request complete"
    );

    expect(output).toContain("[Redacted]");
    expect(output).not.toContain("secret-value");
    expect(output).not.toContain("https://signed.example/secret");
  });

  it("keeps pilot counters local as aggregate snapshots", () => {
    // Break caught: counters lose prior values or accept invalid decrements.
    const counters = createPilotCounters?.({ commandsProcessed: 2 });
    counters?.increment("commandsProcessed");
    counters?.increment("commandsProcessed", -1);

    expect(counters?.snapshot()).toEqual({ commandsProcessed: 3 });
  });
});
