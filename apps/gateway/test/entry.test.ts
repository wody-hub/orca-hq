import { describe, expect, it } from "vitest";

import { run } from "../src/entry.js";

describe("gateway production entry", () => {
  it("fails closed with a redacted configuration error when no external secret host is configured", async () => {
    // Break caught: the package start path exposes or depends on a missing in-repository host module.
    const previous = process.env.GATEWAY_HOST_BOOTSTRAP;
    delete process.env.GATEWAY_HOST_BOOTSTRAP;
    try {
      await expect(run()).rejects.toThrow("Gateway configuration or secret provider is unavailable");
    } finally {
      if (previous === undefined) delete process.env.GATEWAY_HOST_BOOTSTRAP;
      else process.env.GATEWAY_HOST_BOOTSTRAP = previous;
    }
  });
});
