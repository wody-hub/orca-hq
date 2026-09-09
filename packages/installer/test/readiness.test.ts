import { describe, expect, it } from "vitest";

import { createHttpReadinessProbe } from "../src/readiness.js";

describe("gateway readiness", () => {
  it("allows persisted native recovery to finish after twenty seconds with the default startup budget", async () => {
    let elapsed = 0;
    const readiness = createHttpReadinessProbe({
      now: () => elapsed,
      sleep: async milliseconds => { elapsed += milliseconds; },
      request: async () => ({
        ok: true,
        json: async () => ({
          service: "orca-hq", mode: "managed", pid: 428,
          state: elapsed >= 20_000 ? "running" : "starting"
        })
      })
    });
    await expect(readiness.waitForRunning(428)).resolves.toEqual({ ready: true });
  });

  it("accepts the exact local text health contract for the launchd pid", async () => {
    // Break caught: a generic HTTP 200 or stale gateway process can be reported as ready.
    const urls: string[] = [];
    const readiness = createHttpReadinessProbe({
      request: async (url) => {
        urls.push(url);
        return ({
        ok: true,
        json: async () => ({
          service: "orca-hq",
          mode: "text-only",
          state: "running",
          pid: 428,
          channels: { slack: true, telegram: true }
        })
        });
      },
      now: () => 0,
      sleep: async () => undefined
    });

    await expect(readiness.waitForRunning(428)).resolves.toEqual({ ready: true });
    expect(urls).toEqual(["http://127.0.0.1:4310/health"]);
  });

  it("accepts managed mode with the exact running pid while a channel reconnects", async () => {
    // Break caught: channel-level degradation could make launchd kill and restart an otherwise ready managed gateway.
    let now = 0;
    const readiness = createHttpReadinessProbe({
      timeoutMs: 10,
      pollIntervalMs: 10,
      request: async () => ({
        ok: true,
        json: async () => ({
          service: "orca-hq",
          mode: "managed",
          state: "running",
          pid: 428,
          channels: { slack: false, telegram: true }
        })
      }),
      now: () => now,
      sleep: async milliseconds => { now += milliseconds; }
    });

    await expect(readiness.waitForRunning(428)).resolves.toEqual({ ready: true });
  });

  it("still requires both channels for legacy text-only readiness", async () => {
    // Break caught: broadening managed readiness could accidentally weaken the legacy text-only health contract.
    let now = 0;
    const readiness = createHttpReadinessProbe({
      timeoutMs: 10,
      pollIntervalMs: 10,
      request: async () => ({
        ok: true,
        json: async () => ({
          service: "orca-hq",
          mode: "text-only",
          state: "running",
          pid: 428,
          channels: { slack: false, telegram: true }
        })
      }),
      now: () => now,
      sleep: async milliseconds => { now += milliseconds; }
    });

    await expect(readiness.waitForRunning(428)).resolves.toEqual({ ready: false });
  });

  it("returns unavailable after a bounded deadline when health never matches", async () => {
    // Break caught: `hq start` can hang forever or accept a response with a different pid/channel state.
    let now = 0;
    let attempts = 0;
    const readiness = createHttpReadinessProbe({
      timeoutMs: 15_000,
      pollIntervalMs: 5_000,
      request: async () => {
        attempts += 1;
        return { ok: true, json: async () => ({ service: "orca-hq", pid: 999 }) };
      },
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; }
    });

    await expect(readiness.waitForRunning(428)).resolves.toEqual({ ready: false });
    expect(attempts).toBe(3);
  });
});
