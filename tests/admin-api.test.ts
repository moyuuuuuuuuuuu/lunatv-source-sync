import { afterEach, describe, expect, test, vi } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { migrate, openDatabase } from '../src/server/db.js';

const databases: ReturnType<typeof openDatabase>[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

async function fixture(overrides: Partial<Parameters<typeof buildApp>[0]> = {}) {
  const db = overrides.db ?? openDatabase(':memory:');
  if (!overrides.db) migrate(db);
  databases.push(db);
  const config = overrides.config ?? {
      adminUsername: 'admin', adminPassword: 'correct horse', sessionSecret: 'test-secret',
      port: 3000, databasePath: ':memory:', adultKeywordsExtra: [],
    };
  const app = await buildApp({ ...overrides, db, config, startHealthScheduler: overrides.startHealthScheduler ?? false });
  apps.push(app);
  return { app, db };
}

function cookie(response: { headers: Record<string, unknown> }): string {
  return String(response.headers['set-cookie']).split(';', 1)[0];
}

async function login(app: Awaited<ReturnType<typeof buildApp>>) {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'correct horse' } });
  return { response, cookie: cookie(response), csrf: response.json().csrfToken as string };
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const db of databases.splice(0)) if (db.open) db.close();
});

describe('authentication', () => {
  test('logs in with a rotated hashed session and secure cookie attributes, then logs out', async () => {
    const { app, db } = await fixture({ secureCookies: true });
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'wrong' } })).statusCode).toBe(401);
    const first = await login(app);
    expect(first.response.statusCode).toBe(200);
    expect(first.response.headers['set-cookie']).toMatch(/HttpOnly/i);
    expect(first.response.headers['set-cookie']).toMatch(/SameSite=Strict/i);
    expect(first.response.headers['set-cookie']).toMatch(/Secure/i);
    expect(first.csrf).toMatch(/^[a-f0-9]{64}$/);
    expect((db.prepare('SELECT token_hash FROM sessions').get() as { token_hash: string }).token_hash).not.toContain(first.cookie.split('=')[1]);
    const second = await login(app);
    expect(second.cookie).not.toBe(first.cookie);
    expect((db.prepare('SELECT count(*) count FROM sessions').get() as { count: number }).count).toBe(1);
    expect((await app.inject({ url: '/api/auth/session', headers: { cookie: second.cookie } })).json()).toMatchObject({ authenticated: true, csrfToken: second.csrf });
    db.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    expect((await app.inject({ url: '/api/auth/session', headers: { cookie: second.cookie } })).statusCode).toBe(401);
    const active = await login(app);
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: active.cookie, 'x-csrf-token': active.csrf } })).statusCode).toBe(204);
    expect((await app.inject({ url: '/api/auth/session', headers: { cookie: active.cookie } })).statusCode).toBe(401);
  });

  test('rejects unauthenticated access, requires CSRF on writes, and throttles failures', async () => {
    const { app } = await fixture();
    expect((await app.inject({ url: '/api/admin/dashboard' })).statusCode).toBe(401);
    const auth = await login(app);
    expect((await app.inject({ method: 'POST', url: '/api/admin/sources', headers: { cookie: auth.cookie }, payload: {} })).statusCode).toBe(403);
    for (let index = 0; index < 5; index += 1) await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '10.0.0.9', payload: { username: 'admin', password: 'bad' } });
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '10.0.0.9', payload: { username: 'admin', password: 'bad' } })).statusCode).toBe(429);
  });

  test('changes the persisted admin password and invalidates active sessions', async () => {
    const { app } = await fixture(); const auth = await login(app);
    const headers = { cookie: auth.cookie, 'x-csrf-token': auth.csrf };
    expect((await app.inject({ method: 'POST', url: '/api/admin/password/change', headers, payload: { currentPassword: 'wrong password', newPassword: 'new secure password' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/admin/password/change', headers, payload: { currentPassword: 'correct horse', newPassword: 'short' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/admin/password/change', headers, payload: { currentPassword: 'correct horse', newPassword: 'new secure password' } })).statusCode).toBe(204);
    expect((await app.inject({ url: '/api/auth/session', headers: { cookie: auth.cookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'correct horse' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'new secure password' } })).statusCode).toBe(200);
  });
});

