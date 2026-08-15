import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../types.js';
import { credentialsMatch, createSession, deleteSession, getSession, SESSION_COOKIE } from '../auth/service.js';

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const MAX_TRACKED_CLIENTS = 10_000;

export interface AuthRouteOptions { db: Database.Database; config: AppConfig; secureCookies?: boolean }

export function registerAuthRoutes(app: FastifyInstance, options: AuthRouteOptions): void {
  const failures = new Map<string, { count: number; resetAt: number }>();
  const cookieOptions = { path: '/', httpOnly: true, sameSite: 'strict' as const, secure: Boolean(options.secureCookies) };
  app.post('/api/auth/login', async (request, reply) => {
    const key = request.ip; const now = Date.now();
    for (const [client, attempt] of failures) if (attempt.resetAt <= now) failures.delete(client);
    const state = failures.get(key);
    if (state && state.resetAt > now && state.count >= MAX_FAILURES) return reply.code(429).send({ error: 'Too many login attempts', code: 'LOGIN_THROTTLED' });
    const body = request.body as { username?: unknown; password?: unknown } | null;
    const username = typeof body?.username === 'string' ? body.username : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    const usernameValid = credentialsMatch(username, options.config.adminUsername, options.config.sessionSecret);
    const passwordValid = credentialsMatch(password, options.config.adminPassword, options.config.sessionSecret);
    const valid = usernameValid && passwordValid;
    if (!valid) {
      if (!failures.has(key) && failures.size >= MAX_TRACKED_CLIENTS) failures.delete(failures.keys().next().value as string);
      failures.set(key, { count: state && state.resetAt > now ? state.count + 1 : 1, resetAt: now + WINDOW_MS });
      return reply.code(401).send({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
    }
    failures.delete(key);
    const session = createSession(options.db, options.config.sessionSecret);
    return reply.setCookie(SESSION_COOKIE, session.token, { ...cookieOptions, expires: new Date(session.expiresAt) })
      .send({ authenticated: true, csrfToken: session.csrfToken, expiresAt: session.expiresAt });
  });

  app.get('/api/auth/session', async (request, reply) => {
    const session = getSession(options.db, request.cookies[SESSION_COOKIE], options.config.sessionSecret);
    if (!session) return reply.code(401).send({ authenticated: false, code: 'UNAUTHORIZED' });
    return { authenticated: true, csrfToken: session.csrfToken, expiresAt: session.expiresAt };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    const session = getSession(options.db, token, options.config.sessionSecret);
    if (!session) return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    if (request.headers['x-csrf-token'] !== session.csrfToken) return reply.code(403).send({ error: 'Invalid CSRF token', code: 'INVALID_CSRF' });
    deleteSession(options.db, token, options.config.sessionSecret);
    return reply.clearCookie(SESSION_COOKIE, cookieOptions).code(204).send();
  });
}
