import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { getSourceByKey } from '../sources/repository.js';
import { ProxyTimeoutError, proxyRequest, type ProxyRequestOptions } from '../proxy/service.js';
import { base58EncodeUtf8 } from '../subscription/base58.js';
import { buildSourceCatalog, buildSubscription, type SubscriptionCategory, type SubscriptionContentCategory, type SubscriptionSourceType } from '../subscription/service.js';

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'Accept, Content-Type',
};

function cors(reply: FastifyReply): FastifyReply {
  return reply.headers(CORS_HEADERS);
}

function setting(db: Database.Database, key: string, fallback: number): number {
  const row = db.prepare('SELECT setting_value FROM settings WHERE setting_key = ?').get(key) as { setting_value: string } | undefined;
  const parsed = Number(row?.setting_value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function first(value: unknown): string | undefined {
  return typeof value === 'string' ? value : Array.isArray(value) && typeof value[0] === 'string' ? value[0] : undefined;
}

function authorized(query: Record<string, unknown>, token?: string): boolean {
  return !token || first(query.token) === token;
}

export interface PublicRouteOptions {
  db: Database.Database;
  subscriptionToken?: string | (() => string | undefined);
  fetchImpl?: typeof fetch;
  resolve?: ProxyRequestOptions['resolve'];
  maxProxyResponseBytes?: number;
}

function subscriptionToken(options: PublicRouteOptions): string | undefined {
  return typeof options.subscriptionToken === 'function'
    ? options.subscriptionToken()
    : options.subscriptionToken;
}

export function registerPublicRoutes(app: FastifyInstance, options: PublicRouteOptions): void {
  app.options('/api/source', async (_request, reply) => cors(reply).code(204).send());
  app.options('/api/proxy/:sourceKey', async (_request, reply) => cors(reply).code(204).send());

  app.get('/api/source', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const token = subscriptionToken(options);
    if (!authorized(query, token)) return cors(reply).code(401).send({ error: 'Unauthorized' });
    const ac = first(query.ac);
    const source = first(query.source) ?? 'normal';
    const format = first(query.format) ?? 'json';
    const type = first(query.type) ?? 'vod_api';
    const category = first(query.category) ?? 'all';
    const proxy = first(query.proxy) ?? '0';
    if ((ac && (ac !== 'list' || type !== 'vod_api')) || !['normal', 'adult', 'all'].includes(source)
      || !['vod_api', 'live_m3u', 'tvbox', 'navigation'].includes(type) || !['general', 'movie', 'short_drama', 'all'].includes(category)
      || !['json', 'base58'].includes(format) || !['0', '1'].includes(proxy)) {
      return cors(reply).code(400).send({ error: 'Invalid subscription parameters' });
    }
    const common = {
      db: options.db,
      cacheTime: setting(options.db, 'cache_time', 7200),
      failureThreshold: setting(options.db, 'failure_threshold', 3),
      contentCategory: category as SubscriptionContentCategory,
      source: source as SubscriptionCategory,
      proxy: proxy === '1',
      baseUrl: `${request.protocol}://${request.host}`,
      token,
    };
    const config = type === 'vod_api' ? buildSubscription(common) : buildSourceCatalog({ ...common, sourceType: type as Exclude<SubscriptionSourceType, 'vod_api'> });
    const json = JSON.stringify(config);
    cors(reply);
    if (format === 'base58') return reply.type('text/plain; charset=utf-8').send(base58EncodeUtf8(json));
    return reply.type('application/json; charset=utf-8').send(json);
  });

  app.get('/api/proxy/:sourceKey', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    if (!authorized(query, subscriptionToken(options))) return cors(reply).code(401).send({ error: 'Unauthorized' });
    const sourceKey = (request.params as { sourceKey: string }).sourceKey;
    const source = getSourceByKey(options.db, sourceKey);
    if (!source || !source.enabled) return cors(reply).code(404).send({ error: 'Source not found' });
    const forwardedQuery: Record<string, string | string[] | undefined> = {};
    for (const [name, value] of Object.entries(query)) {
      if (typeof value === 'string' || (Array.isArray(value) && value.every((item) => typeof item === 'string'))) {
        forwardedQuery[name] = value as string | string[];
      }
    }
    try {
      const result = await proxyRequest({
        upstream: source.api,
        query: forwardedQuery,
        requestHeaders: request.headers,
        timeoutMs: setting(options.db, 'request_timeout_ms', 10_000),
        maxResponseBytes: options.maxProxyResponseBytes,
        fetchImpl: options.fetchImpl,
        resolve: options.resolve,
      });
      return cors(reply).code(result.status).headers(result.headers).send(Buffer.from(result.body));
    } catch (error) {
      if (error instanceof ProxyTimeoutError) return cors(reply).code(504).send({ error: 'Upstream request timed out' });
      return cors(reply).code(502).send({ error: 'Upstream request failed' });
    }
  });
}
