import { describe, expect, test, vi } from 'vitest';
import Fastify from 'fastify';
import http from 'node:http';
import { migrate, openDatabase } from '../src/server/db.js';
import { assertSafeUrl, proxyRequest, resolvePublicHost } from '../src/server/proxy/service.js';
import { registerPublicRoutes } from '../src/server/routes/public.js';
import { createSource } from '../src/server/sources/repository.js';

describe('controlled proxy', () => {
  test('uses only IPv4 when local DNS also returns unusable IPv6', async () => {
    const lookup = vi.fn(async () => [
      { address: '2606:4700:3035::ac43:9fe8', family: 6 as const },
      { address: '172.67.159.232', family: 4 as const },
    ]) as unknown as typeof import('node:dns/promises').lookup;
    await expect(resolvePublicHost('dual-stack.example', lookup)).resolves.toEqual([
      { address: '172.67.159.232', family: 4 },
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
    ]);
  });

  test('rejects blocked DNS answers when public resolution is unavailable', async () => {
    const lookup = vi.fn(async () => [
      { address: '0.0.0.0', family: 4 as const },
      { address: '::', family: 6 as const },
    ]) as unknown as typeof import('node:dns/promises').lookup;
    const failedDoh = vi.fn(async () => { throw new Error('DoH unavailable'); });
    await expect(assertSafeUrl(new URL('https://blocked.example'), (hostname) => resolvePublicHost(hostname, lookup, failedDoh)))
      .rejects.toThrow(/unsafe|private/i);
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

  test('tunnels default network requests through the configured host proxy', async () => {
    let tunneledRequest = '';
    const proxy = http.createServer();
    proxy.on('connect', (request, socket) => {
      expect(request.url).toBe('93.184.216.34:80');
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.once('data', (data) => {
        tunneledRequest = data.toString();
        const body = '{"list":[]}';
        socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const address = proxy.address();
    if (!address || typeof address === 'string') throw new Error('Proxy did not listen');
    const previous = process.env.OUTBOUND_PROXY_URL;
    process.env.OUTBOUND_PROXY_URL = `http://127.0.0.1:${address.port}`;
    try {
      const result = await proxyRequest({
        upstream: 'http://up.example/api', query: { ac: 'list' },
        resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      });
      expect(new TextDecoder().decode(result.body)).toBe('{"list":[]}');
      expect(tunneledRequest).toContain('GET /api?ac=list HTTP/1.1');
      expect(tunneledRequest.toLowerCase()).toContain('host: up.example');
    } finally {
      if (previous === undefined) delete process.env.OUTBOUND_PROXY_URL;
      else process.env.OUTBOUND_PROXY_URL = previous;
      await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
    }
  });

  test('can let a trusted outbound proxy resolve and route the verified hostname', async () => {
    let connectTarget = '';
    const proxy = http.createServer();
    proxy.on('connect', (request, socket) => {
      connectTarget = request.url ?? '';
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.once('data', () => {
        const body = '{"list":[]}';
        socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const address = proxy.address();
    if (!address || typeof address === 'string') throw new Error('Proxy did not listen');
    const previousProxy = process.env.OUTBOUND_PROXY_URL;
    const previousRemoteDns = process.env.OUTBOUND_PROXY_REMOTE_DNS;
    process.env.OUTBOUND_PROXY_URL = `http://127.0.0.1:${address.port}`;
    process.env.OUTBOUND_PROXY_REMOTE_DNS = 'true';
    try {
      await proxyRequest({
        upstream: 'http://up.example/api', query: {},
        resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      });
      expect(connectTarget).toBe('up.example:80');
    } finally {
      if (previousProxy === undefined) delete process.env.OUTBOUND_PROXY_URL;
      else process.env.OUTBOUND_PROXY_URL = previousProxy;
      if (previousRemoteDns === undefined) delete process.env.OUTBOUND_PROXY_REMOTE_DNS;
      else process.env.OUTBOUND_PROXY_REMOTE_DNS = previousRemoteDns;
      await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
    }
  });

  test('enforces timeout while the outbound proxy tunnel is pending', async () => {
    const proxy = http.createServer();
    const tunnelSockets = new Set<import('node:stream').Duplex>();
    proxy.on('connect', (_request, socket) => {
      tunnelSockets.add(socket);
      socket.once('close', () => tunnelSockets.delete(socket));
      socket.once('error', () => undefined);
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const address = proxy.address();
    if (!address || typeof address === 'string') throw new Error('Proxy did not listen');
    const previous = process.env.OUTBOUND_PROXY_URL;
    process.env.OUTBOUND_PROXY_URL = `http://127.0.0.1:${address.port}`;
    try {
      await expect(proxyRequest({
        upstream: 'https://up.example/api', query: {}, timeoutMs: 20,
        resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      })).rejects.toThrow(/timed out/i);
    } finally {
      if (previous === undefined) delete process.env.OUTBOUND_PROXY_URL;
      else process.env.OUTBOUND_PROXY_URL = previous;
      for (const socket of tunnelSockets) socket.destroy();
      proxy.closeAllConnections();
      await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
    }
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
