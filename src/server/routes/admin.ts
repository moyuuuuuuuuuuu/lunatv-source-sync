import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { adminPasswordMatches, getSession, hashAdminPassword, SESSION_COOKIE } from '../auth/service.js';
import { getHealthSettings } from '../health/repository.js';
import type { SchedulerHandle } from '../health/scheduler.js';
import { applyImport, previewImport, type DuplicateApiPolicy } from '../sources/import.js';
import { fetchRemoteImport, type ImportUrlOptions } from '../sources/url-import.js';
import { bulkSetEnabled, createSource, deleteSource, deleteSources, deleteUnhealthySources, getSourceByApi, getSourceById, listSources, updateSource, type CreateSourceInput, type UpdateSourceInput } from '../sources/repository.js';
import type { AppConfig, HealthStatus } from '../types.js';
import { resetSubscriptionToken } from '../subscription/token.js';

export interface AdminRouteOptions { db: Database.Database; config: AppConfig; scheduler: SchedulerHandle; importUrlOptions?: ImportUrlOptions }
function positiveInteger(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null;
}
function idParam(request: FastifyRequest): number | null { return positiveInteger(Number((request.params as { id: string }).id), 1, Number.MAX_SAFE_INTEGER); }
function ids(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) return null;
  const parsed = value.map(Number); return parsed.every((id) => Number.isInteger(id) && id > 0) ? [...new Set(parsed)] : null;
}
const SOURCE_FIELDS = new Set(['sourceKey', 'name', 'api', 'detail', 'comment', 'classificationMode', 'enabled', 'ignoreHealthCheck']);
function sourceInput(value: unknown, create: true): CreateSourceInput | null;
function sourceInput(value: unknown, create: false): UpdateSourceInput | null;
function sourceInput(value: unknown, create: boolean): CreateSourceInput | UpdateSourceInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>; const keys = Object.keys(body);
  if (keys.some((key) => !SOURCE_FIELDS.has(key)) || (!create && keys.length === 0)) return null;
  if (create && !['sourceKey', 'name', 'api'].every((field) => Object.hasOwn(body, field))) return null;
  for (const field of ['sourceKey', 'name'] as const) {
    if (body[field] !== undefined && (typeof body[field] !== 'string' || !body[field].trim())) return null;
  }
  if (body.api !== undefined) {
    if (typeof body.api !== 'string' || !body.api.trim()) return null;
    try { const url = new URL(body.api); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null; } catch { return null; }
  }
  for (const field of ['detail', 'comment'] as const) if (body[field] !== undefined && body[field] !== null && typeof body[field] !== 'string') return null;
  if (body.classificationMode !== undefined && !['auto', 'adult', 'normal'].includes(String(body.classificationMode))) return null;
  for (const field of ['enabled', 'ignoreHealthCheck'] as const) if (body[field] !== undefined && typeof body[field] !== 'boolean') return null;
  return Object.fromEntries(keys.map((key) => [key, body[key]])) as unknown as CreateSourceInput | UpdateSourceInput;
}
function queryInteger(value: unknown, fallback: number, max: number): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed <= max ? parsed : null;
}

