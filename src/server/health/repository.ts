import type Database from 'better-sqlite3';
import type { CheckResult } from './check.js';
import { listSources } from '../sources/repository.js';
import type { Settings, SourceRecord } from '../types.js';

export function getHealthSettings(db: Database.Database): Settings {
  const rows = db.prepare('SELECT setting_key, setting_value FROM settings').all() as Array<{ setting_key: string; setting_value: string }>;
  const values = Object.fromEntries(rows.map((row) => [row.setting_key, row.setting_value]));
  return {
    checkIntervalHours: Number(values.check_interval_hours ?? 24),
    requestTimeoutMs: Number(values.request_timeout_ms ?? 10_000),
    failureThreshold: Number(values.failure_threshold ?? 3),
    cacheTime: Number(values.cache_time ?? 7200),
    nextCheckAt: values.next_check_at || null,
  };
}

export function setNextCheckAt(db: Database.Database, value: Date | null): void {
  db.prepare("UPDATE settings SET setting_value = ?, updated_at = CURRENT_TIMESTAMP WHERE setting_key = 'next_check_at'")
    .run(value?.toISOString() ?? '');
}

export function listCheckableSources(db: Database.Database, includeIgnored = false): SourceRecord[] {
  const sources: SourceRecord[] = [];
  for (let page = 1; ; page += 1) {
    const result = listSources(db, { enabled: true, page, pageSize: 200 });
    sources.push(...result.items);
    if (sources.length >= result.total) break;
  }
  return sources.filter((source) => includeIgnored || !source.ignoreHealthCheck);
}

export function recordCheckResult(db: Database.Database, sourceId: number, result: CheckResult): void {
  db.transaction(() => {
    const row = db.prepare('SELECT consecutive_failures FROM sources WHERE id = ?').get(sourceId) as { consecutive_failures: number } | undefined;
    if (!row) return;
    const failures = result.status === 'healthy' ? 0 : row.consecutive_failures + 1;
    db.prepare(`UPDATE sources SET
      health_status = ?, consecutive_failures = ?, last_checked_at = ?,
      latency_ms = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
      result.status, failures, result.checkedAt, result.latencyMs, result.errorMessage, sourceId,
    );
    db.prepare(`INSERT INTO health_checks
      (source_id, status, latency_ms, error_code, error_message, checked_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(sourceId, result.status, result.latencyMs, result.errorCode, result.errorMessage, result.checkedAt);
    db.prepare(`DELETE FROM health_checks WHERE source_id = ? AND id NOT IN
      (SELECT id FROM health_checks WHERE source_id = ? ORDER BY checked_at DESC, id DESC LIMIT 30)`)
      .run(sourceId, sourceId);
  })();
}
