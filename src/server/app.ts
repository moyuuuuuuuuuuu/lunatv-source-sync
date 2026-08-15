import cookie from '@fastify/cookie';
import staticPlugin from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AppConfig } from './types.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerPublicRoutes } from './routes/public.js';
import { startScheduler, type SchedulerOptions } from './health/scheduler.js';
import type { ImportUrlOptions } from './sources/url-import.js';
import { ensureSubscriptionToken } from './subscription/token.js';

export interface BuildAppOptions {
  db: Database.Database; config: AppConfig; secureCookies?: boolean; startHealthScheduler?: boolean; healthOptions?: SchedulerOptions; importUrlOptions?: ImportUrlOptions;
}
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  options.config.subscriptionToken = ensureSubscriptionToken(options.db);
  const app = Fastify({
    logger: false,
    trustProxy: options.config.trustProxy,
    bodyLimit: 6 * 1024 * 1024,
  });
  app.addHook('onRequest', async (request) => {
    // Browsers and reverse proxies may add Content-Length: 0 to bodyless POSTs.
    // Fastify otherwise tries to select a body parser and rejects the request
    // with FST_ERR_CTP_INVALID_MEDIA_TYPE when Content-Type is absent.
    if (request.headers['content-length'] === '0' && !request.headers['content-type'] && !request.headers['transfer-encoding']) {
      delete request.headers['content-length'];
    }
  });
  await app.register(cookie);
  registerAuthRoutes(app, { ...options, secureCookies: options.secureCookies ?? options.config.secureCookies });
  registerPublicRoutes(app, { db: options.db, subscriptionToken: () => options.config.subscriptionToken });
  const scheduler = startScheduler(options.db, options.healthOptions);
  if (options.startHealthScheduler === false) scheduler.stop();
  await app.register(async (admin) => registerAdminRoutes(admin, { db: options.db, config: options.config, scheduler, importUrlOptions: options.importUrlOptions }), { prefix: '/api/admin' });
  app.get('/health', async () => ({ status: 'ok' }));
  const clientRoot = resolve(process.cwd(), 'dist/client');
  if (existsSync(resolve(clientRoot, 'index.html'))) {
    await app.register(staticPlugin, { root: clientRoot, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/') && request.url !== '/health') return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' });
    });
  }
  app.addHook('onClose', async () => scheduler.stop());
  await app.ready();
  return app;
}
