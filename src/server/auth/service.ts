import type Database from 'better-sqlite3';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'lunatv_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function digest(value: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(value).digest();
}

export function credentialsMatch(actual: string, expected: string, secret: string): boolean {
  return timingSafeEqual(digest(actual, secret), digest(expected, secret));
}

export interface Session { token: string; csrfToken: string; expiresAt: string }

export function createSession(db: Database.Database, secret: string, now = new Date()): Session {
  const token = randomBytes(32).toString('hex');
  const csrfToken = randomBytes(32).toString('hex');
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  db.transaction(() => {
    db.prepare('DELETE FROM sessions').run();
    db.prepare('INSERT INTO sessions (token_hash, csrf_token, expires_at) VALUES (?, ?, ?)')
      .run(hashSessionToken(token, secret), csrfToken, expiresAt);
  })();
  return { token, csrfToken, expiresAt };
}

export function hashSessionToken(token: string, secret: string): string {
  return createHash('sha256').update(`${secret}\0${token}`).digest('hex');
}

export function getSession(db: Database.Database, token: string | undefined, secret: string, now = new Date()): { csrfToken: string; expiresAt: string } | null {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now.toISOString());
  if (!token) return null;
  const row = db.prepare('SELECT csrf_token, expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?')
    .get(hashSessionToken(token, secret), now.toISOString()) as { csrf_token: string; expires_at: string } | undefined;
  return row ? { csrfToken: row.csrf_token, expiresAt: row.expires_at } : null;
}

export function deleteSession(db: Database.Database, token: string | undefined, secret: string): void {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashSessionToken(token, secret));
}
