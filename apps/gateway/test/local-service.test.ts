import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { startLocalTextService, type LocalChannelFactory } from '../src/local-service.js';

const message = { id: 'telegram:bot:1:3', channel: 'telegram' as const, destination: '1', userId: '1', text: 'sample 상태 요약', receivedAt: '2026-09-07T00:00:00.000Z' };
const projects = Array.from({ length: 5 }, (_, i) => ({ projectKey: `sample${i}`, absolutePath: '/unused', allowedOperations: ['L0'] }));

describe('actual local text service composition', () => {
  it('persists inbound, invokes the summary boundary, delivers once, and exposes redacted readiness', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-local-service-'));
    let receive: ((value: typeof message) => Promise<void>) | undefined;
    const delivered: string[] = [];
    const factory: LocalChannelFactory = (ports) => {
      receive = ports.onMessage;
      return { start: async () => undefined, stop: async () => undefined, status: () => ({ slack: true, telegram: true }), send: async (_message, text) => { delivered.push(text); } };
    };
    const summary = vi.fn(async (_input: { question: string; facts: unknown; workingDirectory: string }) => '프로젝트 조회 결과입니다.');
    const service = await startLocalTextService({ databasePath: join(dir, 'db.sqlite'), projects, channelFactory: factory, summarize: summary, facts: async () => [{ projectKey: 'sample0', available: true }], port: 0 });
    try {
      await receive!(message); await receive!(message);
      await vi.waitFor(() => expect(delivered).toEqual(['프로젝트 조회 결과입니다.']));
      expect(summary).toHaveBeenCalledTimes(1);
      expect(summary.mock.calls[0]?.[0]).toMatchObject({ question: message.text, facts: [{ projectKey: 'sample0', available: true }] });
      const response = await fetch(`http://127.0.0.1:${service.port}/health`);
      expect(response.status).toBe(200);
      const health = await response.json();
      expect(health).toMatchObject({ service: 'orca-hq', mode: 'text-only', state: 'running', channels: { slack: true, telegram: true }, queue: { delivered: 1 } });
      expect(JSON.stringify(health)).not.toContain(message.text);
      expect(JSON.stringify(health)).not.toContain(dir);
    } finally { await service.stop(); await rm(dir, { recursive: true, force: true }); }
  });
  it('refuses non-L0 registries before opening channel connections', async () => {
    const factory = vi.fn();
    await expect(startLocalTextService({ databasePath: '/unused', projects: projects.map(p => ({ ...p, allowedOperations: ['L1'] })), channelFactory: factory, summarize: async () => 'unused' })).rejects.toThrow('local_text_requires_five_L0_projects');
    expect(factory).not.toHaveBeenCalled();
  });
});
