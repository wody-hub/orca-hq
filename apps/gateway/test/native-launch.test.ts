import { describe, expect, it } from "vitest";
import type { NativeWorkItem } from "@orca-hq/core";

import {
  buildWorkerStartArgs,
  validateTerminalReuse,
  type NativeTerminalReuseEvidence
} from "../src/native-launch.js";

const item: NativeWorkItem = {
  attemptId: "attempt_x",
  requestId: "request_x",
  contextId: "context_x",
  generation: 1,
  projectId: "repo_x",
  worktreeId: "repo_x::/workspace/project",
  objective: "Implement the requested change",
  access: "write",
  resources: [{ resourceKey: "checkout:/workspace/project", mode: "write" }],
  dependsOn: [],
  profile: {
    agent: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
    reason: "Implementation profile"
  }
};

function reusable(
  patch: Partial<NativeTerminalReuseEvidence> = {}
): NativeTerminalReuseEvidence {
  return {
    terminalHandle: "term_retained",
    worktreeId: item.worktreeId,
    contextId: item.contextId,
    priorAttemptId: "attempt_prior",
    priorDispatchId: "dispatch_prior",
    sessionId: "session_prior",
    state: "idle",
    ownership: "hq_retained",
    connected: true,
    writable: true,
    requested: item.profile,
    effective: {
      agent: "codex",
      model: "gpt-5.6-sol",
      effort: "high"
    },
    ...patch
  };
}

describe("native worker launch arguments", () => {
  it("builds an explicit public-CLI launch for the admitted profile in the exact checkout", () => {
    expect(buildWorkerStartArgs(item, { runId: "run_x", taskId: "task_x" }))
      .toEqual([
        "worker-start",
        "--task", "task_x",
        "--run", "run_x",
        "--worktree", `id:${item.worktreeId}`,
        "--agent", "codex",
        "--model", "gpt-5.6-sol",
        "--effort", "high",
        "--timeout-ms", "60000"
      ]);
  });

  it("reuses only the exact retained idle session without launch-profile flags", () => {
    const reused = { ...item, resumeTerminalHandle: "term_retained" };
    validateTerminalReuse(reused, reusable());

    const args = buildWorkerStartArgs(reused, {
      runId: "run_x",
      taskId: "task_x"
    });

    expect(args).toEqual([
      "worker-start",
      "--task", "task_x",
      "--run", "run_x",
      "--worktree", `id:${item.worktreeId}`,
      "--terminal", "term_retained",
      "--timeout-ms", "60000"
    ]);
    expect(args).not.toEqual(expect.arrayContaining(["--agent"]));
    expect(args).not.toEqual(expect.arrayContaining(["--model"]));
    expect(args).not.toEqual(expect.arrayContaining(["--effort"]));
  });

  it.each([
    ["worktree", { worktreeId: "repo_x::/workspace/other" }],
    ["context", { contextId: "context_other" }],
    ["ownership", { ownership: "user_owned" }],
    ["idle state", { state: "busy" }],
    ["connection", { connected: false }]
  ] as const)("rejects retained-terminal reuse with mismatched %s evidence", (_name, patch) => {
    const reused = { ...item, resumeTerminalHandle: "term_retained" };
    expect(() => validateTerminalReuse(reused, reusable(patch)))
      .toThrow("terminal_reuse_not_authorized");
  });

  it("requires a fresh terminal when the selected model changes", () => {
    const reused = { ...item, resumeTerminalHandle: "term_retained" };
    expect(() => validateTerminalReuse(reused, reusable({
      requested: { ...item.profile, model: "gpt-6-astra" },
      effective: { agent: "codex", model: "gpt-6-astra", effort: "high" }
    }))).toThrow("terminal_reuse_profile_changed_requires_fresh_context_handoff");
  });
});
