import { openDatabase } from '@orca-hq/persistence';
import { describe, expect, it } from 'vitest';
import { LocalTextStore } from '../src/local-store.js';

const message = { id: 'telegram:bot:1:2', channel: 'telegram' as const, destination: '1', userId: '1', text: 'subway-seet 상태', receivedAt: '2026-09-07T00:00:00.000Z' };

describe('durable local text inbox', () => {
  it('deduplicates accepted events and preserves a response across delivery retry', () => {
    const db = openDatabase(':memory:');
    try {
      const store = new LocalTextStore(db);
      expect(store.accept(message)).toBe(true);
      expect(store.accept({ ...message, text: 'duplicate changed payload' })).toBe(false);
      const work = store.claim(0)!;
      expect(work.message.text).toBe(message.text);
      store.saveResponse(work.message.id, '조회 결과');
      store.retry(work.message.id, 100);
      expect(store.claim(99)).toBeUndefined();
      const retry = store.claim(100)!;
      expect(retry.response).toBe('조회 결과');
      expect(retry.attempts).toBe(1);
      store.delivered(retry.message.id);
      expect(store.claim(1000)).toBeUndefined();
      expect(store.summary()).toMatchObject({ delivered: 1, queued: 0 });
    } finally { db.close(); }
  });
  it('recovers interrupted requests and keeps provider cursors durable', () => {
    const db = openDatabase(':memory:');
    try {
      const store = new LocalTextStore(db);
      store.accept(message); store.claim(0); store.saveResponse(message.id, '복구 응답');
      store.saveCursor('telegram', 12);
      const recovered = new LocalTextStore(db);
      recovered.recover();
      expect(recovered.loadCursor('telegram')).toBe(12);
      expect(recovered.claim(0)?.response).toBe('복구 응답');
    } finally { db.close(); }
  });
  it('rejects oversized/invalid events and never queues them', () => {
    const db = openDatabase(':memory:');
    try {
      const store = new LocalTextStore(db);
      expect(() => store.accept({ ...message, text: 'x'.repeat(8001) })).toThrow();
      expect(store.summary().queued).toBe(0);
    } finally { db.close(); }
  });
});
