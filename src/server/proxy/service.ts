import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { isUnsafeAddress } from './safety.js';

export type ResolveHost = (hostname: string) => Promise<readonly { address: string; family: number }[]>;
type LookupHost = typeof lookup;
type DohFetch = typeof fetch;

interface DohResponse {
  Status?: number;
  Answer?: Array<{ type?: number; data?: string }>;
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
  if (local.length && local.every(({ address }) => !isUnsafeAddress(address))) return local;
  try {
    const publicAnswers = await resolveWithDoh(hostname, dohFetch);
    return publicAnswers.length ? publicAnswers : local;
  } catch {
    return local;
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

function pinnedFetch(url: URL, init: RequestInit, target: { address: string; family: number }): Promise<Response> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, {
      method: init.method ?? 'GET', headers: init.headers as http.OutgoingHttpHeaders,
      lookup: ((_hostname: string, lookupOptions: object, callback: (...args: unknown[]) => void) => {
        if ('all' in lookupOptions && lookupOptions.all) {
          callback(null, [{ address: target.address, family: target.family }]);
        } else {
          callback(null, target.address, target.family);
        }
      }) as typeof import('node:dns').lookup,
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
