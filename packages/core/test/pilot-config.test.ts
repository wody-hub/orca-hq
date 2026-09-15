import { describe, expect, it } from "vitest";

import { PilotConfigSchema, parsePilotConfigText } from "../src/index.js";

const base = {
  schema: "orca-hq.private-pilot.v1",
  databasePath: "/tmp/hq/hq.db",
  projectRegistryPath: "/tmp/hq/projects.json",
  credentialAccounts: ["openai"]
};

const primary = { agent: "codex", model: "gpt-5.6-sol", effort: "high", reason: "HQ substantive work" };

function parse(nativeExecution: unknown) {
  return PilotConfigSchema.safeParse({ ...base, nativeExecution });
}

describe("pilot config native execution block", () => {
  it("keeps an installed config without the block valid, leaving every runtime default in place", () => {
    const parsed = PilotConfigSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.nativeExecution).toBeUndefined();
  });

  it("accepts a fully specified block through the same text parser the runtime uses", () => {
    const config = parsePilotConfigText(JSON.stringify({
      ...base,
      nativeExecution: { maxActiveWorkers: 3, retentionPolicy: "release", roleProfiles: { primary } }
    }));
    expect(config.nativeExecution).toEqual({ maxActiveWorkers: 3, retentionPolicy: "release", roleProfiles: { primary } });
    expect(parsePilotConfigText(JSON.stringify({ ...base, nativeExecution: { maxActiveWorkers: "unlimited" } })).nativeExecution)
      .toEqual({ maxActiveWorkers: "unlimited" });
  });

  it("rejects a worker limit that is null, fractional, zero, negative or beyond the safe integer range", () => {
    // Break caught: the admission gate itself only throws a bare `maxActiveWorkers must be a
    // positive safe integer` TypeError at boot, so each of these has to fail at config parse time.
    for (const maxActiveWorkers of [null, 2.5, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 1e21, "10", "unbounded"])
      expect(parse({ maxActiveWorkers }).success, `${String(maxActiveWorkers)} must be rejected`).toBe(false);
    expect(parse({ maxActiveWorkers: Number.MAX_SAFE_INTEGER }).success).toBe(true);
    expect(parse({ maxActiveWorkers: 1 }).success).toBe(true);
  });

  it("rejects a null or unknown retention policy rather than falling back to a silent default", () => {
    for (const retentionPolicy of [null, "keep", "", 1])
      expect(parse({ retentionPolicy }).success).toBe(false);
  });

  it("rejects a declared role profile set that has no primary, since it replaces the defaults wholesale", () => {
    // Break caught: without this the runtime would parse the file, then crash at startup with
    // `native_profile_primary_required` instead of naming the configuration mistake.
    expect(parse({ roleProfiles: {} }).success).toBe(false);
    expect(parse({ roleProfiles: { secondary: primary } }).success).toBe(false);
    const issue = parse({ roleProfiles: { secondary: primary } });
    expect(!issue.success && issue.error.issues[0]?.message).toBe("native_profile_primary_required");
    expect(parse({ roleProfiles: { primary, secondary: { agent: "claude", model: "opus", reason: "review" } } }).success).toBe(true);
  });

  it("rejects a malformed or null profile, including an agent outside the supported providers", () => {
    for (const profile of [null, {}, { agent: "codex" }, { agent: "gemini", model: "m", reason: "r" }, { agent: "codex", model: "", reason: "r" }, { agent: "codex", model: "m" }, { ...primary, extra: 1 }])
      expect(parse({ roleProfiles: { primary: profile } }).success, `${JSON.stringify(profile)} must be rejected`).toBe(false);
  });

  it("rejects a null block and any unknown key inside it instead of ignoring the operator's intent", () => {
    expect(parse(null).success).toBe(false);
    expect(parse({ maxWorkers: 4 }).success).toBe(false);
    expect(parse({ roleProfiles: { "": primary } }).success).toBe(false);
  });
});
