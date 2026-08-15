import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { Readable } from 'node:stream';
import { isUnsafeAddress } from './safety.js';

export type ResolveHost = (hostname: string) => Promise<readonly { address: string; family: number }[]>;
type LookupHost = typeof lookup;
type DohFetch = typeof fetch;

interface DohResponse {
  Status?: number;
  Answer?: Array<{ type?: number; data?: string }>;
}

function supportedAddresses(addresses: readonly { address: string; family: number }[]): readonly { address: string; family: number }[] {
  // The target deployment is commonly a NAS/container without an IPv6 route.
  // On affected Node 22 builds an IPv6 TLS connect can emit EADDRNOTAVAIL on
  // the socket before the ClientRequest error handler is attached and crash
  // the process. Do not create IPv6 sockets in the default network path.
  return addresses.filter(({ family }) => family === 4);
}

async function resolveWithDoh(hostname: string, fetchImpl: DohFetch): Promise<readonly { address: string; family: number }[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const answers = await Promise.all([1, 28].map(async (type) => {
      const url = new URL('https://cloudflare-dns.com/dns-query');
      url.searchParams.set('name', hostname);
      url.searchParams.set('type', String(type));
      const response = await fetchImpl(url, {
        headers: { accept: 'application/dns-json' },
        signal: controller.signal,
      });
      if (!response.ok) return [];
      const body = await response.json() as DohResponse;
      if (body.Status !== 0) return [];
      return (body.Answer ?? [])
        .filter((answer) => answer.type === type && typeof answer.data === 'string')
        .map((answer) => ({ address: answer.data!, family: type === 1 ? 4 : 6 }));
    }));
    return answers.flat();
  } finally {
    clearTimeout(timer);
  }
}

export async function resolvePublicHost(
  hostname: string,
  lookupImpl: LookupHost = lookup,
  dohFetch: DohFetch = fetch,
): Promise<readonly { address: string; family: number }[]> {
  const local = await lookupImpl(hostname, { all: true, verbatim: true });
  if (local.length && local.every(({ address }) => !isUnsafeAddress(address))) return supportedAddresses(local);
  try {
    const publicAnswers = await resolveWithDoh(hostname, dohFetch);
    return supportedAddresses(publicAnswers.length ? publicAnswers : local);
  } catch {
    return supportedAddresses(local);
  }
}

const defaultResolve: ResolveHost = (hostname) => resolvePublicHost(hostname);
const SAFE_REQUEST_HEADERS = new Set(['accept', 'accept-language', 'user-agent']);
const SAFE_RESPONSE_HEADERS = new Set(['content-type', 'content-language', 'cache-control', 'etag', 'last-modified']);

export async function assertSafeUrl(url: URL, resolve: ResolveHost = defaultResolve): Promise<void> {
  await resolveSafe(url, resolve);
}

async function resolveSafe(url: URL, resolve: ResolveHost): Promise<readonly { address: string; family: number }[]> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Unsupported proxy protocol');
  if (url.username || url.password) throw new Error('URL credentials are not allowed');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await resolve(hostname);
  if (!addresses.length || addresses.some(({ address }) => isUnsafeAddress(address))) {
    throw new Error('Unsafe or private upstream address');
  }
  return addresses;
}

export class ProxyTimeoutError extends Error {
  constructor() { super('Upstream request timed out'); this.name = 'ProxyTimeoutError'; }
}

function configuredProxy(): URL | null {
  const value = process.env.OUTBOUND_PROXY_URL?.trim();
  if (!value) return null;
  const proxy = new URL(value);
  if (proxy.protocol !== 'http:' || (proxy.pathname !== '/' && proxy.pathname !== '') || proxy.search || proxy.hash) {
    throw new Error('OUTBOUND_PROXY_URL must be an http:// proxy URL without a path');
  }
  return proxy;
}

function proxyAuthorization(proxy: URL): string | undefined {
  if (!proxy.username && !proxy.password) return undefined;
  return `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`;
}

