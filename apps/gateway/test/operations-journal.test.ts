import { describe, expect, it } from "vitest";
import { openDatabase } from "@orca-hq/persistence";
import { OperationsJournal } from "../src/operations-journal.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("operations durable intent", () => {
  it("serializes concurrent duplicates and rejects changed identity before effect", async () => {
    const db = openDatabase(":memory:");
    const journal = new OperationsJournal(db);
    let effects = 0;
    const input = {
      requestId: "req",
      action: "reply",
      targetId: "msg",
      input: { body: "private text" },
    };
    const effect = async () => {
      effects++;
      await Promise.resolve();
      return { state: "accepted" as const };
    };
    const [a, b] = await Promise.all([
      journal.execute(input, effect),
      journal.execute(input, effect),
    ]);
    expect(a).toEqual(b);
    expect(effects).toBe(1);
    await expect(
      journal.execute({ ...input, targetId: "other" }, effect),
    ).rejects.toThrow("idempotency_conflict");
    expect(effects).toBe(1);
    expect(
      JSON.stringify(
        db.prepare("SELECT * FROM operations_mutation_receipts").all(),
      ),
    ).not.toContain("private text");
    db.close();
  });
  it("persists ambiguous effects and interrupted intents as unknown across restart", async () => {
    const db = openDatabase(":memory:");
    const journal = new OperationsJournal(db);
    const input = {
      requestId: "req",
      action: "stop",
      targetId: "dispatch",
      input: {},
    };
    expect(
      (
        await journal.execute(input, async () => {
          throw Error("token=secret timeout");
        })
      ).state,
    ).toBe("unknown");
    db.prepare(
      "UPDATE operations_mutation_receipts SET state='prepared' WHERE request_id='req'",
    ).run();
    const restarted = new OperationsJournal(db);
    let calls = 0;
    expect(
      (
        await restarted.execute(input, async () => {
          calls++;
          return { state: "accepted" };
        })
      ).state,
    ).toBe("unknown");
    expect(calls).toBe(0);
    expect(
      JSON.stringify(
        db.prepare("SELECT * FROM operations_mutation_receipts").all(),
      ),
    ).not.toContain("secret");
    db.close();
  });
  it("reloads an interrupted intent as unknown after an on-disk database restart", async () => {
    // Break caught: recovery that works only in one SQLite connection can replay an effect after a real process restart.
    const directory = await mkdtemp(join(tmpdir(), "operations-journal-restart-"));
    const path = join(directory, "control.sqlite");
    const input = { requestId: "disk-request", action: "release", targetId: "dispatch-1", input: { runId: "run-1" } };
    try {
      const first = openDatabase(path); const journal = new OperationsJournal(first);
      await journal.execute(input, async () => ({ state: "accepted" }));
      first.prepare("UPDATE operations_mutation_receipts SET state='prepared' WHERE request_id=?").run(input.requestId);
      first.close();
      const second = openDatabase(path); const restarted = new OperationsJournal(second); let effects = 0;
      expect(await restarted.execute(input, async () => { effects++; return { state: "accepted" }; })).toMatchObject({ state: "unknown", detail: "interrupted" });
      expect(effects).toBe(0);
      second.close();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
