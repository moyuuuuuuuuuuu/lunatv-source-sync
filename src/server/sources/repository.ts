import type Database from 'better-sqlite3';
import type { ClassificationMode, HealthStatus, SourceRecord } from '../types.js';
import { classifyAdult } from './classify.js';

interface SourceRow {
  id: number;
  source_key: string;
  name: string;
  api: string;
  detail: string | null;
  comment: string | null;
  classification_mode: ClassificationMode;
  is_adult: number;
  enabled: number;
  ignore_health_check: number;
  health_status: HealthStatus;
  consecutive_failures: number;
  last_checked_at: string | null;
  latency_ms: number | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateSourceInput {
  sourceKey: string;
  name: string;
  api: string;
  detail?: string | null;
  comment?: string | null;
  classificationMode?: ClassificationMode;
  enabled?: boolean;
  ignoreHealthCheck?: boolean;
  extraKeywords?: readonly string[];
}

export type UpdateSourceInput = Partial<Omit<CreateSourceInput, 'sourceKey' | 'extraKeywords'>> & {
  sourceKey?: string;
  extraKeywords?: readonly string[];
};

export interface ListSourceOptions {
  search?: string;
  classification?: 'adult' | 'normal';
  enabled?: boolean;
  healthStatus?: HealthStatus;
  page?: number;
  pageSize?: number;
}

function mapRow(row: SourceRow): SourceRecord {
  return {
    id: row.id, sourceKey: row.source_key, name: row.name, api: row.api,
    detail: row.detail, comment: row.comment, classificationMode: row.classification_mode,
    isAdult: Boolean(row.is_adult), enabled: Boolean(row.enabled),
    ignoreHealthCheck: Boolean(row.ignore_health_check), healthStatus: row.health_status,
    consecutiveFailures: row.consecutive_failures, lastCheckedAt: row.last_checked_at,
    latencyMs: row.latency_ms, lastError: row.last_error,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function requireText(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} is required`);
  return trimmed;
}

export function getSourceById(db: Database.Database, id: number): SourceRecord | null {
  const row = db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as SourceRow | undefined;
  return row ? mapRow(row) : null;
}

export function getSourceByKey(db: Database.Database, sourceKey: string): SourceRecord | null {
  const row = db.prepare('SELECT * FROM sources WHERE source_key = ?').get(sourceKey) as SourceRow | undefined;
  return row ? mapRow(row) : null;
}

export function listSources(db: Database.Database, options: ListSourceOptions = {}): {
  items: SourceRecord[]; total: number; page: number; pageSize: number;
} {
  const where: string[] = [];
  const params: Record<string, string | number> = {};
  if (options.search?.trim()) {
    where.push('(source_key LIKE @search OR name LIKE @search OR api LIKE @search)');
    params.search = `%${options.search.trim()}%`;
  }
  if (options.classification) {
    where.push('is_adult = @isAdult');
    params.isAdult = Number(options.classification === 'adult');
  }
  if (options.enabled !== undefined) {
    where.push('enabled = @enabled');
    params.enabled = Number(options.enabled);
  }
  if (options.healthStatus) {
    where.push('health_status = @healthStatus');
    params.healthStatus = options.healthStatus;
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const page = Math.max(1, Math.trunc(options.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Math.trunc(options.pageSize ?? 50)));
  const total = (db.prepare(`SELECT count(*) AS count FROM sources ${clause}`).get(params) as { count: number }).count;
  const rows = db.prepare(`SELECT * FROM sources ${clause} ORDER BY id DESC LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize }) as SourceRow[];
  return { items: rows.map(mapRow), total, page, pageSize };
}

export function createSource(db: Database.Database, input: CreateSourceInput): SourceRecord {
  const sourceKey = requireText(input.sourceKey, 'sourceKey');
  const name = requireText(input.name, 'name');
  const api = requireText(input.api, 'api');
  const classificationMode = input.classificationMode ?? 'auto';
  const isAdult = classificationMode === 'adult' || (classificationMode === 'auto' && classifyAdult({
    sourceKey, name, api, detail: input.detail, comment: input.comment,
  }, input.extraKeywords));
  const result = db.prepare(`INSERT INTO sources (
    source_key, name, api, detail, comment, classification_mode, is_adult, enabled, ignore_health_check
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    sourceKey, name, api, input.detail ?? null, input.comment ?? null, classificationMode,
    Number(isAdult), Number(input.enabled ?? true), Number(input.ignoreHealthCheck ?? false),
  );
  return getSourceById(db, Number(result.lastInsertRowid))!;
}

export function updateSource(db: Database.Database, id: number, input: UpdateSourceInput): SourceRecord | null {
  const current = getSourceById(db, id);
  if (!current) return null;
  const sourceKey = input.sourceKey === undefined ? current.sourceKey : requireText(input.sourceKey, 'sourceKey');
  const name = input.name === undefined ? current.name : requireText(input.name, 'name');
  const api = input.api === undefined ? current.api : requireText(input.api, 'api');
  const detail = input.detail === undefined ? current.detail : input.detail;
  const comment = input.comment === undefined ? current.comment : input.comment;
  const classificationMode = input.classificationMode ?? current.classificationMode;
  const isAdult = classificationMode === 'adult' || (classificationMode === 'auto' && classifyAdult({
    sourceKey, name, api, detail, comment,
  }, input.extraKeywords));
  db.prepare(`UPDATE sources SET source_key = ?, name = ?, api = ?, detail = ?, comment = ?,
    classification_mode = ?, is_adult = ?, enabled = ?, ignore_health_check = ?,
    updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
    sourceKey, name, api, detail, comment, classificationMode, Number(isAdult),
    Number(input.enabled ?? current.enabled), Number(input.ignoreHealthCheck ?? current.ignoreHealthCheck), id,
  );
  return getSourceById(db, id);
}

export function bulkSetEnabled(db: Database.Database, ids: readonly number[], enabled: boolean): number {
  const update = db.prepare('UPDATE sources SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
  return db.transaction((sourceIds: readonly number[]) => sourceIds.reduce(
    (count, id) => count + update.run(Number(enabled), id).changes, 0,
  ))(ids);
}

export function deleteSources(db: Database.Database, ids: readonly number[]): number {
  const remove = db.prepare('DELETE FROM sources WHERE id = ?');
  return db.transaction((sourceIds: readonly number[]) => sourceIds.reduce(
    (count, id) => count + remove.run(id).changes, 0,
  ))(ids);
}

export function deleteUnhealthySources(db: Database.Database): number {
  return db.prepare("DELETE FROM sources WHERE health_status = 'unhealthy'").run().changes;
}

export function deleteSource(db: Database.Database, id: number): boolean {
  return deleteSources(db, [id]) === 1;
}
