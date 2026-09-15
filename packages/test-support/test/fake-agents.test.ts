import { expect, it } from "vitest";
import { LaunchOrca } from "../src/fake-agents.js";

it.each([
  { kind: "operations_status" } as const,
  { kind: "operations_show_worker", dispatchId: "dispatch" } as const,
])("explicitly rejects unsupported $kind without breaking legacy operations", async (operation) => {
  const orca = new LaunchOrca();
  await expect(orca.execute(operation)).rejects.toThrow(`unsupported scripted Orca operation: ${operation.kind}`);
  expect(await orca.execute({ kind: "list_projects" })).toEqual({ id: "receipt-projects", ok: true, result: { repos: [] } });
});
