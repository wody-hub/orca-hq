import { ControlStore, openDatabase } from "@orca-hq/persistence";
import { describe, expect, it } from "vitest";

import { createCommandDashboard } from "../src/dashboard.js";

describe("production command dashboard", () => {
  it("derives pending evidence and disabled task controls from durable store state", async () => {
    // Break caught: an empty or non-runnable durable state is presented as successful or actionable.
    const database = openDatabase(":memory:");
    const store = new ControlStore(database);
    try {
      store.insertCommand({
        commandId: "command-501", idempotencyKey: "telegram-501", channel: "telegram",
        externalMessageId: "20:501", principalId: "owner", receivedAt: "2026-09-03T00:00:00.000Z",
        text: "샌드박스 테스트 수정"
      });
      store.saveRun({ id: "run-501", proposalId: "proposal-501", commandId: "command-501", state: "awaiting_verification" });
      store.saveTask({
        id: "task-501", runId: "run-501", title: "검증", role: "verify", preferredAgent: "claude", state: "worker_done"
      });
      store.saveDispatch({ id: "dispatch-501", taskId: "task-501", state: "worker_done" });
      store.appendAudit({ subjectId: "command-501", eventType: "command.accepted", data: {} });
      const dashboard = createCommandDashboard(store);

      await expect(dashboard.listCommands({ principalId: "owner", roles: ["owner"] })).resolves.toEqual({ commands: [{
        id: "command-501", summary: "샌드박스 테스트 수정", status: "awaiting_verification",
        projectKey: "unrouted", riskLevel: "L0", updatedAt: "2026-09-03T00:00:00.000Z"
      }] });
      await expect(dashboard.getCommand({ commandId: "command-501", principal: { principalId: "owner", roles: ["owner"] } }))
        .resolves.toMatchObject({
          verification: { status: "pending", commands: [] },
          tasks: [{ id: "task-501", dispatchId: "dispatch-501", canStop: false, canRetry: false }],
          approval: { status: "pending", permitted: false },
          audit: { reference: expect.any(String) }, delivery: []
        });
    } finally {
      database.close();
    }
  });
});
