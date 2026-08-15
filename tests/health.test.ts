import { afterEach, describe, expect, test, vi } from 'vitest';
import { migrate, openDatabase } from '../src/server/db.js';
import { checkSource } from '../src/server/health/check.js';
import { getHealthSettings, recordCheckResult } from '../src/server/health/repository.js';
import { resetHealthBatchStateForTests, runHealthBatch, startScheduler } from '../src/server/health/scheduler.js';
import { createSource, getSourceById } from '../src/server/sources/repository.js';

const databases: ReturnType<typeof openDatabase>[] = [];
const resolve = async () => [{ address: '93.184.216.34', family: 4 }];
function database() { const db = openDatabase(':memory:'); migrate(db); databases.push(db); return db; }
afterEach(() => { for (const db of databases.splice(0)) db.close(); resetHealthBatchStateForTests(); vi.useRealTimers(); });

describe('source health checking', () => {
  test('merges ac=list and accepts basic JSON and XML structures', async () => {
    const db = database();
    const source = createSource(db, { sourceKey: 'one', name: 'One', api: 'https://example.com/api?token=x&ac=detail' });
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo) => new Response('{"list":[]}', { headers: { 'content-type': 'application/json' } }));
    expect((await checkSource(source, getHealthSettings(db), { fetchImpl, resolve })).status).toBe('healthy');
    expect(fetchImpl.mock.calls[0][0].toString()).toBe('https://example.com/api?token=x&ac=list');
    expect(await checkSource(source, getHealthSettings(db), {
      fetchImpl: async () => new Response('<?xml version="1.0"?><rss><list/></rss>'), resolve,
    })).toMatchObject({ status: 'healthy', attempts: 1 });
    expect((await checkSource(source, getHealthSettings(db), {
      fetchImpl: async () => new Response('<rss><garbage/></rss>'), resolve,
    })).status).toBe('unhealthy');
  });

  test('rejects empty or malformed bodies and retries no more than twice', async () => {
    const db = database(); const source = createSource(db, { sourceKey: 'one', name: 'One', api: 'https://example.com/api' });
    const fetchImpl = vi.fn(async () => new Response('not an API response'));
    expect(await checkSource(source, getHealthSettings(db), { fetchImpl, resolve })).toMatchObject({ status: 'unhealthy', errorCode: 'invalid_response', attempts: 3 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect((await checkSource(source, getHealthSettings(db), { fetchImpl: async () => new Response(''), resolve })).status).toBe('unhealthy');
    expect(await checkSource(source, getHealthSettings(db), {
      fetchImpl: async () => new Response('{"error":"rate limited"}', { status: 429 }), resolve, maxRetries: 0,
    })).toMatchObject({ status: 'unhealthy', errorCode: 'upstream_http', errorMessage: 'HTTP 429: {"error":"rate limited"}' });
  });

  test('times out each attempt and reports a compact timeout error', async () => {
    const db = database(); const source = createSource(db, { sourceKey: 'one', name: 'One', api: 'https://example.com/api' });
    db.prepare("UPDATE settings SET setting_value = '2' WHERE setting_key = 'request_timeout_ms'").run();
    const fetchImpl = vi.fn((_url: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_ok, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))));
    expect(await checkSource(source, getHealthSettings(db), { fetchImpl, resolve })).toMatchObject({ status: 'unhealthy', errorCode: 'timeout', attempts: 3 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  test('persists failure threshold, recovery, and at most 30 history rows', () => {
    const db = database(); const source = createSource(db, { sourceKey: 'one', name: 'One', api: 'https://example.com/api' });
    const failure = (index: number) => ({ status: 'unhealthy' as const, latencyMs: 4, checkedAt: new Date(1_700_000_000_000 + index).toISOString(), errorCode: 'request_failed', errorMessage: 'nope', attempts: 3 });
    recordCheckResult(db, source.id, failure(0));
    expect(getSourceById(db, source.id)).toMatchObject({ healthStatus: 'unhealthy', consecutiveFailures: 1 });
    recordCheckResult(db, source.id, failure(1));
    expect(getSourceById(db, source.id)).toMatchObject({ healthStatus: 'unhealthy', consecutiveFailures: 2 });
    for (let i = 2; i < 35; i += 1) recordCheckResult(db, source.id, failure(i));
    expect((db.prepare('SELECT count(*) count FROM health_checks WHERE source_id = ?').get(source.id) as { count: number }).count).toBe(30);
    recordCheckResult(db, source.id, { status: 'healthy', latencyMs: 2, checkedAt: new Date().toISOString(), errorCode: null, errorMessage: null, attempts: 1 });
    expect(getSourceById(db, source.id)).toMatchObject({ healthStatus: 'healthy', consecutiveFailures: 0, lastError: null });
  });

  test('uses bounded concurrency, skips ignored sources, and prevents overlapping batches', async () => {
    const db = database();
    for (let i = 0; i < 6; i += 1) createSource(db, { sourceKey: `s${i}`, name: `S${i}`, api: `https://example.com/${i}`, ignoreHealthCheck: i === 5 });
    let active = 0; let peak = 0; let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    const fetchImpl = vi.fn(async () => { active += 1; peak = Math.max(peak, active); await gate; active -= 1; return new Response('{"list":[]}'); });
    const first = runHealthBatch(db, { fetchImpl, resolve, concurrency: 2 });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    expect(await runHealthBatch(db, { fetchImpl, resolve })).toMatchObject({ skipped: true, checked: 0 });
    release();
    expect(await first).toMatchObject({ checked: 5, healthy: 5, skipped: false });
    expect(peak).toBe(2);
    expect(getSourceById(db, 6)?.healthStatus).toBe('unknown');
  });

  test('persists next run, reschedules settings changes, and manual checks reuse batch logic', async () => {
    const db = database(); createSource(db, { sourceKey: 'one', name: 'One', api: 'https://example.com/api' });
    const callbacks: Array<() => void> = []; const delays: number[] = [];
    const now = new Date('2026-08-15T00:00:00.000Z');
    const scheduler = startScheduler(db, {
      now: () => now, fetchImpl: async () => new Response('{"list":[]}'), resolve,
      setTimer: (callback, delay) => { callbacks.push(callback); delays.push(delay); return 1 as unknown as ReturnType<typeof setTimeout>; },
      clearTimer: () => undefined,
    });
    expect(getHealthSettings(db).nextCheckAt).toBe('2026-08-16T00:00:00.000Z');
    expect(delays.at(-1)).toBe(86_400_000);
    db.prepare("UPDATE settings SET setting_value = '2' WHERE setting_key = 'check_interval_hours'").run();
    scheduler.reschedule();
    expect(getHealthSettings(db).nextCheckAt).toBe('2026-08-15T02:00:00.000Z');
    expect(await scheduler.checkSources([1])).toMatchObject({ checked: 1, healthy: 1 });
    expect(await scheduler.runNow()).toMatchObject({ checked: 1 });
    expect(getHealthSettings(db).nextCheckAt).toBe('2026-08-15T02:00:00.000Z');
    scheduler.stop();
  });
});
