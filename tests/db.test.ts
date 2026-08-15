import { describe, expect, test } from 'vitest';
import { migrate, openDatabase } from '../src/server/db.js';

describe('database migrations', () => {
  test('create required tables and default settings', () => {
    const db = openDatabase(':memory:');

    try {
      migrate(db);

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      const tableNames = new Set(tables.map((table) => table.name));

      expect([...tableNames]).toEqual(
        expect.arrayContaining(['sources', 'health_checks', 'settings', 'sessions']),
      );

      const settings = db
        .prepare('SELECT setting_key, setting_value FROM settings')
        .all() as Array<{ setting_key: string; setting_value: string }>;

      expect(
        Object.fromEntries(
          settings.map(({ setting_key, setting_value }) => [setting_key, setting_value]),
        ),
      ).toMatchObject({
        check_interval_hours: '24',
        request_timeout_ms: '10000',
        failure_threshold: '3',
        cache_time: '7200',
      });
    } finally {
      db.close();
    }
  });
});
