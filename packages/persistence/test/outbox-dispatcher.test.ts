import { randomUUID } from "node:crypto";

import type { OutboundDeliveryPort } from "@orca-hq/core";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ControlStore, openDatabase, OutboxDispatcher } from "../src/index.js";
import { deliverTelegramMessage } from "../../telegram-adapter/src/outbound.js";

const now = "2026-09-01T00:00:00.000Z";
const nextAttempt = "2026-09-01T00:00:01.000Z";

describe("OutboxDispatcher", () => {
  let database: Database.Database;
  let store: ControlStore;

  beforeEach(() => {
    database = openDatabase(":memory:");
    store = new ControlStore(database);
    insertCompletedTask(database);
    store.enqueueOutbox({
      id: "m1",
      commandId: "command-1",
      channel: "slack",
      destination: "C123",
      template: "progress",
      payload: {
        text: "Completed result",
        threadId: "171.001",
        taskId: "t1"
      },
      nextAttemptAt: now
    });
  });

  afterEach(() => {
    database.close();
  });

  it("keeps completed work pending for delivery when Slack is disconnected", async () => {
    // Break caught: acknowledging or mutating completed work on a retryable provider failure loses recovery truth.
    const slack = deliveryPort()
      .mockRejectedValueOnce(retryable("socket_closed", 1_000))
      .mockResolvedValueOnce({ providerMessageId: "172.001" });
    const dispatcher = new OutboxDispatcher({
      store,
      workerId: "dispatcher-1",
      providers: { slack: { deliver: slack } }
    });

    await dispatcher.tick(now);

    expect(store.getOutbox("m1")).toMatchObject({
      state: "pending",
      attempts: 1,
      nextAttemptAt: nextAttempt,
      providerMessageId: null,
      lastError: {
        code: "socket_closed",
        retryable: true,
        retryAfterMs: 1_000
      }
    });
    expect(store.getTask("t1")).toMatchObject({ state: "completed" });

    await dispatcher.tick(nextAttempt);

    expect(store.getOutbox("m1")).toMatchObject({
      state: "delivered",
      attempts: 2,
      providerMessageId: "172.001",
      lastError: null
    });
    expect(store.getTask("t1")).toMatchObject({ state: "completed" });
  });

  it("links a successful delivery audit to the durable command without provider payload", async () => {
    // Break caught: a successful provider send can disappear from the command audit trail or persist outbound content.
    const dispatcher = new OutboxDispatcher({
      store,
      workerId: "dispatcher-1",
      providers: {
        slack: { deliver: deliveryPort().mockResolvedValue({ providerMessageId: "172.001" }) }
      }
    });

    await dispatcher.tick(now);

    expect(store.listAuditEvents()).toContainEqual(expect.objectContaining({
      subjectId: "command-1",
      eventType: "outbox.delivered",
      data: { messageId: "m1", channel: "slack" }
    }));
    expect(JSON.stringify(store.listAuditEvents())).not.toContain("Completed result");
    expect(JSON.stringify(store.listAuditEvents())).not.toContain("172.001");
  });

  it("audits a non-retryable rejection without exposing sensitive bodies or changing the task", async () => {
    // Break caught: persisting a raw provider error or touching Task state leaks content and falsifies work completion.
    const secretBody = "production bearer token secret-value";
    database.prepare(`
      UPDATE outbox_messages
      SET payload_json = ?
      WHERE id = 'm1'
    `).run(JSON.stringify({
      text: secretBody,
      threadId: "171.001",
      taskId: "t1",
      sensitive: true
    }));
    const slack = deliveryPort().mockRejectedValueOnce(Object.assign(
      new Error(`provider rejected body: ${secretBody}`),
      { code: "invalid_recipient", retryable: false as const }
    ));
    const dispatcher = new OutboxDispatcher({
      store,
      workerId: "dispatcher-1",
      providers: { slack: { deliver: slack } }
    });

    await dispatcher.tick(now);

    expect(store.getOutbox("m1")).toMatchObject({
      state: "failed",
      attempts: 1,
      providerMessageId: null,
      lastError: { code: "invalid_recipient", retryable: false }
    });
    expect(store.listAuditEvents()).toContainEqual(expect.objectContaining({
      subjectId: "m1",
      eventType: "outbox.delivery_failed",
      data: {
        channel: "slack",
        attempts: 1,
        failure: { code: "invalid_recipient", retryable: false }
      }
    }));
    expect(store.getTask("t1")).toMatchObject({ state: "completed" });
    expect(JSON.stringify({
      lastError: store.getOutbox("m1")?.lastError,
      audit: store.listAuditEvents()
    })).not.toContain(secretBody);
  });

  it("never promotes a token-shaped provider error message into persisted failure metadata", async () => {
    // Break caught: treating an alphanumeric Error.message as a normalized code persists token-shaped secrets.
    const tokenShapedMessage = "ProductionBearerToken123";
    const slack = deliveryPort().mockRejectedValueOnce(Object.assign(
      new Error(tokenShapedMessage),
      { retryable: false as const }
    ));
    const dispatcher = new OutboxDispatcher({
      store,
      workerId: "dispatcher-1",
      providers: { slack: { deliver: slack } }
    });

    await dispatcher.tick(now);

    expect(store.getOutbox("m1")).toMatchObject({
      state: "failed",
      lastError: { code: "provider_delivery_failed", retryable: false }
    });
    expect(store.listAuditEvents()).toContainEqual(expect.objectContaining({
      subjectId: "m1",
      eventType: "outbox.delivery_failed",
      data: {
        channel: "slack",
        attempts: 1,
        failure: { code: "provider_delivery_failed", retryable: false }
      }
    }));
    expect(JSON.stringify({
      lastError: store.getOutbox("m1")?.lastError,
      audit: store.listAuditEvents()
    })).not.toContain(tokenShapedMessage);
  });

  it("terminally fails local template validation with a redacted invalid_outbound_message audit", async () => {
    // Break caught: local template/schema errors are otherwise rescheduled forever as provider failures.
    database.prepare("DELETE FROM outbox_messages WHERE id = 'm1'").run();
    const secretBody = "raw private outbound body";
    store.enqueueOutbox({
      id: "telegram-invalid-template",
      commandId: "command-1",
      channel: "telegram",
      destination: "9900",
      template: "approval_channel_not_allowed",
      payload: { riskLevel: "L1", text: secretBody },
      nextAttemptAt: now
    });
    const send = vi.fn(async () => ({ messageId: 43 }));
    const dispatcher = new OutboxDispatcher({
      store,
      workerId: "dispatcher-1",
      providers: {
        telegram: {
          deliver: async (message) => deliverTelegramMessage(message, { send })
        }
      }
    });

    await dispatcher.tick(now);

    expect(send).not.toHaveBeenCalled();
    expect(store.getOutbox("telegram-invalid-template")).toMatchObject({
      state: "failed",
      attempts: 1,
      providerMessageId: null,
      lastError: { code: "invalid_outbound_message", retryable: false }
    });
    expect(store.listAuditEvents()).toContainEqual(expect.objectContaining({
      subjectId: "telegram-invalid-template",
      eventType: "outbox.delivery_failed",
      data: {
        channel: "telegram",
        attempts: 1,
        failure: { code: "invalid_outbound_message", retryable: false }
      }
    }));
    expect(JSON.stringify({
      lastError: store.getOutbox("telegram-invalid-template")?.lastError,
      audit: store.listAuditEvents()
    })).not.toContain(secretBody);
  });

  it("keeps an actual Telegram provider failure retryable", async () => {
    // Break caught: broadly converting every adapter exception into local validation would drop network recovery.
    database.prepare("DELETE FROM outbox_messages WHERE id = 'm1'").run();
    store.enqueueOutbox({
      id: "telegram-network-failure",
      commandId: "command-1",
      channel: "telegram",
      destination: "9900",
      template: "progress",
      payload: { text: "Working", replyToMessageId: 42 },
      nextAttemptAt: now
    });
    const send = vi.fn(async () => { throw new Error("network unavailable"); });
    const dispatcher = new OutboxDispatcher({
      store,
      workerId: "dispatcher-1",
      providers: {
        telegram: {
          deliver: async (message) => deliverTelegramMessage(message, { send })
        }
      }
    });

    await dispatcher.tick(now);

    expect(send).toHaveBeenCalledTimes(1);
    expect(store.getOutbox("telegram-network-failure")).toMatchObject({
      state: "pending",
      attempts: 1,
      lastError: { code: "provider_delivery_failed", retryable: true }
    });
  });

  it("fans a Telegram company-work final result out to Slack with only its redacted summary", async () => {
    // Break caught: enqueueing the mirror after Telegram delivery can lose the official Slack record on a crash.
    database.prepare("DELETE FROM outbox_messages WHERE id = 'm1'").run();
    database.prepare("UPDATE commands SET channel = 'telegram' WHERE id = 'command-1'").run();
    store.enqueueOutbox({
      id: "telegram-result",
      commandId: "command-1",
      channel: "telegram",
      destination: "9900",
      template: "final_summary",
      payload: {
        text: "Full private result with a sensitive implementation detail",
        replyToMessageId: 42,
        taskId: "t1",
        companyWork: true,
        redactedSummary: "Company task completed; verification passed.",
        sensitive: true
      },
      nextAttemptAt: now
    });
    const telegram = deliveryPort()
      .mockImplementationOnce(async () => {
        expect(store.getOutbox("telegram-result:slack-hq")).toMatchObject({
          channel: "slack",
          destination: "C-HQ",
          template: "final_summary",
          payload: { text: "Company task completed; verification passed." }
        });
        throw retryable("telegram_disconnected", 1_000);
      })
      .mockResolvedValueOnce({ providerMessageId: "43" });
    const slack = deliveryPort().mockResolvedValueOnce({ providerMessageId: "172.002" });
    const dispatcher = new OutboxDispatcher({
      store,
      workerId: "dispatcher-1",
      slackHqDestination: "C-HQ",
      providers: {
        slack: { deliver: slack },
        telegram: { deliver: telegram }
      }
    });

    await dispatcher.tick(now);
    expect(store.getOutbox("telegram-result")).toMatchObject({ state: "pending", attempts: 1 });
    expect(store.getOutbox("telegram-result:slack-hq")).toMatchObject({
      commandId: "command-1",
      state: "pending",
      attempts: 0,
      payload: { text: "Company task completed; verification passed." }
    });
    expect(JSON.stringify(store.getOutbox("telegram-result:slack-hq"))).not.toContain(
      "sensitive implementation detail"
    );

    await dispatcher.tick(now);
    expect(store.getOutbox("telegram-result:slack-hq")).toMatchObject({
      state: "delivered",
      attempts: 1,
      providerMessageId: "172.002"
    });

    await dispatcher.tick(nextAttempt);
    expect(store.getOutbox("telegram-result")).toMatchObject({
      state: "delivered",
      attempts: 2,
      providerMessageId: "43"
    });
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM outbox_messages
      WHERE id = 'telegram-result:slack-hq'
    `).get()).toEqual({ count: 1 });
    expect(store.getTask("t1")).toMatchObject({ state: "completed" });
  });

  it("delivers the Telegram origin when Slack HQ mirror configuration is missing", async () => {
    // Break caught: treating mirror configuration as an origin validation error terminally fails Telegram delivery.
    database.prepare("DELETE FROM outbox_messages WHERE id = 'm1'").run();
    store.enqueueOutbox({
      id: "telegram-missing-mirror-config",
      commandId: "command-1",
      channel: "telegram",
      destination: "9900",
      template: "final_summary",
      payload: {
        text: "Private Telegram result",
        companyWork: true,
        redactedSummary: "Safe company summary"
      },
      nextAttemptAt: now
    });
    const telegram = deliveryPort().mockResolvedValue({ providerMessageId: "43" });
    const dispatcher = new OutboxDispatcher({
      store,
      workerId: "dispatcher-1",
      providers: { telegram: { deliver: telegram } }
    });

    await dispatcher.tick(now);

    expect(telegram).toHaveBeenCalledTimes(1);
    expect(store.getOutbox("telegram-missing-mirror-config")).toMatchObject({
      state: "delivered",
      providerMessageId: "43",
      lastError: null
    });
    expect(store.getOutbox("telegram-missing-mirror-config:slack-hq")).toBeUndefined();
    expect(store.listAuditEvents()).toContainEqual(expect.objectContaining({
      subjectId: "telegram-missing-mirror-config:slack-hq",
      eventType: "outbox.mirror_failed",
      data: {
        originMessageId: "telegram-missing-mirror-config",
        channel: "slack",
        failure: { code: "slack_hq_not_configured", retryable: false }
      }
    }));
  });

  it("delivers Telegram and assigns a mirror enqueue failure only to the mirror", async () => {
    // Break caught: a local Slack mirror insert failure currently enters the Telegram origin retry path.
    database.prepare("DELETE FROM outbox_messages WHERE id = 'm1'").run();
    store.enqueueOutbox({
      id: "telegram-mirror-enqueue-failure",
      commandId: "command-1",
      channel: "telegram",
      destination: "9900",
      template: "final_summary",
      payload: {
        text: "Private Telegram result",
        companyWork: true,
        redactedSummary: "Safe company summary"
      },
      nextAttemptAt: now
    });
    database.exec(`
      CREATE TRIGGER force_mirror_enqueue_failure
      BEFORE INSERT ON outbox_messages
      WHEN NEW.id = 'telegram-mirror-enqueue-failure:slack-hq'
      BEGIN
        SELECT RAISE(ABORT, 'forced mirror enqueue failure');
      END
    `);
    const telegram = deliveryPort().mockResolvedValue({ providerMessageId: "43" });
    const dispatcher = new OutboxDispatcher({
      store,
      workerId: "dispatcher-1",
      slackHqDestination: "C-HQ",
      providers: { telegram: { deliver: telegram } }
    });

    await dispatcher.tick(now);

    expect(telegram).toHaveBeenCalledTimes(1);
    expect(store.getOutbox("telegram-mirror-enqueue-failure")).toMatchObject({
      state: "delivered",
      providerMessageId: "43",
      lastError: null
    });
    expect(store.getOutbox("telegram-mirror-enqueue-failure:slack-hq")).toBeUndefined();
    expect(store.listAuditEvents()).toContainEqual(expect.objectContaining({
      subjectId: "telegram-mirror-enqueue-failure:slack-hq",
      eventType: "outbox.mirror_failed",
      data: {
        originMessageId: "telegram-mirror-enqueue-failure",
        channel: "slack",
        failure: { code: "mirror_enqueue_failed", retryable: false }
      }
    }));
  });

  it("delivers Telegram when only its Slack mirror payload is invalid", async () => {
    // Break caught: mirror-only redacted-summary validation must not classify the valid Telegram origin as failed.
    database.prepare("DELETE FROM outbox_messages WHERE id = 'm1'").run();
    store.enqueueOutbox({
      id: "telegram-invalid-mirror",
      commandId: "command-1",
      channel: "telegram",
      destination: "9900",
      template: "final_summary",
      payload: {
        text: "Valid Telegram result",
        companyWork: true
      },
      nextAttemptAt: now
    });
    const telegram = deliveryPort().mockResolvedValue({ providerMessageId: "43" });
    const dispatcher = new OutboxDispatcher({
      store,
      workerId: "dispatcher-1",
      slackHqDestination: "C-HQ",
      providers: { telegram: { deliver: telegram } }
    });

    await dispatcher.tick(now);

    expect(telegram).toHaveBeenCalledTimes(1);
    expect(store.getOutbox("telegram-invalid-mirror")).toMatchObject({
      state: "delivered",
      providerMessageId: "43",
      lastError: null
    });
    expect(store.listAuditEvents()).toContainEqual(expect.objectContaining({
      subjectId: "telegram-invalid-mirror:slack-hq",
      eventType: "outbox.mirror_failed",
      data: {
        originMessageId: "telegram-invalid-mirror",
        channel: "slack",
        failure: { code: "invalid_company_final_summary", retryable: false }
      }
    }));
  });

  it.each([
    ["non-final company message", "progress", {
      text: "Still working",
      companyWork: true,
      redactedSummary: "Do not mirror progress"
    }],
    ["non-company final message", "final_summary", {
      text: "Personal task completed",
      companyWork: false,
      redactedSummary: "Do not mirror personal work"
    }]
  ] as const)("does not mirror a %s", async (_case, template, payload) => {
    // Break caught: mirroring based on only one classifier publishes personal or intermediate content to Slack HQ.
    database.prepare("DELETE FROM outbox_messages WHERE id = 'm1'").run();
    store.enqueueOutbox({
      id: "telegram-no-mirror",
      channel: "telegram",
      destination: "9900",
      template,
      payload,
      nextAttemptAt: now
    });
    const dispatcher = new OutboxDispatcher({
      store,
      workerId: "dispatcher-1",
      slackHqDestination: "C-HQ",
      providers: {
        telegram: { deliver: deliveryPort().mockResolvedValue({ providerMessageId: "44" }) }
      }
    });

    await dispatcher.tick(now);

    expect(store.getOutbox("telegram-no-mirror")).toMatchObject({ state: "delivered" });
    expect(store.getOutbox("telegram-no-mirror:slack-hq")).toBeUndefined();
  });

  it("atomically rolls back a terminal state when its visible audit cannot be written", async () => {
    // Break caught: committing failed state without its audit hides a terminal delivery rejection from operators.
    database.exec(`
      CREATE TRIGGER force_delivery_audit_failure
      BEFORE INSERT ON audit_events
      WHEN NEW.event_type = 'outbox.delivery_failed'
      BEGIN
        SELECT RAISE(ABORT, 'forced delivery audit failure');
      END
    `);
    const dispatcher = new OutboxDispatcher({
      store,
      workerId: "dispatcher-1",
      providers: {
        slack: {
          deliver: deliveryPort().mockRejectedValue(Object.assign(
            new Error("provider rejection"),
            { code: "invalid_recipient", retryable: false as const }
          ))
        }
      }
    });

    await expect(dispatcher.tick(now)).rejects.toThrow("forced delivery audit failure");

    expect(store.getOutbox("m1")).toMatchObject({ state: "claimed", attempts: 1 });
    expect(store.listAuditEvents()).toEqual([]);
    expect(store.getTask("t1")).toMatchObject({ state: "completed" });
  });
});

function deliveryPort(): ReturnType<typeof vi.fn<OutboundDeliveryPort["deliver"]>> {
  return vi.fn<OutboundDeliveryPort["deliver"]>();
}

function retryable(code: string, retryAfterMs: number): Error {
  return Object.assign(new Error("provider delivery failed"), {
    code,
    retryable: true as const,
    retryAfterMs
  });
}

function insertCompletedTask(database: Database.Database): void {
  const createdAt = now;
  database.prepare(`
    INSERT INTO principals (id, payload_json, created_at, updated_at)
    VALUES ('owner', '{}', ?, ?)
  `).run(createdAt, createdAt);
  database.prepare(`
    INSERT INTO commands (
      id, idempotency_key, channel, external_message_id, principal_id,
      received_at, payload_json, created_at
    ) VALUES (?, ?, 'slack', '171.001', 'owner', ?, ?, ?)
  `).run(
    "command-1",
    `test:${randomUUID()}`,
    createdAt,
    JSON.stringify({ fixture: true }),
    createdAt
  );
  database.prepare(`
    INSERT INTO runs (id, command_id, state, payload_json, created_at, updated_at)
    VALUES ('run-1', 'command-1', 'completed', '{}', ?, ?)
  `).run(createdAt, createdAt);
  database.prepare(`
    INSERT INTO tasks (id, run_id, state, payload_json, created_at, updated_at)
    VALUES ('t1', 'run-1', 'completed', '{}', ?, ?)
  `).run(createdAt, createdAt);
}
