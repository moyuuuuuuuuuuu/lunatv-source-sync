import type { ResolveHost } from '../proxy/service.js';
import { ProxyTimeoutError, proxyRequest } from '../proxy/service.js';
import type { Settings, SourceRecord } from '../types.js';

export interface CheckResult {
  status: 'healthy' | 'unhealthy';
  latencyMs: number;
  checkedAt: string;
  errorCode: string | null;
  errorMessage: string | null;
  attempts: number;
}

export interface CheckOptions {
  fetchImpl?: typeof fetch;
  resolve?: ResolveHost;
  now?: () => Date;
  maxRetries?: number;
}

function validBody(body: Uint8Array, contentType: string | null): boolean {
  const text = new TextDecoder().decode(body).trim();
  if (!text) return false;
  const jsonLike = contentType?.toLowerCase().includes('json') || /^[{[]/.test(text);
  if (jsonLike) {
    try {
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== 'object') return false;
      if (Array.isArray(value)) return true;
      const record = value as Record<string, unknown>;
      return Array.isArray(record.list) || Array.isArray(record.data) ||
        (typeof record.code === 'number' && ('list' in record || 'data' in record));
    } catch { return false; }
  }
  const root = text.match(/^(?:<\?xml[^>]*>\s*)?<(rss|list|video|videos)\b/i)?.[1];
  if (!root || !(new RegExp(`</${root}>\\s*$`, 'i').test(text) || /\/\>\s*$/.test(text))) return false;
  return /^(list|video|videos)$/i.test(root) || /<(list|video|videos)\b/i.test(text);
}

function errorDetails(error: unknown): { code: string; message: string } {
  if (error instanceof ProxyTimeoutError) return { code: 'timeout', message: error.message };
  if (error instanceof Error) {
    const code = error.message.startsWith('Invalid response body') ? 'invalid_response'
      : error.message.startsWith('HTTP ') ? 'upstream_http' : 'request_failed';
    return { code, message: error.message.slice(0, 600) };
  }
  return { code: 'request_failed', message: 'Unknown health check error' };
}

function responseExcerpt(body: Uint8Array): string {
  const text = new TextDecoder().decode(body).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 500) : '(empty response)';
}

export async function checkSource(
  source: SourceRecord,
  settings: Settings,
  options: CheckOptions = {},
): Promise<CheckResult> {
  const now = options.now ?? (() => new Date());
  const started = Date.now();
  const maxAttempts = Math.max(1, Math.min(3, (options.maxRetries ?? 2) + 1));
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await proxyRequest({
        upstream: source.api, query: { ac: 'list' }, timeoutMs: settings.requestTimeoutMs,
        maxResponseBytes: 2 * 1024 * 1024, fetchImpl: options.fetchImpl, resolve: options.resolve,
      });
      if (result.status < 200 || result.status >= 300) throw new Error(`HTTP ${result.status}: ${responseExcerpt(result.body)}`);
      if (!validBody(result.body, result.headers['content-type'] ?? null)) throw new Error(`Invalid response body: ${responseExcerpt(result.body)}`);
      return { status: 'healthy', latencyMs: Math.max(0, Date.now() - started), checkedAt: now().toISOString(), errorCode: null, errorMessage: null, attempts: attempt };
    } catch (error) { lastError = error; }
  }
  const detail = errorDetails(lastError);
  return { status: 'unhealthy', latencyMs: Math.max(0, Date.now() - started), checkedAt: now().toISOString(), errorCode: detail.code, errorMessage: detail.message, attempts: maxAttempts };
}
