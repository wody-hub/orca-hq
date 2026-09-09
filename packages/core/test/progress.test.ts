import { describe, expect, it } from "vitest";

import {
  ContextChoiceSchema,
  ContextExecutionSchema,
  ProgressEventInputSchema,
  ProgressEventSchema,
  SubmitProgressRequestSchema
} from "../src/progress.js";

describe("progress contracts", () => {
  it("accepts the public request and execution wire contracts", () => {
    expect(SubmitProgressRequestSchema.parse({
      requestId: "req_1",
      sessionId: "session_1",
      text: "Inspect the gateway",
      contextHint: { mode: "continue", contextId: "ctx_1" }
    })).toMatchObject({ requestId: "req_1", contextHint: { contextId: "ctx_1" } });
    expect(ContextExecutionSchema.parse({
      contextId: "ctx_1",
      requestId: "req_1",
      agentId: "agent_1",
      generation: 2,
      resources: [{ resourceKey: "checkout:/workspace/project", mode: "write" }]
    }).generation).toBe(2);
  });

  it("keeps server-owned identity and invalid context hints out of JSON input", () => {
    expect(() => SubmitProgressRequestSchema.parse({
      requestId: "req_1",
      sessionId: "session_1",
      text: "Inspect",
      ownerKey: "attacker"
    })).toThrow();
    expect(() => SubmitProgressRequestSchema.parse({
      requestId: "req_1",
      sessionId: "session_1",
      text: "Continue",
      contextHint: { mode: "continue" }
    })).toThrow();
    expect(() => SubmitProgressRequestSchema.parse({
      requestId: "req_1",
      sessionId: "session_1",
      text: "New",
      contextHint: { mode: "new", contextId: "ctx_existing" }
    })).toThrow();
    expect(() => SubmitProgressRequestSchema.parse({
      requestId: "r".repeat(101),
      sessionId: "session_1",
      text: "Too-long opaque identifier"
    })).toThrow();
    expect(() => ContextExecutionSchema.parse({
      contextId: "ctx_1",
      requestId: "req_1",
      agentId: "agent_1",
      generation: 1,
      resources: []
    })).toThrow();
  });

  it("validates structured routing choices and persisted JSON events", () => {
    expect(ContextChoiceSchema.parse({
      action: "new",
      title: "Gateway progress",
      objective: "Add durable progress observation",
      projectIds: ["orca-hq"]
    }).action).toBe("new");
    expect(ProgressEventSchema.parse({
      seq: 1,
      eventKey: "request:req_1:accepted",
      requestId: "req_1",
      contextId: null,
      kind: "request.accepted",
      source: "system",
      occurredAt: "2026-09-08T00:00:00.000Z",
      payload: { text: "Accepted", nested: { safe: true } }
    }).payload).toEqual({ text: "Accepted", nested: { safe: true } });
    expect(() => ProgressEventSchema.parse({
      seq: 1,
      eventKey: "bad",
      requestId: "req_1",
      contextId: null,
      kind: "invented.progress",
      source: "system",
      occurredAt: "2026-09-08T00:00:00.000Z",
      payload: {}
    })).toThrow();
  });

  it("validates truthful native worker identities while preserving legacy events", () => {
    const event = {
      seq: 2,
      eventKey: "attempt:attempt_1:ready",
      requestId: "req_1",
      contextId: "ctx_1",
      kind: "worker.ready" as const,
      source: "orca" as const,
      occurredAt: "2026-09-08T00:01:00.000Z",
      payload: {
        attemptId: "attempt_1",
        runId: "run_1",
        taskId: "task_1",
        dispatchId: "dispatch_1",
        terminalHandle: "term_1",
        worktreeId: "repo_orca-hq::/workspace/orca-hq",
        requested: {
          agent: "codex",
          model: "gpt-5.6-sol",
          effort: "high",
          reason: "General implementation"
        },
        effective: {
          agent: "codex",
          model: "gpt-5.6-sol",
          effort: "high"
        }
      },
      agentId: "agent_1",
      generation: 1
    };
    expect(ProgressEventSchema.parse(event).kind).toBe("worker.ready");
    expect(ProgressEventSchema.parse({
      ...event,
      kind: "worker.retained"
    }).kind).toBe("worker.retained");
    const { dispatchId: _dispatchId, ...identityWithoutDispatch } = event.payload;
    expect(() => ProgressEventSchema.parse({
      ...event,
      payload: identityWithoutDispatch
    })).toThrow("native_worker_identity_required");

    expect(ProgressEventSchema.parse({
      ...event,
      kind: "agent.started",
      payload: { text: "legacy event without native identity" }
    }).kind).toBe("agent.started");
  });

  it("accepts launch identity before Orca IDs exist and requires an assigned attempt", () => {
    const launching = {
      seq: 3,
      eventKey: "attempt:attempt_1:launching",
      requestId: "req_1",
      contextId: "ctx_1",
      kind: "worker.launching" as const,
      source: "hq" as const,
      occurredAt: "2026-09-08T00:02:00.000Z",
      payload: {
        attemptId: "attempt_1",
        worktreeId: "repo_orca-hq::/workspace/orca-hq",
        requested: {
          agent: "codex",
          model: "gpt-5.6-sol",
          reason: "General implementation"
        }
      },
      generation: 1
    };
    expect(ProgressEventSchema.parse(launching).kind).toBe("worker.launching");
    expect(ProgressEventSchema.parse({
      ...launching,
      kind: "worker.recovery_required"
    }).kind).toBe("worker.recovery_required");
    expect(() => ProgressEventSchema.parse({
      ...launching,
      payload: { worktreeId: launching.payload.worktreeId, requested: launching.payload.requested }
    })).toThrow("native_worker_identity_required");
    expect(ProgressEventSchema.parse({
      ...launching,
      kind: "worker.recovery_required",
      payload: { ...launching.payload, dispatchId: "dispatch_partial" }
    }).payload.dispatchId).toBe("dispatch_partial");
  });

  it("round-trips native worktree identities longer than legacy progress IDs", () => {
    const worktreeId = `repo_orca-hq::/${"nested/".repeat(20)}orca-hq`;
    expect(ProgressEventSchema.parse({
      seq: 4,
      eventKey: "attempt:attempt_long:launching",
      requestId: "req_1",
      contextId: "ctx_1",
      kind: "worker.launching",
      source: "hq",
      occurredAt: "2026-09-08T00:03:00.000Z",
      payload: {
        attemptId: "attempt_long",
        worktreeId,
        requested: {
          agent: "codex",
          model: "gpt-5.6-sol",
          reason: "General implementation"
        }
      },
      generation: 1
    }).payload.worktreeId).toBe(worktreeId);
  });

  it("rejects malformed native identity in the pre-persistence event input schema", () => {
    expect(() => ProgressEventInputSchema.parse({
      eventKey: "attempt:attempt_1:ready",
      requestId: "req_1",
      contextId: "ctx_1",
      kind: "worker.ready",
      source: "orca",
      occurredAt: "2026-09-08T00:04:00.000Z",
      payload: {
        attemptId: "attempt_1",
        worktreeId: "repo_orca-hq::/workspace/orca-hq",
        requested: {
          agent: "codex",
          model: "gpt-5.6-sol",
          reason: "General implementation"
        }
      },
      generation: 1
    })).toThrow("native_worker_identity_required");
  });
});
