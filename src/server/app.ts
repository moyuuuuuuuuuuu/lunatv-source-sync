import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { AppConfig } from './types.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerPublicRoutes } from './routes/public.js';
import { startScheduler, type SchedulerOptions } from './health/scheduler.js';

export interface BuildAppOptions {
  db: Database.Database; config: AppConfig; secureCookies?: boolean; startHealthScheduler?: boolean; healthOptions?: SchedulerOptions;
}
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  registerAuthRoutes(app, options);
  registerPublicRoutes(app, { db: options.db, subscriptionToken: options.config.subscriptionToken });
  const scheduler = startScheduler(options.db, options.healthOptions);
  if (options.startHealthScheduler === false) scheduler.stop();
  await app.register(async (admin) => registerAdminRoutes(admin, { db: options.db, config: options.config, scheduler }), { prefix: '/api/admin' });
  app.get('/health', async () => ({ status: 'ok' }));
  app.addHook('onClose', async () => scheduler.stop());
  await app.ready();
  return app;
}