function tunnelAgent(url: URL, target: { address: string; family: number }, proxy: URL, signal?: AbortSignal): http.Agent | https.Agent {
  const agent = url.protocol === 'https:' ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false });
  const createConnection = (_options: object, callback: (error: Error | null, socket?: import('node:net').Socket) => void) => {
    let settled = false;
    let activeSocket: import('node:net').Socket | undefined;
    const finish = (error: Error | null, socket?: import('node:net').Socket) => {
      if (settled) { socket?.destroy(); return; }
      settled = true;
      signal?.removeEventListener('abort', abort);
      callback(error, socket);
    };
    const abort = () => {
      const error = new Error('Outbound proxy connection aborted');
      activeSocket?.destroy(error);
      request.destroy(error);
      finish(error);
    };
    const destinationPort = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    const authority = `${target.address}:${destinationPort}`;
    const authorization = proxyAuthorization(proxy);
    const request = http.request({
      hostname: proxy.hostname,
      port: Number(proxy.port || 80),
      method: 'CONNECT',
      path: authority,
      headers: { host: authority, ...(authorization ? { 'proxy-authorization': authorization } : {}) },
      signal,
    });
    request.once('connect', (response, socket, head) => {
      activeSocket = socket;
      if (response.statusCode !== 200) {
        socket.destroy();
        finish(new Error(`Outbound proxy CONNECT failed with status ${response.statusCode ?? 502}`));
        return;
      }
      if (head.length) socket.unshift(head);
      if (url.protocol === 'http:') { finish(null, socket); return; }
      const secureSocket = tls.connect({ socket, servername: url.hostname });
      activeSocket = secureSocket;
      secureSocket.once('secureConnect', () => finish(null, secureSocket));
      secureSocket.once('error', (error) => finish(error));
    });
    request.once('error', (error) => finish(error));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return undefined; }
    request.end();
    return undefined;
  };
  agent.createConnection = createConnection as typeof agent.createConnection;
  return agent;
}

function pinnedFetch(url: URL, init: RequestInit, target: { address: string; family: number }): Promise<Response> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const proxy = configuredProxy();
    const request = transport.request(url, {
      method: init.method ?? 'GET', headers: init.headers as http.OutgoingHttpHeaders,
      ...(proxy ? { agent: tunnelAgent(url, target, proxy, init.signal ?? undefined) } : {
        family: target.family,
        lookup: ((_hostname: string, lookupOptions: object, callback: (...args: unknown[]) => void) => {
          if ('all' in lookupOptions && lookupOptions.all) {
            callback(null, [{ address: target.address, family: target.family }]);
          } else {
            callback(null, target.address, target.family);
          }
        }) as typeof import('node:dns').lookup,
      }),
      signal: init.signal ?? undefined,
      ...(url.protocol === 'https:' ? { servername: url.hostname } : {}),
    }, (incoming) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, item);
      }
      resolve(new Response(Readable.toWeb(incoming) as ReadableStream, { status: incoming.statusCode ?? 502, headers }));
    });
    request.once('error', reject);
    request.once('socket', (socket) => socket.once('error', reject));
    request.end();
  });
}

async function pinnedFetchWithFallback(
  url: URL,
  init: RequestInit,
  addresses: readonly { address: string; family: number }[],
): Promise<Response> {
  let lastError: unknown;
  for (const target of addresses) {
    try { return await pinnedFetch(url, init, target); }
    catch (error) {
      if (init.signal?.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError ?? new Error('No upstream address available');
}

export interface ProxyRequestOptions {
  upstream: string;
  query: Record<string, string | string[] | undefined>;
  requestHeaders?: Record<string, string | string[] | undefined>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRedirects?: number;
  fetchImpl?: typeof fetch;
  resolve?: ResolveHost;
}

export interface ProxyResult { status: number; headers: Record<string, string>; body: Uint8Array; }

async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error('Upstream response is too large');
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error('Upstream response is too large');
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

export async function proxyRequest(options: ProxyRequestOptions): Promise<ProxyResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolve = options.resolve ?? defaultResolve;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxResponseBytes ?? 5 * 1024 * 1024;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.requestHeaders ?? {})) {
    if (SAFE_REQUEST_HEADERS.has(name.toLowerCase()) && typeof value === 'string') headers[name.toLowerCase()] = value;
  }
  let url = new URL(options.upstream);
  for (const [name, value] of Object.entries(options.query)) {
    if (name === 'token' || value === undefined) continue;
    url.searchParams.delete(name);
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(name, item);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let redirects = 0; ; redirects += 1) {
      const addresses = await resolveSafe(url, resolve);
      let response: Response;
      try {
        const init = { headers, redirect: 'manual' as const, signal: controller.signal };
        response = options.fetchImpl
          ? await fetchImpl(url, init)
          : await pinnedFetchWithFallback(url, init, addresses);
      } catch (error) {
        if (controller.signal.aborted) throw new ProxyTimeoutError();
        throw error;
      }
      if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
        if (redirects >= (options.maxRedirects ?? 3)) throw new Error('Too many upstream redirects');
        url = new URL(response.headers.get('location')!, url);
        continue;
      }
      const body = await readLimited(response, maxBytes);
      const responseHeaders: Record<string, string> = {};
      for (const [name, value] of response.headers) if (SAFE_RESPONSE_HEADERS.has(name.toLowerCase())) responseHeaders[name] = value;
      return { status: response.status, headers: responseHeaders, body };
    }
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof ProxyTimeoutError)) throw new ProxyTimeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
