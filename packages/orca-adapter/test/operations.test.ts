import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { createFakeOrca } from "../../test-support/src/fake-orca.js";
import { OrcaClient } from "../src/index.js";
import { operationArguments, parseOrcaOperation } from "../src/capabilities.js";
import { parseOrcaOperationsReceipt } from "../src/receipts.js";

describe("operations CLI variants", () => {
  it("builds typed argv for every operations control without JSON", () => {
    // Break caught: a route could inject raw argv or place JSON twice.
    expect(operationArguments(parseOrcaOperation({ kind: "operations_status" }))).toEqual(["status"]);
    expect(operationArguments(parseOrcaOperation({ kind: "operations_dispatch", taskId: "task", terminalHandle: "term", inject: true, retryRequestId: "request" }))).toEqual(["orchestration", "dispatch", "--task", "task", "--to", "term", "--inject", "--retry-request", "request"]);
    expect(operationArguments(parseOrcaOperation({ kind: "operations_dispatch", taskId: "task", terminalHandle: "term", inject: false, retryRequestId: "request" }))).toEqual(["orchestration", "dispatch", "--task", "task", "--to", "term", "--retry-request", "request"]);
    expect(operationArguments(parseOrcaOperation({ kind: "operations_reply", messageId: "message", body: "answer", retryRequestId: "request" }))).toEqual(["orchestration", "reply", "--id", "message", "--body", "answer", "--retry-request", "request"]);
    expect(operationArguments(parseOrcaOperation({ kind: "operations_send", dispatchId: "dispatch", body: "status", retryRequestId: "request" }))).toEqual(["orchestration", "send", "--subject", "HQ operator follow-up", "--to", "dispatch:dispatch", "--type", "status", "--body", "status", "--retry-request", "request"]);
    expect(operationArguments(parseOrcaOperation({ kind: "operations_stop", dispatchId: "dispatch", retryRequestId: "request" }))).toEqual(["orchestration", "worker-stop", "--dispatch", "dispatch", "--retry-request", "request"]);
    expect(operationArguments(parseOrcaOperation({ kind: "operations_retain", dispatchId: "dispatch", retryRequestId: "request" }))).toEqual(["orchestration", "worker-retain", "--dispatch", "dispatch", "--retry-request", "request"]);
    expect(operationArguments(parseOrcaOperation({ kind: "operations_release", dispatchId: "dispatch", retryRequestId: "request" }))).toEqual(["orchestration", "worker-release", "--dispatch", "dispatch", "--retry-request", "request"]);
    expect(operationArguments(parseOrcaOperation({ kind: "list_runs", limit: 100, cursor: "cursor" }))).toEqual(["orchestration", "run-list", "--limit", "100", "--cursor", "cursor"]);
    expect(operationArguments(parseOrcaOperation({ kind: "show_run", runId: "run" }))).toEqual(["orchestration", "run-show", "--id", "run"]);
    expect(operationArguments(parseOrcaOperation({ kind: "list_tasks", runId: "run" }))).toEqual(["orchestration", "task-list", "--run", "run", "--brief"]);
    expect(operationArguments(parseOrcaOperation({ kind: "list_workers", runId: "run", cursor: "cursor" }))).toEqual(["orchestration", "worker-list", "--run", "run", "--cursor", "cursor"]);
    expect(operationArguments(parseOrcaOperation({ kind: "operations_worker_read", dispatchId: "dispatch", source: "terminal", limit: 500 }))).toEqual(["orchestration", "worker-read", "--dispatch", "dispatch", "--source", "terminal", "--limit", "500"]);
    expect(operationArguments(parseOrcaOperation({ kind: "operations_inbox", limit: 100 }))).toEqual(["orchestration", "inbox", "--limit", "100"]);
    expect(operationArguments(parseOrcaOperation({ kind: "operations_list_projects" }))).toEqual(["project", "list"]);
    expect(operationArguments(parseOrcaOperation({ kind: "list_project_setups", projectId: "project" }))).toEqual(["project", "setups", "--project", "project"]);
    expect(operationArguments(parseOrcaOperation({ kind: "list_worktrees", repoId: "repo", limit: 100 }))).toEqual(["worktree", "list", "--repo", "id:repo", "--limit", "100"]);
    expect(operationArguments(parseOrcaOperation({ kind: "show_worktree", worktreeId: "worktree" }))).toEqual(["worktree", "show", "--worktree", "worktree"]);
    expect(operationArguments(parseOrcaOperation({ kind: "list_terminals", worktreeId: "worktree" }))).toEqual(["terminal", "list", "--worktree", "worktree"]);
    expect(operationArguments(parseOrcaOperation({ kind: "show_terminal", terminalHandle: "term" }))).toEqual(["terminal", "show", "--terminal", "term"]);
    expect(operationArguments(parseOrcaOperation({ kind: "read_terminal", terminalHandle: "term", cursor: "cursor" }))).toEqual(["terminal", "read", "--terminal", "term", "--cursor", "cursor"]);
  });

  it("rejects whitespace and oversized operation fields", () => {
    // Break caught: unbounded public input can bypass the typed argv boundary and exhaust a child invocation.
    expect(() => parseOrcaOperation({ kind: "show_run", runId: "   " })).toThrow();
    expect(() => parseOrcaOperation({ kind: "operations_reply", messageId: "m", body: "x".repeat(8_193), retryRequestId: "r" })).toThrow();
    expect(() => parseOrcaOperation({ kind: "read_terminal", terminalHandle: "t", cursor: "x".repeat(2_049) })).toThrow();
    expect(() => parseOrcaOperation({ kind: "operations_dispatch", taskId: "task", terminalHandle: "term", inject: "yes", retryRequestId: "request" } as never)).toThrow();
  });

  it("validates each operations receipt result instead of only its envelope", () => {
    // Break caught: `{ok:true,result:{}}` must not become trusted state for any public operation.
    const parse = parseOrcaOperationsReceipt as unknown as (kind: string, value: unknown) => unknown;
    const valid = { id: "receipt", ok: true, result: { runs: [{ id: "run", objective: "work" }], nextCursor: "next" } };
    expect(parse("list_runs", valid)).toMatchObject(valid);
    for (const kind of ["operations_status", "list_runs", "show_run", "list_tasks", "list_workers", "operations_worker_read", "operations_inbox", "operations_list_projects", "list_project_setups", "list_worktrees", "show_worktree", "list_terminals", "show_terminal", "read_terminal", "operations_dispatch", "operations_reply", "operations_send", "operations_stop", "operations_retain", "operations_release"]) {
      expect(() => parse(kind, { id: "receipt", ok: true, result: {} })).toThrow();
    }
  });

  it("rejects nonempty malformed operation receipts", () => {
    // Break caught: presence-only reply checks and blank lifecycle verdicts accept unusable receipts.
    const receipt = (result: unknown) => ({ id: "receipt", ok: true, result });
    expect(() => parseOrcaOperationsReceipt("operations_reply", receipt({ mutation: { requestId: "request", replayed: false }, reply: 42 }))).toThrow();
  });

  it("rejects blank lifecycle states and verdicts", () => {
    // Break caught: a target identity alone cannot turn an empty verdict into a valid receipt.
    const receipt = (result: unknown) => ({ id: "receipt", ok: true, result });
    for (const kind of ["operations_stop", "operations_retain", "operations_release"] as const) {
      expect(() => parseOrcaOperationsReceipt(kind, receipt({ dispatchId: "dispatch", state: "   ", verdict: "stopped" }))).toThrow();
      expect(() => parseOrcaOperationsReceipt(kind, receipt({ dispatchId: "dispatch", state: "stopped", verdict: "   " }))).toThrow();
      expect(parseOrcaOperationsReceipt(kind, receipt({ dispatchId: "dispatch", state: "stopped", verdict: "stopped" }))).toBeDefined();
    }
  });

  it("bounds worker output and requires source-matching content", () => {
    // Break caught: the legacy permissive read union cannot be the public operations boundary.
    const base = { dispatchId: "dispatch", cursor: "cursor", status: { worker: "ready", terminal: "ready" }, warnings: [], archived: false };
    const terminal = { lines: ["safe"], limited: false, nextCursor: "next" };
    const transcript = { messages: [{ id: "message", role: "assistant", blocks: [{ type: "text", text: "safe" }], timestamp: 1, source: "transcript" }], limited: false, nextCursor: "next", returnedMessageCount: 1 };
    const parse = (result: unknown) => parseOrcaOperationsReceipt("operations_worker_read", { id: "receipt", ok: true, result });
    expect(parse({ ...base, source: "terminal", terminal })).toBeDefined();
    expect(parse({ ...base, source: "transcript", transcript })).toBeDefined();
    for (const result of [
      { ...base, source: "transcript", terminal },
      { ...base, source: "terminal", transcript },
      { ...base, source: "terminal", terminal, transcript },
      { ...base, source: "transcript", transcript, terminal },
      { ...base, source: "terminal" },
      { ...base, source: "terminal", terminal: { ...terminal, lines: Array(501).fill("line") } },
      { ...base, source: "terminal", terminal: { ...terminal, lines: ["x".repeat(65_537)] } },
      { ...base, source: "transcript", transcript: { ...transcript, messages: Array(501).fill(transcript.messages[0]) } },
      { ...base, source: "terminal", terminal, cursor: "x".repeat(2049) },
      { ...base, source: "terminal", terminal, dispatchId: " " },
      { ...base, source: "terminal", terminal, warnings: Array(101).fill("warning") },
      { ...base, source: "transcript", transcript: { ...transcript, messages: [{ ...transcript.messages[0], blocks: [{ text: "x".repeat(65_537) }] }] } }
    ]) expect(() => parse(result)).toThrow();
  });

  it("validates public reply/message structure and returned identities", async () => {
    // Shape observed in Orca 1.4.203 reply to msg_af1d64d147f0 (coordinator evidence msg_5c6866844d09).
    // Break caught: another message, question, Dispatch, or retry request cannot satisfy this invocation.
    const message = { id: "answer", run_id: "run", from_handle: "run:run", to_handle: "dispatch:dispatch", subject: "Re: Question", body: "answer", type: "status", priority: "normal", thread_id: "wanted", payload: null, created_at: "2026-09-15T08:24:00Z", delivered_at: null, delivery_contract: "current_delivery" };
    const question = { message_id: "wanted", run_id: "run", dispatch_id: "dispatch", asker_handle: "term", status: "answered", answer_message_id: "answer", answer_body: "answer", answered_by_generation: 1, created_at: "2026-09-15T08:23:00Z", answered_at: "2026-09-15T08:24:00Z", closed_at: null };
    const mutation = { requestId: "request", replayed: false };
    const result = { message, question, duplicate: false, mutation };
    const receipt = (value: unknown) => ({ id: "receipt", ok: true, result: value });
    expect(parseOrcaOperationsReceipt("operations_reply", receipt(result))).toBeDefined();
    expect(parseOrcaOperationsReceipt("operations_reply", receipt({ message, duplicate: false, mutation }))).toBeDefined();
    for (const value of [{ ...result, message: 42 }, { ...result, message: { ...message, thread_id: " " } }, { ...result, question: 42 }, { ...result, question: { ...question, message_id: " " } }]) {
      expect(() => parseOrcaOperationsReceipt("operations_reply", receipt(value))).toThrow();
    }
    const fake = await createFakeOrca();
    try {
      const status = JSON.parse(await readFile(new URL("./fixtures/status-1.4.194.json", import.meta.url), "utf8")) as unknown;
      await fake.enqueueJson(["status", "--json"], status);
      for (const name of ["orca-cli", "orchestration"] as const) await fake.enqueueJson(["skills", "get", name, "--json"], { name, full: false, markdown: "public contract" });
      const client = new OrcaClient({ executablePath: fake.executablePath, signal: new AbortController().signal, timeoutMs: 5_000, expectedVersionRange: ">=1.4.194" });
      const reply = { kind: "operations_reply", messageId: "wanted", body: "answer", retryRequestId: "request" } as const;
      for (const value of [
        { ...result, message: { ...message, thread_id: "other" } },
        { ...result, question: { ...question, message_id: "other" } },
        { ...result, question: { ...question, answer_message_id: "other" } },
        { ...result, mutation: { requestId: "other", replayed: false } }
      ]) {
        await fake.enqueueJson([...operationArguments(reply), "--json"], receipt(value));
        await expect(client.execute(reply)).rejects.toMatchObject({ code: "invalid_orca_receipt" });
      }
      await fake.enqueueJson([...operationArguments(reply), "--json"], receipt(result));
      await expect(client.execute(reply)).resolves.toMatchObject({ result: { message: { thread_id: "wanted" } } });
      const send = { kind: "operations_send", dispatchId: "dispatch", body: "answer", retryRequestId: "request" } as const;
      for (const value of [
        { message: { ...message, to_handle: "dispatch:other", thread_id: null }, mutation },
        { message: { ...message, thread_id: null }, mutation: { requestId: "other", replayed: false } }
      ]) {
        await fake.enqueueJson([...operationArguments(send), "--json"], receipt(value));
        await expect(client.execute(send)).rejects.toMatchObject({ code: "invalid_orca_receipt" });
      }
      await fake.enqueueJson([...operationArguments(send), "--json"], receipt({ message: { ...message, thread_id: null }, mutation }));
      await expect(client.execute(send)).resolves.toMatchObject({ result: { message: { to_handle: "dispatch:dispatch" } } });
    } finally { await fake.cleanup(); }
  });

  it("rejects a mutation receipt for a different target", async () => {
    // Break caught: a successful receipt for another Dispatch must not authorize the requested control.
    const fake = await createFakeOrca();
    try {
      const status = JSON.parse(await readFile(new URL("./fixtures/status-1.4.194.json", import.meta.url), "utf8")) as unknown;
      await fake.enqueueJson(["status", "--json"], status);
      for (const name of ["orca-cli", "orchestration"] as const) {
        await fake.enqueueJson(["skills", "get", name, "--json"], { name, full: false, markdown: "public contract" });
      }
      const client = new OrcaClient({ executablePath: fake.executablePath, signal: new AbortController().signal, timeoutMs: 5_000, expectedVersionRange: ">=1.4.194" });
      for (const kind of ["operations_stop", "operations_retain", "operations_release"] as const) {
        const operation = { kind, dispatchId: "wanted", retryRequestId: "request" };
        for (const result of [
          { dispatchId: "other", state: "stopped", verdict: "stopped" },
          { dispatchId: "wanted", state: "stopped", verdict: "stopped", mutation: { requestId: "other", replayed: false } }
        ]) {
          await fake.enqueueJson([...operationArguments(operation), "--json"], { id: "receipt", ok: true, result });
          await expect(client.execute(operation)).rejects.toMatchObject({ code: "invalid_orca_receipt" });
        }
      }
      const dispatch = { kind: "operations_dispatch", taskId: "task", terminalHandle: "term", inject: true, retryRequestId: "request" } as const;
      for (const result of [
        { dispatchId: "dispatch", taskId: "other", runId: "run" },
        { dispatchId: "dispatch", taskId: "task", runId: "run", mutation: { requestId: "other", replayed: false } }
      ]) {
        await fake.enqueueJson([...operationArguments(dispatch), "--json"], { id: "receipt", ok: true, result });
        await expect(client.execute(dispatch)).rejects.toMatchObject({ code: "invalid_orca_receipt" });
      }
    } finally {
      await fake.cleanup();
    }
  });
});

