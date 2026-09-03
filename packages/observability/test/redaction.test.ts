import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  createLogger,
  createPilotCounters,
  diagnostics,
  redactDeep,
  safeErrorSerializer
} from "@orca-hq/observability";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

describe("observability privacy boundary", () => {
  it("lets an external root TypeScript consumer resolve the public name to the source entry", () => {
    // Break caught: workspace consumers fall back to an unavailable dist declaration instead of the source API.
    const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const configPath = resolve(workspaceRoot, "tsconfig.json");
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, workspaceRoot);
    const resolution = ts.resolveModuleName(
      "@orca-hq/observability",
      resolve(workspaceRoot, "packages/core/src/observability-consumer.ts"),
      parsed.options,
      ts.sys
    );

    expect(resolution.resolvedModule?.resolvedFileName).toBe(
      resolve(workspaceRoot, "packages/observability/src/index.ts")
    );
  });

  it("loads the public name at the Vitest runtime boundary", async () => {
    // Break caught: a workspace alias is accepted by TypeScript but cannot load the public API in test runtime.
    const publicApi = await import("@orca-hq/observability");

    expect(publicApi.redactDeep({ token: "runtime-secret" })).toEqual({ token: "[Redacted]" });
  });

  it.each(["authorization", "token", "cookie", "voiceUrl", "signedUrl"])(
    "redacts %s wherever it appears in structured data",
    (key) => {
      // Break caught: adding a new event field bypasses the key-based secret filter.
      expect(redactDeep({ outer: { [key]: "secret-value" } })).toEqual({
        outer: { [key]: "[Redacted]" }
      });
    }
  );

  it("redacts caller-configured company data and applies the path disclosure policy", () => {
    // Break caught: a fixture-specific company rule hides only a literal instead of caller-provided private data.
    expect(
      redactDeep(
        {
          workspace: "/Users/someone/orca/workspaces/orca-hq/hq-channels-agents",
          legacyFixture: "company-project-path",
          sourcePath: "/Users/someone/orca/workspaces/orca-hq/hq-channels-agents/runtime.sqlite"
        },
        {
          secretPatterns: [
            /\/Users\/someone\/orca\/workspaces\/orca-hq\/hq-channels-agents/,
            /company-project-path/
          ],
          pathDisclosure: "basename"
        }
      )
    ).toEqual({
      workspace: "[Redacted]",
      legacyFixture: "[Redacted]",
      sourcePath: "runtime.sqlite"
    });
  });

  it("does not impose a universal company-name redaction rule", () => {
    // Break caught: a fixture-specific company prefix becomes an undocumented global data policy.
    expect(redactDeep({ label: "company-private-identifier" })).toEqual({
      label: "company-private-identifier"
    });
  });

  it("exports a complete redacted manifest without raw prompts or transcripts", async () => {
    // Break caught: staged diagnostics include raw runtime data or omit the reviewable manifest contract.
    const bundle = await diagnostics.create({
      version: "2026.09.01",
      capabilities: ["gateway.health"],
      schema: "orca-hq.diagnostics.v1",
      health: {
        workspace: "/Users/someone/orca/workspaces/orca-hq/hq-channels-agents",
        authorization: "Bearer secret-value",
        prompt: "private customer prompt",
        transcript: "private call transcript",
        nested: { token: "nested secret" }
      },
      counters: { commandsProcessed: 3 },
      auditReferences: ["audit:dispatch:123"],
      includeFullContent: false,
      secretPatterns: [
        /\/Users\/someone\/orca\/workspaces\/orca-hq\/hq-channels-agents/,
        /secret-value/,
        /company-project-path/
      ],
      pathDisclosure: "basename"
    });

    expect(bundle.stagingPath).toContain("diagnostics");
    expect(bundle.manifest).toMatchObject({
      version: "2026.09.01",
      capabilities: ["gateway.health"],
      schema: "orca-hq.diagnostics.v1",
      counters: { commandsProcessed: 3 },
      auditReferences: ["audit:dispatch:123"],
      files: ["manifest.json"]
    });
    expect(bundle.manifest.health).toEqual({ workspace: "[Redacted]", nested: {} });
    expect(bundle.manifest.files).not.toContain("runtime.sqlite");
    expect(bundle.text()).not.toContain("secret-value");
    expect(bundle.text()).not.toContain("private customer prompt");
    expect(bundle.text()).not.toContain("private call transcript");
    expect(bundle.text()).not.toContain("company-project-path");
  });

  it("supports the brief's minimal diagnostic creation call with safe manifest defaults", async () => {
    // Break caught: callers cannot create a privacy-safe diagnostic bundle without inventing unrelated metadata.
    const bundle = await diagnostics.create({ includeFullContent: false });

    expect(bundle.manifest).toEqual({
      version: "unknown",
      capabilities: [],
      schema: "orca-hq.diagnostics.v1",
      health: {},
      counters: {},
      auditReferences: [],
      files: ["manifest.json"]
    });
  });

  it("redacts arbitrary-depth and array secrets at the Pino destination boundary", () => {
    // Break caught: Pino path rules redact only shallow event fields while nested payload bytes leak.
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      }
    });

    createLogger(destination).info({
      req: { headers: { authorization: "Bearer depth-three-secret" } },
      jobs: [{ request: { token: "array-token-secret" } }],
      traces: { levelOne: { levelTwo: { signedUrl: "https://signed.example/depth-four-secret" } } }
    }, "request complete");

    expect(output).toContain("[Redacted]");
    expect(output).not.toContain("depth-three-secret");
    expect(output).not.toContain("array-token-secret");
    expect(output).not.toContain("depth-four-secret");
  });

  it("preserves redacted error diagnostics instead of discarding every message", () => {
    // Break caught: safe serialization removes the error code and all non-secret diagnostic context.
    const error = Object.assign(new Error("request failed token=secret-token"), { code: "E_AUTH" });

    expect(safeErrorSerializer(error, { secretPatterns: [/token=[^\s]+/] })).toEqual({
      type: "Error",
      name: "Error",
      code: "E_AUTH",
      message: "request failed [Redacted]"
    });
  });

  it("keeps pilot counters local as aggregate snapshots", () => {
    // Break caught: counters lose prior values or accept invalid decrements.
    const counters = createPilotCounters({ commandsProcessed: 2 });
    counters.increment("commandsProcessed");
    counters.increment("commandsProcessed", -1);

    expect(counters.snapshot()).toEqual({ commandsProcessed: 3 });
  });
});
