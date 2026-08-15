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
}
