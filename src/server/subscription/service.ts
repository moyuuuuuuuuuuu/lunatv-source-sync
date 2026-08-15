import type Database from 'better-sqlite3';

export interface LunaSource { name: string; api: string; detail?: string; }
export interface LunaConfig { cache_time: number; api_site: Record<string, LunaSource>; }
export type SubscriptionCategory = 'normal' | 'adult' | 'all';
export type SubscriptionContentCategory = 'general' | 'movie' | 'short_drama' | 'all';
export type SubscriptionSourceType = 'vod_api' | 'live_m3u' | 'tvbox' | 'navigation' | 'all';

interface PublicSourceRow {
  source_key: string; name: string; api: string; detail: string | null; is_adult: number;
}

export interface BuildSubscriptionOptions {
  db: Database.Database;
  cacheTime: number;
  failureThreshold: number;
  source?: SubscriptionCategory;
  contentCategory?: SubscriptionContentCategory;
  proxy?: boolean;
  baseUrl?: string;
  token?: string;
}

export function buildSubscription(options: BuildSubscriptionOptions): LunaConfig {
  const category = options.source ?? 'normal';
  const categoryClause = category === 'all' ? '' : 'AND is_adult = @isAdult';
  const contentClause = !options.contentCategory || options.contentCategory === 'all' ? '' : 'AND content_category = @contentCategory';
  const rows = options.db.prepare(`SELECT source_key, name, api, detail, is_adult FROM sources
    WHERE source_type = 'vod_api' AND enabled = 1 AND (ignore_health_check = 1 OR health_status != 'unhealthy'
      OR consecutive_failures < @failureThreshold) ${categoryClause} ${contentClause}
    ORDER BY source_key`).all({ failureThreshold: options.failureThreshold, isAdult: Number(category === 'adult'), contentCategory: options.contentCategory }) as PublicSourceRow[];
  const api_site: Record<string, LunaSource> = {};
  for (const row of rows) {
    let api = row.api;
    if (options.proxy) {
      if (!options.baseUrl) throw new Error('baseUrl is required when proxy is enabled');
      const url = new URL(`/api/proxy/${encodeURIComponent(row.source_key)}`, options.baseUrl);
      if (options.token) url.searchParams.set('token', options.token);
      api = url.toString();
    }
    api_site[row.source_key] = {
      name: row.name,
      api,
      ...(row.detail ? { detail: row.detail } : {}),
    };
  }
  return { cache_time: options.cacheTime, api_site };
}

export function buildSourceCatalog(options: BuildSubscriptionOptions & { sourceType: Exclude<SubscriptionSourceType, 'vod_api' | 'all'> }): {
  type: string; sources: Array<{ key: string; name: string; url: string; category: string }>;
} {
  const category = options.source ?? 'normal';
  const categoryClause = category === 'all' ? '' : 'AND is_adult = @isAdult';
  const contentClause = !options.contentCategory || options.contentCategory === 'all' ? '' : 'AND content_category = @contentCategory';
  const rows = options.db.prepare(`SELECT source_key, name, api, content_category FROM sources
    WHERE source_type = @sourceType AND enabled = 1 AND (ignore_health_check = 1 OR health_status != 'unhealthy'
      OR consecutive_failures < @failureThreshold) ${categoryClause} ${contentClause} ORDER BY source_key`)
    .all({ sourceType: options.sourceType, failureThreshold: options.failureThreshold, isAdult: Number(category === 'adult'), contentCategory: options.contentCategory }) as Array<{ source_key: string; name: string; api: string; content_category: string }>;
  return {
    type: options.sourceType,
    sources: rows.map((row) => ({
      key: row.source_key,
      name: row.name,
      url: options.proxy && options.baseUrl && options.token
        ? `${options.baseUrl}/api/proxy/${encodeURIComponent(row.source_key)}?token=${encodeURIComponent(options.token)}`
        : row.api,
      category: row.content_category,
    })),
  };
}

export function buildAllSourceCatalog(options: BuildSubscriptionOptions): {
  cache_time: number;
  api_site: Record<string, LunaSource>;
  lives: Record<string, { name: string; url: string }>;
} {
  const vod = buildSubscription(options);
  const live = buildSourceCatalog({ ...options, sourceType: 'live_m3u' });
  return {
    cache_time: vod.cache_time,
    api_site: vod.api_site,
    lives: Object.fromEntries(live.sources.map((source) => [source.key, { name: source.name, url: source.url }])),
  };
}
