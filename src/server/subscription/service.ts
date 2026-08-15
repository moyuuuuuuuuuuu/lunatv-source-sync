import type Database from 'better-sqlite3';

export interface LunaSource { name: string; api: string; detail?: string; }
export interface LunaConfig { cache_time: number; api_site: Record<string, LunaSource>; }
export type SubscriptionCategory = 'normal' | 'adult' | 'all';

interface PublicSourceRow {
  source_key: string; name: string; api: string; detail: string | null; is_adult: number;
}

export interface BuildSubscriptionOptions {
  db: Database.Database;
  cacheTime: number;
  failureThreshold: number;
  source?: SubscriptionCategory;
  proxy?: boolean;
  baseUrl?: string;
  token?: string;
}

export function buildSubscription(options: BuildSubscriptionOptions): LunaConfig {
  const category = options.source ?? 'normal';
  const categoryClause = category === 'all' ? '' : 'AND is_adult = @isAdult';
  const rows = options.db.prepare(`SELECT source_key, name, api, detail, is_adult FROM sources
    WHERE enabled = 1 AND (ignore_health_check = 1 OR health_status != 'unhealthy'
      OR consecutive_failures < @failureThreshold) ${categoryClause}
    ORDER BY source_key`).all({ failureThreshold: options.failureThreshold, isAdult: Number(category === 'adult') }) as PublicSourceRow[];
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
