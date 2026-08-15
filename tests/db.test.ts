import { afterEach, describe, expect, test, vi } from 'vitest';
import { migrate, openDatabase } from '../src/server/db.js';
import { loadConfig } from '../src/server/config.js';

afterEach(() => vi.unstubAllEnvs());

describe('environment configuration', () => {
  test('defaults proxy security flags for local HTTP and parses explicit HTTPS settings', () => {
    vi.stubEnv('ADMIN_USERNAME', 'admin');
    vi.stubEnv('ADMIN_PASSWORD', 'password');
    vi.stubEnv('SESSION_SECRET', 'secret');
    vi.stubEnv('SECURE_COOKIES', '');
    vi.stubEnv('TRUST_PROXY', '');
    expect(loadConfig()).toMatchObject({ secureCookies: false, trustProxy: false });
    vi.stubEnv('SECURE_COOKIES', 'true');
    vi.stubEnv('TRUST_PROXY', 'TRUE');
    expect(loadConfig()).toMatchObject({ secureCookies: true, trustProxy: true });
    vi.stubEnv('TRUST_PROXY', 'yes');
    expect(() => loadConfig()).toThrow('TRUST_PROXY must be true or false');
  });
});

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
