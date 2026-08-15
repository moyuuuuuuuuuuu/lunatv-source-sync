import { describe, expect, test, vi } from 'vitest';
import Fastify from 'fastify';
import { migrate, openDatabase } from '../src/server/db.js';
import { assertSafeUrl, proxyRequest, resolvePublicHost } from '../src/server/proxy/service.js';
import { registerPublicRoutes } from '../src/server/routes/public.js';
import { createSource } from '../src/server/sources/repository.js';

describe('controlled proxy', () => {
  test('prefers IPv4 when local DNS also returns IPv6', async () => {
    const lookup = vi.fn(async () => [
      { address: '2606:4700:3035::ac43:9fe8', family: 6 as const },
      { address: '172.67.159.232', family: 4 as const },
    ]) as unknown as typeof import('node:dns/promises').lookup;
    await expect(resolvePublicHost('dual-stack.example', lookup)).resolves.toEqual([
      { address: '172.67.159.232', family: 4 },
      { address: '2606:4700:3035::ac43:9fe8', family: 6 },
    ]);
  });

  test('falls back to public DoH answers when local DNS returns proxy fake IPs', async () => {
    const lookup = vi.fn(async () => [
      { address: '198.18.0.82', family: 4 as const },
      { address: 'fdfe:dcba:9876::3d', family: 6 as const },
    ]) as unknown as typeof import('node:dns/promises').lookup;
    const dohFetch = vi.fn(async (url: URL | RequestInfo) => {
      const type = new URL(url.toString()).searchParams.get('type');
      return new Response(JSON.stringify({
        Status: 0,
        Answer: type === '1'
          ? [{ type: 1, data: '104.21.35.81' }]
          : [{ type: 28, data: '2606:4700:3034::6815:2351' }],
      }), { headers: { 'content-type': 'application/dns-json' } });
    });
    await expect(resolvePublicHost('feed.example', lookup, dohFetch)).resolves.toEqual([
      { address: '104.21.35.81', family: 4 },
      { address: '2606:4700:3034::6815:2351', family: 6 },
    ]);
  });

  test('rejects unsafe protocols and private, loopback, link-local, and metadata addresses', async () => {
    const resolve = vi.fn(async (host: string) => [{ address: host === 'safe.example' ? '93.184.216.34' : host, family: 4 as const }]);
    await expect(assertSafeUrl(new URL('ftp://safe.example'), resolve)).rejects.toThrow(/protocol/i);
    for (const host of [
      '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254',
      '::1', 'fc00::1', 'fe80::1', '::ffff:7f00:1', '::ffff:a00:1',
      'ff02::1', '2001:db8::1', '2001:2::1', '4000::1',
    ]) {
      const authority = host.includes(':') ? `[${host}]` : host;
      await expect(assertSafeUrl(new URL(`http://${authority}`), async () => [{ address: host, family: host.includes(':') ? 6 : 4 }]))
        .rejects.toThrow(/private|unsafe/i);
    }
  });

  test('merges query, strips credentials, and revalidates redirects', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://next.example/list?fixed=1' } }))
      .mockResolvedValueOnce(new Response('{"list":[]}', { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'x=1' } }));
    const resolve = vi.fn(async () => [{ address: '93.184.216.34', family: 4 as const }]);
    const result = await proxyRequest({
      upstream: 'https://up.example/api?key=fixed', query: { ac: 'list', wd: 'hello', token: 'secret' },
      requestHeaders: { authorization: 'Bearer nope', cookie: 'x=1', accept: 'application/json' }, fetchImpl, resolve,
    });
    expect(fetchImpl.mock.calls[0][0].toString()).toBe('https://up.example/api?key=fixed&ac=list&wd=hello');
    expect(fetchImpl.mock.calls[0][1].headers).toEqual({ accept: 'application/json' });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toBe('application/json');
    expect(result.headers['set-cookie']).toBeUndefined();
  });

  test('enforces timeout and response size', async () => {
    const resolve = async () => [{ address: '93.184.216.34', family: 4 as const }];
    await expect(proxyRequest({ upstream: 'https://safe.example', query: {}, resolve, maxResponseBytes: 2,
      fetchImpl: async () => new Response('large') })).rejects.toThrow(/large/i);
    await expect(proxyRequest({ upstream: 'https://safe.example', query: {}, resolve, timeoutMs: 5,
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))) }))
      .rejects.toThrow(/timed out/i);
  });

  test('route only proxies registered enabled sources and adds CORS', async () => {
    const db = openDatabase(':memory:');
    migrate(db);
    createSource(db, { sourceKey: 'on', name: 'On', api: 'https://safe.example/api' });
    createSource(db, { sourceKey: 'off', name: 'Off', api: 'https://safe.example/api', enabled: false });
    const app = Fastify();
    registerPublicRoutes(app, {
      db,
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImpl: async () => new Response('ok', { headers: { 'content-type': 'text/plain' } }),
    });
    expect((await app.inject('/api/proxy/missing')).statusCode).toBe(404);
    expect((await app.inject('/api/proxy/off')).statusCode).toBe(404);
    const response = await app.inject('/api/proxy/on?ac=list');
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('ok');
    expect(response.headers['access-control-allow-origin']).toBe('*');
    await app.close();
    db.close();
  });

  test('route maps proxy timeouts to 504 and other upstream errors to 502', async () => {
    const db = openDatabase(':memory:'); migrate(db);
    createSource(db, { sourceKey: 'source', name: 'Source', api: 'https://safe.example/api' });
    const resolve = async () => [{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }];
    const timeoutApp = Fastify();
    registerPublicRoutes(timeoutApp, { db, resolve, fetchImpl: (_url, init) => new Promise((_ok, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))) });
    db.prepare("UPDATE settings SET setting_value = '1' WHERE setting_key = 'request_timeout_ms'").run();
    expect((await timeoutApp.inject('/api/proxy/source')).statusCode).toBe(504);
    await timeoutApp.close();
    const failureApp = Fastify();
    registerPublicRoutes(failureApp, { db, resolve, fetchImpl: async () => { throw new Error('connection refused'); } });
    expect((await failureApp.inject('/api/proxy/source')).statusCode).toBe(502);
    await failureApp.close(); db.close();
  });
});
