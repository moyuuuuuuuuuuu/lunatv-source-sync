import type Database from 'better-sqlite3';
import type { ClassificationMode } from '../types.js';
import { classifyAdult } from './classify.js';
import { getSourceByApi } from './repository.js';

export interface ImportEntry {
  sourceKey: string;
  name: string;
  api: string;
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
  if (!isObject(payload) || !isObject(payload.api_site)) {
    throw new Error('api_site must be an object');
  }

  const entries: ImportEntry[] = [];
  const errors: ImportError[] = [];

  for (const [sourceKey, value] of Object.entries(payload.api_site)) {
    if (!sourceKey.trim()) {
      errors.push({ sourceKey, code: 'INVALID_KEY', message: 'source key is required' });
      continue;
    }
    if (!isObject(value)) {
      errors.push({ sourceKey, code: 'INVALID_ENTRY', message: 'source must be an object' });
      continue;
    }

    const name = typeof value.name === 'string' ? value.name.trim() : '';
    const api = typeof value.api === 'string' ? value.api.trim() : '';
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

    entries.push({ sourceKey, name, api, detail, comment, classificationMode, isAdult });
  }

  return { entries, errors };
}

export function applyImport(db: Database.Database, preview: ImportPreview, duplicateApiPolicy: DuplicateApiPolicy = 'skip'): ImportResult {
  const exists = db.prepare('SELECT 1 FROM sources WHERE source_key = ?');
  const upsert = db.prepare(`
    INSERT INTO sources (
      source_key, name, api, detail, comment, classification_mode, is_adult
    ) VALUES (
      @sourceKey, @name, @api, @detail, @comment, @classificationMode, @isAdult
    )
    ON CONFLICT(source_key) DO UPDATE SET
      name = excluded.name,
      api = excluded.api,
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
