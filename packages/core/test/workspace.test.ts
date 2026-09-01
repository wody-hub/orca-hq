import { describe, expect, it } from "vitest";
import { ORCA_HQ_PROTOCOL_VERSION } from "../src/index.js";

describe("workspace", () => {
  it("exports one explicit protocol version", () => {
    expect(ORCA_HQ_PROTOCOL_VERSION).toBe(1);
  });
});
