import { it, expect } from "vitest";
import {
  nativeContextState,
  nativeProgress,
  publicProgressText,
  toolProgress,
} from "../src/progress-events.js";
const job = {
  id: "j",
  projectId: "p",
  projectName: "Project",
  prompt: "private input",
  state: "running",
  createdAt: "now",
  updatedAt: "later",
};
it("keeps native work running beyond HQ response and deduplicates polling identity", () => {
  expect(
    nativeContextState([job, { ...job, id: "j2", state: "succeeded" }]),
  ).toBe("worker_running");
  expect(nativeContextState([{ ...job, state: "recovery_required" }])).toBe(
    "recovery_required",
  );
  expect(nativeProgress(job).eventKey).toBe(
    nativeProgress({ ...job }).eventKey,
  );
  expect(nativeProgress(job).payload).not.toHaveProperty("prompt");
});
it("only exposes allowlisted tool metadata and redacts credentials/control sequences", () => {
  expect(toolProgress("orca_execute", "completed", "call")).toEqual({
    kind: "tool.completed",
    source: "tool",
    payload: {
      tool: "orca_execute",
      callId: "call",
      text: "orca_execute · completed",
    },
  });
  expect(
    publicProgressText("token=abc Bearer abcdefghijkl\u001b"),
  ).not.toContain("abcdefghijkl");
  expect(publicProgressText("token=abc")).not.toContain("abc");
});
