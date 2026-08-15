import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

const schemaPath = new URL('./schema.sql', import.meta.url);

export function openDatabase(path: string): Database.Database {
  const db = new Database(path);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  return db;
}

export function migrate(db: Database.Database): void {
  db.exec(readFileSync(schemaPath, 'utf8'));
  const columns = db.prepare('PRAGMA table_info(sources)').all() as Array<{ name: string }>;
  if (!columns.some(({ name }) => name === 'source_type')) {
    db.exec("ALTER TABLE sources ADD COLUMN source_type TEXT NOT NULL DEFAULT 'vod_api' CHECK (source_type IN ('vod_api', 'live_m3u', 'tvbox', 'navigation'))");
  }
  if (!columns.some(({ name }) => name === 'content_category')) {
    db.exec("ALTER TABLE sources ADD COLUMN content_category TEXT NOT NULL DEFAULT 'general' CHECK (content_category IN ('general', 'movie', 'short_drama'))");
  }
}