export function registerAdminRoutes(app: FastifyInstance, options: AdminRouteOptions): void {
  app.addHook('preHandler', async (request, reply) => {
    const session = getSession(options.db, request.cookies[SESSION_COOKIE], options.config.sessionSecret);
    if (!session) return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers['x-csrf-token'] !== session.csrfToken) {
      return reply.code(403).send({ error: 'Invalid CSRF token', code: 'INVALID_CSRF' });
    }
  });

  app.get('/dashboard', async () => {
    const row = options.db.prepare(`SELECT count(*) total, sum(is_adult = 0) normal, sum(is_adult = 1) adult,
      sum(health_status = 'healthy') healthy, sum(health_status = 'unhealthy') unhealthy,
      sum(health_status = 'unknown') unknown FROM sources`).get() as Record<string, number | null>;
    return { total: row.total ?? 0, normal: row.normal ?? 0, adult: row.adult ?? 0, healthy: row.healthy ?? 0, unhealthy: row.unhealthy ?? 0, unknown: row.unknown ?? 0, nextCheckAt: getHealthSettings(options.db).nextCheckAt };
  });
  app.get('/sources', async (request, reply) => {
    const q = request.query as Record<string, unknown>;
    if (Object.keys(q).some((key) => !['search', 'classification', 'healthStatus', 'enabled', 'page', 'pageSize', 'sort'].includes(key))) return reply.code(400).send({ error: 'Invalid filters', code: 'INVALID_INPUT' });
    const classification = typeof q.classification === 'string' && ['adult', 'normal'].includes(q.classification) ? q.classification as 'adult' | 'normal' : undefined;
    const healthStatus = typeof q.healthStatus === 'string' && ['unknown', 'healthy', 'unhealthy'].includes(q.healthStatus) ? q.healthStatus as HealthStatus : undefined;
    const sort = typeof q.sort === 'string' && ['latencyAsc', 'latencyDesc'].includes(q.sort) ? q.sort as 'latencyAsc' | 'latencyDesc' : undefined;
    const page = queryInteger(q.page, 1, 1_000_000); const pageSize = queryInteger(q.pageSize, 50, 200);
    if (q.search !== undefined && typeof q.search !== 'string' || q.classification !== undefined && !classification || q.healthStatus !== undefined && !healthStatus || q.enabled !== undefined && !['true', 'false'].includes(String(q.enabled)) || q.sort !== undefined && !sort || page === null || pageSize === null) return reply.code(400).send({ error: 'Invalid filters', code: 'INVALID_INPUT' });
    return listSources(options.db, { search: q.search as string | undefined, classification, healthStatus, enabled: q.enabled === undefined ? undefined : q.enabled === 'true', page, pageSize, sort });
  });
  app.post('/sources', async (request, reply) => {
    const body = request.body as Record<string, unknown> | null;
    const duplicateApiPolicy = body?.duplicateApiPolicy;
    if (duplicateApiPolicy !== undefined && !['skip', 'overwrite'].includes(String(duplicateApiPolicy))) return reply.code(400).send({ error: 'Invalid duplicate API policy', code: 'INVALID_INPUT' });
    const sourceBody = body && Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'duplicateApiPolicy'));
    const input = sourceInput(sourceBody, true); if (!input) return reply.code(400).send({ error: 'Invalid source', code: 'INVALID_SOURCE' });
    const duplicate = getSourceByApi(options.db, input.api);
    if (duplicate) {
      if ((duplicateApiPolicy ?? 'skip') === 'skip') return { ...duplicate, duplicateAction: 'skipped' };
      const overwritten = updateSource(options.db, duplicate.id, { ...input, sourceKey: duplicate.sourceKey, extraKeywords: options.config.adultKeywordsExtra });
      return { ...overwritten, duplicateAction: 'overwritten' };
    }
    try { return reply.code(201).send(createSource(options.db, { ...input, extraKeywords: options.config.adultKeywordsExtra })); }
    catch { return reply.code(400).send({ error: 'Invalid or duplicate source', code: 'INVALID_SOURCE' }); }
  });
  app.put('/sources/:id', async (request, reply) => {
    const id = idParam(request); if (!id) return reply.code(400).send({ error: 'Invalid source id', code: 'INVALID_INPUT' });
    const input = sourceInput(request.body, false); if (!input) return reply.code(400).send({ error: 'Invalid source', code: 'INVALID_SOURCE' });
    try { const source = updateSource(options.db, id, { ...input, extraKeywords: options.config.adultKeywordsExtra }); return source ?? reply.code(404).send({ error: 'Source not found', code: 'NOT_FOUND' }); }
    catch { return reply.code(400).send({ error: 'Invalid or duplicate source', code: 'INVALID_SOURCE' }); }
  });
  app.delete('/sources/:id', async (request, reply) => { const id = idParam(request); if (!id) return reply.code(400).send({ error: 'Invalid source id', code: 'INVALID_INPUT' }); return deleteSource(options.db, id) ? reply.code(204).send() : reply.code(404).send({ error: 'Source not found', code: 'NOT_FOUND' }); });
  app.post('/sources/bulk', async (request, reply) => {
    const body = request.body as { ids?: unknown; action?: unknown }; const sourceIds = ids(body?.ids);
    if (!sourceIds || !['enable', 'disable', 'delete', 'check'].includes(String(body?.action))) return reply.code(400).send({ error: 'Invalid bulk action', code: 'INVALID_INPUT' });
    if (body.action === 'check') return options.scheduler.checkSources(sourceIds);
    return { affected: body.action === 'delete' ? deleteSources(options.db, sourceIds) : bulkSetEnabled(options.db, sourceIds, body.action === 'enable') };
  });
  app.post('/sources/remove-unhealthy', async () => ({ affected: deleteUnhealthySources(options.db) }));
  app.post('/sources/:id/check', async (request, reply) => { const id = idParam(request); if (!id) return reply.code(400).send({ error: 'Invalid source id', code: 'INVALID_INPUT' }); if (!getSourceById(options.db, id)) return reply.code(404).send({ error: 'Source not found', code: 'NOT_FOUND' }); return options.scheduler.checkSources([id]); });
  app.get('/sources/:id/health', async (request, reply) => { const id = idParam(request); if (!id) return reply.code(400).send({ error: 'Invalid source id', code: 'INVALID_INPUT' }); if (!getSourceById(options.db, id)) return reply.code(404).send({ error: 'Source not found', code: 'NOT_FOUND' }); return { items: options.db.prepare('SELECT status, latency_ms latencyMs, error_code errorCode, error_message errorMessage, checked_at checkedAt FROM health_checks WHERE source_id = ? ORDER BY checked_at DESC, id DESC LIMIT 30').all(id) }; });
  app.post('/health/check', async () => options.scheduler.runNow());
  const importCounts = (entries: Array<{ sourceKey: string }>) => {
    const exists = options.db.prepare('SELECT 1 FROM sources WHERE source_key = ?');
    const updated = entries.reduce((count, entry) => count + Number(Boolean(exists.get(entry.sourceKey))), 0);
    return { inserted: entries.length - updated, updated };
  };
  app.post('/import/preview', async (request, reply) => { try { const preview = previewImport(request.body, options.config.adultKeywordsExtra); return { ...preview, ...importCounts(preview.entries), invalid: preview.errors.length }; } catch { return reply.code(422).send({ error: 'api_site must be an object', code: 'INVALID_IMPORT' }); } });
  app.post('/import/url-preview', async (request, reply) => {
    const body = request.body as { url?: unknown } | null;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.url !== 'string') return reply.code(400).send({ error: 'Invalid import URL', code: 'INVALID_URL' });
    let url: URL;
    try { url = new URL(body.url); } catch { return reply.code(400).send({ error: 'Invalid import URL', code: 'INVALID_URL' }); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return reply.code(400).send({ error: 'Invalid import URL', code: 'INVALID_URL' });
    try {
      const document = await fetchRemoteImport(url.toString(), options.importUrlOptions);
      const preview = previewImport(document, options.config.adultKeywordsExtra);
      return { ...preview, ...importCounts(preview.entries), invalid: preview.errors.length, document };
    } catch {
      return reply.code(422).send({ error: 'Unable to fetch or parse remote import', code: 'INVALID_REMOTE_IMPORT' });
    }
  });
  app.post('/import/apply', async (request, reply) => { try {
    const body = request.body as { document?: unknown; duplicateApiPolicy?: unknown };
    const wrapped = body && typeof body === 'object' && Object.hasOwn(body, 'document');
    const policy = (wrapped ? body.duplicateApiPolicy : 'skip') as DuplicateApiPolicy;
    if (!['skip', 'overwrite'].includes(policy)) return reply.code(400).send({ error: 'Invalid duplicate API policy', code: 'INVALID_INPUT' });
    const preview = previewImport(wrapped ? body.document : request.body, options.config.adultKeywordsExtra);
    return { ...applyImport(options.db, preview, policy), invalid: preview.errors.length, errors: preview.errors };
  } catch { return reply.code(422).send({ error: 'api_site must be an object', code: 'INVALID_IMPORT' }); } });
  app.get('/settings', async () => getHealthSettings(options.db));
  app.put('/settings', async (request, reply) => {
    const body = request.body as Record<string, unknown> | null; const entries = [
      ['check_interval_hours', 'checkIntervalHours', 1, 8760], ['request_timeout_ms', 'requestTimeoutMs', 100, 300000],
      ['failure_threshold', 'failureThreshold', 1, 100], ['cache_time', 'cacheTime', 1, 31536000],
    ] as const;
    const fields = entries.map(([, field]) => field);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== fields.length || Object.keys(body).some((key) => !fields.includes(key as typeof fields[number]))) return reply.code(400).send({ error: 'Invalid settings', code: 'INVALID_INPUT' });
    const parsed = entries.map(([key, field, min, max]) => [key, positiveInteger(body[field], min, max)] as const);
    if (parsed.some(([, value]) => value === null)) return reply.code(400).send({ error: 'Invalid settings', code: 'INVALID_INPUT' });
    options.db.transaction(() => { const statement = options.db.prepare('UPDATE settings SET setting_value = ?, updated_at = CURRENT_TIMESTAMP WHERE setting_key = ?'); for (const [key, value] of parsed) statement.run(String(value), key); })();
    options.scheduler.reschedule(); return getHealthSettings(options.db);
  });
  app.get('/subscription-examples', async (request) => {
    const base = `${request.protocol}://${request.host}/api/source`; const make = (source: string, format: string, proxy: number) => `${base}?ac=list&source=${source}&format=${format}&proxy=${proxy}${options.config.subscriptionToken ? `&token=${encodeURIComponent(options.config.subscriptionToken)}` : ''}`;
    return { normalJson: make('normal', 'json', 0), allBase58: make('all', 'base58', 0), normalProxy: make('normal', 'json', 1), tokenRequired: true, tokenCanReset: true };
  });
  app.post('/subscription-token/reset', async (_request, reply) => {
    options.config.subscriptionToken = resetSubscriptionToken(options.db);
    return { reset: true };
  });
  app.post('/password/change', async (request, reply) => {
    const body = request.body as { currentPassword?: unknown; newPassword?: unknown } | null;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 2 || typeof body.currentPassword !== 'string' || typeof body.newPassword !== 'string' || body.newPassword.length < 10 || body.newPassword.length > 128) {
      return reply.code(400).send({ error: 'Password must be between 10 and 128 characters', code: 'INVALID_PASSWORD' });
    }
    const currentPassword = body.currentPassword; const newPassword = body.newPassword;
    if (!adminPasswordMatches(options.db, currentPassword, options.config.adminPassword, options.config.sessionSecret)) return reply.code(403).send({ error: 'Current password is incorrect', code: 'INVALID_CURRENT_PASSWORD' });
    options.db.transaction(() => {
      options.db.prepare("UPDATE settings SET setting_value = ?, updated_at = CURRENT_TIMESTAMP WHERE setting_key = 'admin_password_hash'").run(hashAdminPassword(newPassword, options.config.sessionSecret));
      options.db.prepare('DELETE FROM sessions').run();
    })();
    return reply.code(204).send();
  });
}
