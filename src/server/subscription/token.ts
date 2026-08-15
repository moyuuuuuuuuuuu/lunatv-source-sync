import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';

export function ensureSubscriptionToken(
  db: Database.Database,
): string {
  const row = db.prepare(
    "SELECT setting_value FROM settings WHERE setting_key = 'subscription_token'",
  ).get() as { setting_value: string } | undefined;
  if (row?.setting_value) return row.setting_value;

  return resetSubscriptionToken(db);
}

export function resetSubscriptionToken(db: Database.Database): string {
  const token = randomBytes(32).toString('base64url');
  db.prepare(`INSERT INTO settings (setting_key, setting_value, updated_at)
    VALUES ('subscription_token', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(setting_key) DO UPDATE SET
      setting_value = excluded.setting_value,
      updated_at = CURRENT_TIMESTAMP`).run(token);
  return token;
}
