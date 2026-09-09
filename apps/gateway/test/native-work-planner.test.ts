import { describe, expect, it } from "vitest";

import { createNativeWorkPlanner } from "../src/native-work-planner.js";
import type { NativeWorkPlannerInput } from "../src/native-work-planner.js";

const planner = createNativeWorkPlanner({
  profiles: {
    implementation: {
      agent: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      reason: "General implementation"
    },
    review: {
      agent: "claude",
      model: "opus",
      effort: "high",
      reason: "Independent review"
    }
  }
});

const trusted = {
  context: {
    requestId: "request_1",
    contextId: "context_1",
    generation: 3
  },
  attempts: [
    { attemptId: "attempt_1", projectId: "orca-hq" },
    { attemptId: "attempt_2", projectId: "orca-hq", resumeTerminalHandle: "term_kept" }
  ],
  projects: [
    {
      projectId: "orca-hq",
      worktreeId: "repo_orca-hq::/workspace/orca-hq",
      checkoutResourceKey: "checkout:/workspace/orca-hq",
      resources: [
        { resourceKey: "checkout:/workspace/orca-hq", mode: "write" as const },
        { resourceKey: "checkout:/workspace/dependency", mode: "read" as const },
        { resourceKey: "docs:/workspace/orca-hq/docs", mode: "read" as const }
      ]
    }
  ]
};

describe("native work planner authority boundary", () => {
  it("derives trusted identity and placement while selecting an allowlisted profile", () => {
    expect(planner.plan({
      ...trusted,
      proposedItems: [
        {
          attemptId: "attempt_1",
          objective: "Implement the contract",
          access: "write",
          resources: [
            { resourceKey: "checkout:/workspace/orca-hq", mode: "write" }
          ],
          dependsOn: [],
          profileKey: "implementation"
        },
        {
          attemptId: "attempt_2",
          objective: "Review the result",
          access: "read",
          resources: [
            { resourceKey: "docs:/workspace/orca-hq/docs", mode: "read" }
          ],
          dependsOn: ["attempt_1"],
          profileKey: "review"
        }
      ]
    })).toEqual([
      {
        attemptId: "attempt_1",
        requestId: "request_1",
        contextId: "context_1",
        generation: 3,
        projectId: "orca-hq",
        worktreeId: "repo_orca-hq::/workspace/orca-hq",
        objective: "Implement the contract",
        access: "write",
        resources: [
          { resourceKey: "checkout:/workspace/orca-hq", mode: "write" }
        ],
        dependsOn: [],
        profile: {
          agent: "codex",
          model: "gpt-5.6-sol",
          effort: "high",
          reason: "General implementation"
        }
      },
      {
        attemptId: "attempt_2",
        requestId: "request_1",
        contextId: "context_1",
        generation: 3,
        projectId: "orca-hq",
        worktreeId: "repo_orca-hq::/workspace/orca-hq",
        objective: "Review the result",
        access: "read",
        resources: [
          { resourceKey: "checkout:/workspace/orca-hq", mode: "read" },
          { resourceKey: "docs:/workspace/orca-hq/docs", mode: "read" }
        ],
        dependsOn: ["attempt_1"],
        profile: {
          agent: "claude",
          model: "opus",
          effort: "high",
          reason: "Independent review"
        },
        resumeTerminalHandle: "term_kept"
      }
    ]);
  });

  it("derives the trusted primary checkout and preserves a proposed secondary checkout", () => {
    const [planned] = planner.plan({
      ...trusted,
      proposedItems: [{
        attemptId: "attempt_1",
        objective: "Review documentation",
        access: "read",
        resources: [
          { resourceKey: "checkout:/workspace/dependency", mode: "read" },
          { resourceKey: "docs:/workspace/orca-hq/docs", mode: "read" }
        ],
        dependsOn: [],
        profileKey: "implementation"
      }]
    });
    expect(planned?.resources).toEqual([
      { resourceKey: "checkout:/workspace/dependency", mode: "read" },
      { resourceKey: "checkout:/workspace/orca-hq", mode: "read" },
      { resourceKey: "docs:/workspace/orca-hq/docs", mode: "read" }
    ]);
  });

  it("rejects profiles, attempts, resources, and write modes outside trusted authority", () => {
    const proposed = {
      attemptId: "attempt_1",
      objective: "Inspect the contract",
      access: "read" as const,
      resources: [
        { resourceKey: "docs:/workspace/orca-hq/docs", mode: "read" as const }
      ],
      dependsOn: [],
      profileKey: "implementation"
    };
    expect(() => planner.plan({
      ...trusted,
      proposedItems: [{ ...proposed, profileKey: "untrusted" }]
    })).toThrow("profile_not_allowed");
    expect(() => planner.plan({
      ...trusted,
      proposedItems: [{ ...proposed, attemptId: "minted_attempt" }]
    })).toThrow("attempt_not_allowed");
    expect(() => planner.plan({
      ...trusted,
      proposedItems: [{
        ...proposed,
        resources: [{ resourceKey: "secret:/outside", mode: "read" }]
      }]
    })).toThrow("resource_not_allowed");
    expect(() => planner.plan({
      ...trusted,
      proposedItems: [{
        ...proposed,
        access: "write",
        resources: [{ resourceKey: "docs:/workspace/orca-hq/docs", mode: "write" }]
      }]
    })).toThrow("resource_mode_not_allowed");
  });

  it("rejects a missing or unallowed trusted primary checkout", () => {
    expect(() => planner.plan({
      ...trusted,
      projects: [{
        ...trusted.projects[0]!,
        checkoutResourceKey: "checkout:/workspace/other"
      }],
      proposedItems: [{
        attemptId: "attempt_1",
        objective: "Inspect the contract",
        access: "read",
        resources: [{ resourceKey: "docs:/workspace/orca-hq/docs", mode: "read" }],
        dependsOn: [],
        profileKey: "implementation"
      }]
    })).toThrow("project_checkout_not_allowed");

    const { checkoutResourceKey: _checkoutResourceKey, ...projectWithoutPrimary } =
      trusted.projects[0]!;
    expect(() => planner.plan({
      ...trusted,
      projects: [projectWithoutPrimary],
      proposedItems: [{
        attemptId: "attempt_1",
        objective: "Inspect the contract",
        access: "read",
        resources: [{ resourceKey: "docs:/workspace/orca-hq/docs", mode: "read" }],
        dependsOn: [],
        profileKey: "implementation"
      }]
    } as unknown as NativeWorkPlannerInput)).toThrow();
  });

  it("rejects authority-bearing fields supplied by model output", () => {
    const inputWithMintedPlacement = {
      ...trusted,
      proposedItems: [{
        attemptId: "attempt_1",
        objective: "Inspect the contract",
        access: "read" as const,
        resources: [{
          resourceKey: "docs:/workspace/orca-hq/docs",
          mode: "read" as const
        }],
        dependsOn: [],
        profileKey: "implementation",
        worktreeId: "attacker::/tmp/other"
      }]
    };
    expect(() => planner.plan(inputWithMintedPlacement)).toThrow();
  });

  it("runs final DAG validation after trusted fields are derived", () => {
    expect(() => planner.plan({
      ...trusted,
      proposedItems: [{
        attemptId: "attempt_1",
        objective: "Inspect the contract",
        access: "read",
        resources: [{ resourceKey: "docs:/workspace/orca-hq/docs", mode: "read" }],
        dependsOn: ["attempt_2"],
        profileKey: "implementation"
      }]
    })).toThrow("unknown_dependency");
  });
});
