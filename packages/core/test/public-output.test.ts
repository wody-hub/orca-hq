import { describe, expect, it } from "vitest";

import { redactPublicText, sanitizeDisplayText, sanitizeResultText } from "../src/public-output.js";

describe("public output sanitizers", () => {
  it("removes terminal controls and bounds a display line", () => {
    // Break caught: untrusted output could clear or relabel the operator terminal.
    expect(sanitizeDisplayText(" hello\u001b[2J\nworld ")).toBe("hello world");
    expect(sanitizeDisplayText("x".repeat(401))).toHaveLength(400);
  });

  it("redacts credentials while preserving safe public text", () => {
    // Break caught: an adapter error could disclose a bearer token or private key in the console.
    expect(redactPublicText("Bearer abc.def_123\nAKIA1234567890ABCDEF\n-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----")).toBe("Bearer [REDACTED] [REDACTED] [REDACTED]");
    expect(sanitizeResultText("one\r\ntwo")).toBe("one\ntwo");
  });

  it("redacts private keys before applying the public result bound", () => {
    // Break caught: truncating away the END marker must not expose the beginning of a private key.
    const oversized = `before\n-----BEGIN PRIVATE KEY-----\n${"secret".repeat(12_000)}\n-----END PRIVATE KEY-----\nafter`;
    expect(redactPublicText(oversized)).toBe("before [REDACTED] after");
    expect(redactPublicText("before\n-----BEGIN PRIVATE KEY-----\nunterminated secret"))
      .toBe("before [REDACTED]");
  });
});