describe('management API', () => {
  test('generates and resets a managed subscription token while invalidating the old URL', async () => {
    const config = {
      adminUsername: 'admin', adminPassword: 'correct horse', sessionSecret: 'test-secret',
      port: 3000, databasePath: ':memory:', adultKeywordsExtra: [], secureCookies: false, trustProxy: false,
    };
    const { app } = await fixture({ config }); const auth = await login(app);
    const headers = { cookie: auth.cookie, 'x-csrf-token': auth.csrf };
    const before = (await app.inject({ url: '/api/admin/subscription-examples', headers })).json();
    const oldToken = new URL(before.normalJson).searchParams.get('token');
    expect(oldToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(before.tokenCanReset).toBe(true);
    expect((await app.inject(`/api/source?token=${oldToken}`)).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/admin/subscription-token/reset', headers })).statusCode).toBe(200);
    const after = (await app.inject({ url: '/api/admin/subscription-examples', headers })).json();
    const newToken = new URL(after.normalJson).searchParams.get('token');
    expect(newToken).not.toBe(oldToken);
    expect((await app.inject(`/api/source?token=${oldToken}`)).statusCode).toBe(401);
    expect((await app.inject(`/api/source?token=${newToken}`)).statusCode).toBe(200);
  });

  test('previews JSON and Base58 imports fetched through the safe URL client', async () => {
    const document = { api_site: { remote: { name: 'Remote', api: 'https://example.com/api' } } };
    const { base58EncodeUtf8 } = await import('../src/server/subscription/base58.js');
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(document)))
      .mockResolvedValueOnce(new Response(base58EncodeUtf8(JSON.stringify(document))));
    const resolve = vi.fn(async () => [{ address: '93.184.216.34', family: 4 as const }]);
    const { app } = await fixture({ importUrlOptions: { fetchImpl, resolve } }); const auth = await login(app);
    const headers = { cookie: auth.cookie, 'x-csrf-token': auth.csrf };
    for (const url of ['https://feeds.example/source.json?token=secret', 'https://feeds.example/source.txt']) {
      const response = await app.inject({ method: 'POST', url: '/api/admin/import/url-preview', headers, payload: { url } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ inserted: 1, updated: 0, invalid: 0, document });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('protects URL import and returns redacted, bounded errors', async () => {
    const fetchImpl = vi.fn(async () => new Response('not-json-or-base58'));
    const { app } = await fixture({ importUrlOptions: { fetchImpl, resolve: async () => [{ address: '93.184.216.34', family: 4 }] } });
    const auth = await login(app); const headers = { cookie: auth.cookie, 'x-csrf-token': auth.csrf };
    expect((await app.inject({ method: 'POST', url: '/api/admin/import/url-preview', payload: { url: 'https://safe.example' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/admin/import/url-preview', headers: { cookie: auth.cookie }, payload: { url: 'https://safe.example' } })).statusCode).toBe(403);
    for (const url of ['ftp://example.com/file', 'https://user:secret@example.com/file', 'not-a-url']) {
      const response = await app.inject({ method: 'POST', url: '/api/admin/import/url-preview', headers, payload: { url } });
      expect(response.statusCode).toBe(400); expect(response.body).not.toContain(url); expect(response.body).not.toContain('secret');
    }
    const malformed = await app.inject({ method: 'POST', url: '/api/admin/import/url-preview', headers, payload: { url: 'https://safe.example/file?token=secret' } });
    expect(malformed.statusCode).toBe(422); expect(malformed.body).not.toContain('secret');
  });
  test('supports preview/apply, CRUD, filtering and bulk actions', async () => {
    const { app, db } = await fixture(); const auth = await login(app);
    const headers = { cookie: auth.cookie, 'x-csrf-token': auth.csrf };
    const payload = { api_site: { one: { name: 'One', api: 'https://example.com/api' }, broken: { name: '' } } };
    const preview = await app.inject({ method: 'POST', url: '/api/admin/import/preview', headers, payload });
    expect(preview.statusCode).toBe(200); expect(preview.json()).toMatchObject({ inserted: 1, updated: 0, invalid: 1 });
    const applied = await app.inject({ method: 'POST', url: '/api/admin/import/apply', headers, payload });
    expect(applied.json()).toMatchObject({ inserted: 1, updated: 0, invalid: 1 });
    const overwrite = await app.inject({ method: 'POST', url: '/api/admin/import/preview', headers, payload });
    expect(overwrite.json()).toMatchObject({ inserted: 0, updated: 1, invalid: 1 });
    const created = await app.inject({ method: 'POST', url: '/api/admin/sources', headers, payload: { sourceKey: 'adult', name: 'Adult', api: 'https://example.com/adult', classificationMode: 'adult' } });
    expect(created.statusCode).toBe(201); const id = created.json().id as number;
    const skippedDuplicate = await app.inject({ method: 'POST', url: '/api/admin/sources', headers, payload: { sourceKey: 'duplicate', name: 'Duplicate', api: 'https://example.com/adult/' } });
    expect(skippedDuplicate.json()).toMatchObject({ id, sourceKey: 'adult', duplicateAction: 'skipped' });
    const overwrittenDuplicate = await app.inject({ method: 'POST', url: '/api/admin/sources', headers, payload: { sourceKey: 'replacement', name: 'Overwritten', api: 'https://example.com/adult/', classificationMode: 'adult', duplicateApiPolicy: 'overwrite' } });
    expect(overwrittenDuplicate.json()).toMatchObject({ id, sourceKey: 'adult', name: 'Overwritten', duplicateAction: 'overwritten' });
    expect((await app.inject({ url: '/api/admin/sources?classification=adult', headers })).json()).toMatchObject({ total: 1 });
    expect((await app.inject({ method: 'PUT', url: `/api/admin/sources/${id}`, headers, payload: { name: 'Changed' } })).json().name).toBe('Changed');
    expect((await app.inject({ method: 'POST', url: '/api/admin/sources/bulk', headers, payload: { ids: [id], action: 'disable' } })).json()).toEqual({ affected: 1 });
    expect((await app.inject({ method: 'POST', url: '/api/admin/sources/remove-unhealthy', payload: {} })).statusCode).toBe(401);
    db.prepare("UPDATE sources SET health_status = 'unhealthy' WHERE source_key = 'one'").run();
    expect((await app.inject({ method: 'POST', url: '/api/admin/sources/remove-unhealthy', headers })).json()).toEqual({ affected: 1 });
    expect((await app.inject({ url: '/api/admin/sources?healthStatus=unhealthy', headers })).json()).toMatchObject({ total: 0 });
    expect((await app.inject({ method: 'DELETE', url: `/api/admin/sources/${id}`, headers })).statusCode).toBe(204);
  });

  test('strictly validates source bodies and list filters without reflecting input', async () => {
    const { app } = await fixture(); const auth = await login(app);
    const headers = { cookie: auth.cookie, 'x-csrf-token': auth.csrf };
    for (const payload of [
      { sourceKey: 'one', name: 'One', api: 'ftp://example.com/api' },
      { sourceKey: 'one', name: 'One', api: 'https://user:password@example.com/api' },
      { sourceKey: 'one', name: 'One', api: 'https://example.com', enabled: 'false' },
      { sourceKey: 'one', name: 'One', api: 'https://example.com', secret: 'do-not-reflect' },
      { sourceKey: 'one', name: 'One', api: 'https://example.com', detail: 42 },
    ]) {
      const response = await app.inject({ method: 'POST', url: '/api/admin/sources', headers, payload });
      expect(response.statusCode).toBe(400); expect(response.body).not.toContain('do-not-reflect');
    }
    const created = await app.inject({ method: 'POST', url: '/api/admin/sources', headers, payload: { sourceKey: 'one', name: 'One', api: 'https://example.com' } });
    const id = created.json().id as number;
    expect((await app.inject({ method: 'PUT', url: `/api/admin/sources/${id}`, headers, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: `/api/admin/sources/${id}`, headers, payload: { enabled: 'false' } })).statusCode).toBe(400);
    for (const query of ['page=0', 'page=nope', 'pageSize=201', 'pageSize=-1', 'enabled=1', 'classification=other', 'sort=fastest', 'unknown=subscription-secret']) {
      const response = await app.inject({ url: `/api/admin/sources?${query}`, headers });
      expect(response.statusCode).toBe(400); expect(response.body).not.toContain('subscription-secret');
    }
    expect((await app.inject({ method: 'DELETE', url: '/api/admin/sources/999', headers })).json()).toMatchObject({ code: 'NOT_FOUND' });
  });

  test('runs checks, validates settings, reports dashboard/history, and returns usable subscription links', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"list":[]}'));
    const resolve = async () => [{ address: '93.184.216.34', family: 4 }];
    const { app } = await fixture({ healthOptions: { fetchImpl, resolve } }); const auth = await login(app);
    const headers = { cookie: auth.cookie, 'x-csrf-token': auth.csrf };
    const emptyPost = await app.inject({ method: 'POST', url: '/api/admin/health/check', headers: { ...headers, 'content-length': '0' } });
    expect(emptyPost.statusCode).toBe(200);
    const proxiedEmptyPost = await app.inject({ method: 'POST', url: '/api/admin/health/check', headers: { ...headers, 'content-type': 'application/x-proxy-empty', 'content-length': '0' } });
    expect(proxiedEmptyPost.statusCode).toBe(200);
    const untypedBody = await app.inject({ method: 'POST', url: '/api/admin/health/check', headers, payload: Buffer.from('unexpected') });
    expect(untypedBody.statusCode).toBe(415);
    const created = await app.inject({ method: 'POST', url: '/api/admin/sources', headers, payload: { sourceKey: 'one', name: 'One', api: 'https://example.com/api' } });
    const id = created.json().id as number;
    expect((await app.inject({ method: 'POST', url: `/api/admin/sources/${id}/check`, headers })).json()).toMatchObject({ checked: 1, healthy: 1 });
    expect((await app.inject({ url: `/api/admin/sources/${id}/health`, headers })).json().items).toHaveLength(1);
    expect((await app.inject({ url: '/api/admin/dashboard', headers })).json()).toMatchObject({ total: 1, normal: 1, healthy: 1 });
    expect((await app.inject({ method: 'PUT', url: '/api/admin/settings', headers, payload: { checkIntervalHours: 0 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/admin/settings', headers, payload: { checkIntervalHours: 12, requestTimeoutMs: 5000, failureThreshold: 2, cacheTime: 3600, token: 'secret' } })).statusCode).toBe(400);
    const settings = await app.inject({ method: 'PUT', url: '/api/admin/settings', headers, payload: { checkIntervalHours: 12, requestTimeoutMs: 5000, failureThreshold: 2, cacheTime: 3600 } });
    expect(settings.json()).toMatchObject({ checkIntervalHours: 12, requestTimeoutMs: 5000, failureThreshold: 2, cacheTime: 3600 });
    const examples = await app.inject({ url: '/api/admin/subscription-examples', headers: { ...headers, host: 'example.test' } });
    expect(new URL(examples.json().normalJson).searchParams.get('token')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(examples.json().tokenCanReset).toBe(true);
    expect(JSON.stringify(examples.json())).not.toContain('correct horse');
  });
});
