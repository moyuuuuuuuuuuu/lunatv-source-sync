import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type Database from 'better-sqlite3';
import { migrate, openDatabase } from '../src/server/db.js';
import { classifyAdult } from '../src/server/sources/classify.js';
import { applyImport, previewImport } from '../src/server/sources/import.js';
import {
  bulkSetEnabled,
  createSource,
  deleteSources,
  getSourceByKey,
  listSources,
  updateSource,
} from '../src/server/sources/repository.js';

describe('source import and repository', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
    migrate(db);
  });

  afterEach(() => db.close());

  test('validates entries and classifies automatic and explicit adult values', () => {
    expect(classifyAdult({ name: '普通', api: 'https://example.com' })).toBe(false);
    expect(classifyAdult({ name: 'Java Video', api: 'https://example.com' })).toBe(false);
    expect(classifyAdult({ name: '🔞 成人专区', api: 'https://example.com' })).toBe(true);
    expect(classifyAdult({ name: '成人视频', api: 'https://example.com' })).toBe(true);
    expect(classifyAdult({ name: 'Custom Zone', api: 'https://example.com' }, ['custom'])).toBe(true);

    const preview = previewImport({
      cache_time: 60,
      api_site: {
        normal: { name: '🔞 Explicit Normal', api: 'https://normal.example/api', adult: false },
        auto_adult: { name: '18+ Movies', api: 'https://adult.example/api' },
        forced_adult: { name: 'Safe Name', api: 'https://safe.example/api', adult: true },
        invalid: { name: '', api: 'https://invalid.example/api' },
      },
    });

    expect(preview.entries).toHaveLength(3);
    expect(preview.errors).toEqual([
      expect.objectContaining({ sourceKey: 'invalid', code: 'INVALID_NAME' }),
    ]);
    expect(preview.entries.map(({ sourceKey, classificationMode, isAdult }) => ({
      sourceKey,
      classificationMode,
      isAdult,
    }))).toEqual([
      { sourceKey: 'normal', classificationMode: 'normal', isAdult: false },
      { sourceKey: 'auto_adult', classificationMode: 'auto', isAdult: true },
      { sourceKey: 'forced_adult', classificationMode: 'adult', isAdult: true },
    ]);
  });

  test('rejects malformed payloads without writing', () => {
    expect(() => previewImport(null)).toThrow(/api_site/i);
    expect(() => previewImport({ api_site: [] })).toThrow(/api_site/i);
    expect(listSources(db).total).toBe(0);
  });

  test('overwrites business fields while retaining health state and history', () => {
    const original = createSource(db, {
      sourceKey: 'same',
      name: 'Old',
      api: 'https://old.example/api',
      classificationMode: 'normal',
    });
    db.prepare(`UPDATE sources SET health_status = 'unhealthy', consecutive_failures = 2,
      last_checked_at = '2026-08-15T00:00:00Z', last_error = 'timeout' WHERE id = ?`).run(original.id);
    db.prepare(`INSERT INTO health_checks (source_id, status, error_code)
      VALUES (?, 'unhealthy', 'TIMEOUT')`).run(original.id);

    const result = applyImport(db, previewImport({
      api_site: {
        same: { name: 'New', api: 'https://new.example/api', detail: 'https://new.example' },
        added: { name: 'Added', api: 'https://added.example/api' },
      },
    }));

    expect(result).toEqual({ inserted: 1, updated: 1 });
    expect(getSourceByKey(db, 'same')).toMatchObject({
      id: original.id,
      name: 'New',
      api: 'https://new.example/api',
      healthStatus: 'unhealthy',
      consecutiveFailures: 2,
      lastError: 'timeout',
    });
    expect(db.prepare('SELECT count(*) AS count FROM health_checks WHERE source_id = ?')
      .get(original.id)).toEqual({ count: 1 });
  });

  test('supports filtering, updates, bulk enable changes, and transactional deletes', () => {
    const first = createSource(db, {
      sourceKey: 'first', name: 'First Cinema', api: 'https://one.example/api',
      classificationMode: 'normal',
    });
    const second = createSource(db, {
      sourceKey: 'second', name: 'Second', api: 'https://two.example/api',
      classificationMode: 'adult', enabled: false,
    });
    db.prepare('UPDATE sources SET latency_ms = ? WHERE id = ?').run(900, first.id);
    db.prepare('UPDATE sources SET latency_ms = ? WHERE id = ?').run(120, second.id);

    expect(listSources(db, { search: 'cinema', classification: 'normal' }).items)
      .toHaveLength(1);
    expect(listSources(db, { sort: 'latencyAsc' }).items.map((source) => source.id)).toEqual([second.id, first.id]);
    expect(listSources(db, { sort: 'latencyDesc' }).items.map((source) => source.id)).toEqual([first.id, second.id]);
    expect(updateSource(db, first.id, { name: 'Renamed', ignoreHealthCheck: true }))
      .toMatchObject({ name: 'Renamed', ignoreHealthCheck: true });
    expect(bulkSetEnabled(db, [first.id, second.id], true)).toBe(2);
    expect(deleteSources(db, [first.id, second.id])).toBe(2);
    expect(listSources(db).total).toBe(0);
  });
});
