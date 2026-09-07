import { getDefaultAutoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInstalledGateway } from '../src/entry.js';
afterEach(() => vi.unstubAllEnvs());
describe('installed gateway entry routing', () => {
  it('allows a slow IPv4 connection before attempting unavailable IPv6 during local startup', async () => {
    // Break caught: Node's 250ms fallback aborts reachable Telegram IPv4 connections on this Mac.
    vi.stubEnv('GATEWAY_EXTERNAL_ADAPTERS', undefined);
    const previous = getDefaultAutoSelectFamilyAttemptTimeout();
    setDefaultAutoSelectFamilyAttemptTimeout(250);
    try {
      await runInstalledGateway({ local: async () => {
        expect(getDefaultAutoSelectFamilyAttemptTimeout()).toBeGreaterThanOrEqual(2000);
        return { stop: async () => undefined };
      } });
    } finally { setDefaultAutoSelectFamilyAttemptTimeout(previous); }
  });
  it('selects the built-in text runtime without requiring an external module', async () => {
    vi.stubEnv('GATEWAY_EXTERNAL_ADAPTERS', undefined);
    const stop = vi.fn(async () => undefined);
    const local = vi.fn(async () => ({ stop }));
    const external = vi.fn(async () => ({ stop }));
    const runtime = await runInstalledGateway({ local, external });
    await runtime.stop();
    expect(local).toHaveBeenCalledTimes(1);
    expect(external).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
  });
  it('preserves explicit external adapters and does not silently fall back on failure', async () => {
    vi.stubEnv('GATEWAY_EXTERNAL_ADAPTERS', 'file:///missing.js');
    const local = vi.fn();
    const external = vi.fn(async () => { throw new Error('unavailable'); });
    await expect(runInstalledGateway({ local, external })).rejects.toThrow('unavailable');
    expect(local).not.toHaveBeenCalled();
  });
});
