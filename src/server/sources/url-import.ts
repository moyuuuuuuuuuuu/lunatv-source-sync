import { proxyRequest, type ProxyRequestOptions } from '../proxy/service.js';
import { base58DecodeUtf8 } from '../subscription/base58.js';

export type ImportUrlOptions = Pick<ProxyRequestOptions, 'fetchImpl' | 'resolve'>;

export function parseRemoteImport(body: Uint8Array): unknown {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(body).trim(); }
  catch { throw new Error('Remote import is not valid UTF-8'); }
  try { return JSON.parse(text); }
  catch {
    try { return JSON.parse(base58DecodeUtf8(text)); }
    catch { throw new Error('Remote import is neither valid JSON nor Base58 JSON'); }
  }
}

export async function fetchRemoteImport(url: string, options: ImportUrlOptions = {}): Promise<unknown> {
  const result = await proxyRequest({
    upstream: url, query: {}, requestHeaders: { accept: 'application/json, text/plain' },
    timeoutMs: 10_000, maxResponseBytes: 5 * 1024 * 1024, maxRedirects: 3, ...options,
  });
  if (result.status < 200 || result.status >= 300) throw new Error('Remote server returned an unsuccessful status');
  return parseRemoteImport(result.body);
}
