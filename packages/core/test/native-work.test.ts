import { describe, expect, it } from "vitest";

import {
  NativeWorkItemSchema,
  NativeWorkPlanSchema,
  NativeWorkerReceiptSchema
} from "../src/native-work.js";

const item = {
  attemptId: "attempt_1",
  requestId: "request_1",
  contextId: "context_1",
  generation: 1,
  projectId: "orca-hq",
  worktreeId: "repo_orca-hq::/workspace/orca-hq",
  objective: "Implement the native work contract",
  access: "write" as const,
  resources: [
    { resourceKey: "checkout:/workspace/orca-hq", mode: "write" as const }
  ],
  dependsOn: [] as string[],
  profile: {
    agent: "codex" as const,
    model: "gpt-5.6-sol",
    effort: "high",
    reason: "General implementation"
  }
};

describe("native work contracts", () => {
  it("parses a complete native work item and rejects an empty resource scope", () => {
    expect(() => NativeWorkItemSchema.parse({ ...item, resources: [] })).toThrow();
    expect(NativeWorkItemSchema.parse(item).profile.model).toBe("gpt-5.6-sol");
  });

  it("rejects launch profiles outside the native agent contract", () => {
    expect(() => NativeWorkItemSchema.parse({
      ...item,
      profile: { ...item.profile, agent: "shell" }
    })).toThrow();
    expect(() => NativeWorkItemSchema.parse({
      ...item,
      profile: { ...item.profile, model: "" }
    })).toThrow();
  });

  it("rejects unknown, self, cyclic, and duplicate dependencies", () => {
    expect(() => NativeWorkPlanSchema.parse([
      { ...item, dependsOn: ["missing"] }
    ])).toThrow("unknown_dependency");
    expect(() => NativeWorkPlanSchema.parse([
      { ...item, dependsOn: [item.attemptId] }
    ])).toThrow("self_dependency");
    expect(() => NativeWorkPlanSchema.parse([
      { ...item, dependsOn: ["attempt_2"] },
      { ...item, attemptId: "attempt_2", dependsOn: [item.attemptId] }
    ])).toThrow("cyclic_dependency");
    expect(() => NativeWorkPlanSchema.parse([
      { ...item, dependsOn: ["attempt_2", "attempt_2"] },
      { ...item, attemptId: "attempt_2" }
    ])).toThrow("duplicate_dependency");
  });

  it("rejects duplicate attempt identities in one plan", () => {
    expect(() => NativeWorkPlanSchema.parse([item, { ...item }])).toThrow(
      "duplicate_attempt_identity"
    );
  });

  it("parses a receipt that keeps requested and effective launch identities separate", () => {
    expect(NativeWorkerReceiptSchema.parse({
      attemptId: "attempt_1",
      runId: "run_1",
      taskId: "task_1",
      dispatchId: "dispatch_1",
      terminalHandle: "term_1",
      worktreeId: "repo_orca-hq::/workspace/orca-hq",
      requested: item.profile,
      effective: {
        agent: "codex",
        model: "gpt-5.6-sol",
        effort: "high"
      }
    })).toMatchObject({ dispatchId: "dispatch_1", requested: item.profile });
  });
});