it("maps explicit trusted coordinator scope only on public commands that support it", () => {
  expect(
    operationArguments({
      kind: "operations_reply",
      messageId: "msg",
      body: "answer",
      retryRequestId: "req",
      senderHandle: "term_owner",
      runId: "run_owner",
    }),
  ).toEqual([
    "orchestration",
    "reply",
    "--id",
    "msg",
    "--body",
    "answer",
    "--retry-request",
    "req",
    "--from",
    "term_owner",
    "--run",
    "run_owner",
  ]);
});
it("parses current camelCase worker details without requiring obsolete snake_case fields", () => {
  expect(() =>
    parseOrcaOperationsReceipt("operations_show_worker", {
      id: "r",
      ok: true,
      result: {
        dispatch: {
          id: "d",
          runId: "run",
          taskId: "task",
          status: "dispatched",
          processIncarnation: "pty:inc",
        },
        worker: {
          dispatchId: "d",
          state: "ready",
          stage: "input_accepted",
          agentTerminalHandle: "term",
        },
        projection: {
          dispatchId: "d",
          taskId: "task",
          runId: "run",
          liveness: { verdict: "live" },
        },
        observation: { status: "live", exactWorker: true },
        terminal: null,
        terminalResource: {
          id: "resource",
          ownershipState: "owned",
          releaseState: "not_requested",
        },
      },
    }),
  ).not.toThrow();
});
it("fences current worker read identities in the existing client too", async () => {
  const fake = await createFakeOrca();
  try {
    await fake.enqueueJson(
      ["status", "--json"],
      JSON.parse(
        await readFile(
          new URL("./fixtures/status-1.4.194.json", import.meta.url),
          "utf8",
        ),
      ),
    );
    for (const name of ["orca-cli", "orchestration"])
      await fake.enqueueJson(["skills", "get", name, "--json"], {
        name,
        full: false,
        markdown: "public contract",
      });
    const client = new OrcaClient({
      executablePath: fake.executablePath,
      signal: new AbortController().signal,
      expectedVersionRange: ">=1.4.194",
    });
    await fake.enqueueJson(
      ["orchestration", "worker-show", "--dispatch", "wanted", "--json"],
      {
        id: "r",
        ok: true,
        result: {
          dispatch: {
            id: "other",
            runId: "run",
            taskId: "task",
            status: "dispatched",
          },
          worker: {
            dispatchId: "other",
            state: "ready",
            stage: "ready",
            agentTerminalHandle: "term",
          },
          projection: {
            dispatchId: "other",
            taskId: "task",
            runId: "run",
            liveness: { verdict: "live" },
          },
          observation: { status: "live", exactWorker: true },
          terminal: null,
          terminalResource: {
            id: "resource",
            ownershipState: "owned",
            releaseState: "not_requested",
          },
        },
      },
    );
    await expect(
      client.execute({ kind: "operations_show_worker", dispatchId: "wanted" }),
    ).rejects.toMatchObject({ code: "invalid_orca_receipt" });
  } finally {
    await fake.cleanup();
  }
});
