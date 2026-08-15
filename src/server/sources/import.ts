import type Database from 'better-sqlite3';
import type { ClassificationMode, ContentCategory, SourceType } from '../types.js';
import { classifyAdult } from './classify.js';
import { getSourceByApi } from './repository.js';

export interface ImportEntry {
  sourceKey: string;
  name: string;
  api: string;
  sourceType: SourceType;
  contentCategory: ContentCategory;
  detail: string | null;
  comment: string | null;
  classificationMode: ClassificationMode;
  isAdult: boolean;
}

export interface ImportError {
  sourceKey: string;
  code: 'INVALID_KEY' | 'INVALID_ENTRY' | 'INVALID_NAME' | 'INVALID_API' | 'INVALID_ADULT';
  message: string;
}

export interface ImportPreview {
  entries: ImportEntry[];
  errors: ImportError[];
}

export interface ImportResult {
  inserted: number;
  updated: number;
  skipped: number;
}
export type DuplicateApiPolicy = 'skip' | 'overwrite';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value.trim() || null : undefined;
}

export function previewImport(
  payload: unknown,
  extraKeywords: readonly string[] = [],
): ImportPreview {
  if (!isObject(payload)) throw new Error('import document must be an object');
  const apiSite = payload.api_site;
  const liveSources = payload.live_sources;
  const vodSources = payload.vod_sources;
  if (apiSite !== undefined && !isObject(apiSite)) throw new Error('api_site must be an object');
  if (liveSources !== undefined && !Array.isArray(liveSources)) throw new Error('live_sources must be an array');
  if (vodSources !== undefined && !Array.isArray(vodSources)) throw new Error('vod_sources must be an array');
  if (!apiSite && !liveSources && !vodSources) throw new Error('no supported source collection found');

  const entries: ImportEntry[] = [];
  const errors: ImportError[] = [];

  const candidates: Array<[string, unknown, SourceType]> = [
    ...Object.entries(apiSite ?? {}).map(([key, value]) => [key, value, 'vod_api'] as [string, unknown, SourceType]),
    ...(liveSources ?? []).map((value, index) => [isObject(value) && typeof value.key === 'string' ? value.key : `live-${index + 1}`, value, 'live_m3u'] as [string, unknown, SourceType]),
    ...(vodSources ?? []).map((value, index) => [isObject(value) && typeof value.key === 'string' ? value.key : `vod-${index + 1}`, value,
      isObject(value) && value.kind === 'navigation' ? 'navigation' : 'tvbox'] as [string, unknown, SourceType]),
  ];
  for (const [sourceKey, value, sourceType] of candidates) {
    if (!sourceKey.trim()) {
      errors.push({ sourceKey, code: 'INVALID_KEY', message: 'source key is required' });
      continue;
    }
    if (!isObject(value)) {
      errors.push({ sourceKey, code: 'INVALID_ENTRY', message: 'source must be an object' });
      continue;
    }

    const name = typeof value.name === 'string' ? value.name.trim() : '';
    const api = typeof value.api === 'string' ? value.api.trim() : typeof value.url === 'string' ? value.url.trim() : '';
    const detail = optionalString(value.detail);
    const comment = optionalString(value._comment);

    if (!name) {
      errors.push({ sourceKey, code: 'INVALID_NAME', message: 'name is required' });
      continue;
    }
    if (!api) {
      errors.push({ sourceKey, code: 'INVALID_API', message: 'api is required' });
      continue;
    }
    if (detail === undefined || comment === undefined) {
      errors.push({ sourceKey, code: 'INVALID_ENTRY', message: 'detail and _comment must be strings' });
      continue;
    }
    if (value.adult !== undefined && typeof value.adult !== 'boolean') {
      errors.push({ sourceKey, code: 'INVALID_ADULT', message: 'adult must be a boolean' });
      continue;
    }

    const classificationMode: ClassificationMode = value.adult === true
      ? 'adult'
      : value.adult === false ? 'normal' : 'auto';
    const isAdult = classificationMode === 'adult' || (classificationMode === 'auto' && classifyAdult({
      sourceKey, name, api, detail, comment,
    }, extraKeywords));
    const requestedCategory = value.category;
    if (requestedCategory !== undefined && !['general', 'movie', 'short_drama'].includes(String(requestedCategory))) {
      errors.push({ sourceKey, code: 'INVALID_ENTRY', message: 'category must be general, movie, or short_drama' });
      continue;
    }
    const contentCategory = (requestedCategory ?? (sourceType === 'vod_api' ? 'movie' : 'general')) as ContentCategory;

    entries.push({ sourceKey, name, api, sourceType, contentCategory, detail, comment, classificationMode, isAdult });
  }

  return { entries, errors };
}

export function applyImport(db: Database.Database, preview: ImportPreview, duplicateApiPolicy: DuplicateApiPolicy = 'skip'): ImportResult {
  const exists = db.prepare('SELECT 1 FROM sources WHERE source_key = ?');
  const upsert = db.prepare(`
    INSERT INTO sources (
      source_key, name, api, source_type, content_category, detail, comment, classification_mode, is_adult
    ) VALUES (
      @sourceKey, @name, @api, @sourceType, @contentCategory, @detail, @comment, @classificationMode, @isAdult
    )
    ON CONFLICT(source_key) DO UPDATE SET
      name = excluded.name,
      api = excluded.api,
      source_type = excluded.source_type,
      content_category = excluded.content_category,
      detail = excluded.detail,
      comment = excluded.comment,
      classification_mode = excluded.classification_mode,
      is_adult = excluded.is_adult,
      updated_at = CURRENT_TIMESTAMP
  `);

  return db.transaction((entries: ImportEntry[]) => {
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    for (const entry of entries) {
      if (exists.get(entry.sourceKey)) {
        updated += 1;
        upsert.run({ ...entry, isAdult: Number(entry.isAdult) });
        continue;
      }
      const duplicateApi = getSourceByApi(db, entry.api);
      if (duplicateApi) {
        if (duplicateApiPolicy === 'skip') { skipped += 1; continue; }
        updated += 1;
        upsert.run({ ...entry, sourceKey: duplicateApi.sourceKey, isAdult: Number(entry.isAdult) });
        continue;
      }
      inserted += 1;
      upsert.run({ ...entry, isAdult: Number(entry.isAdult) });
    }
    return { inserted, updated, skipped };
  })(preview.entries);
}
