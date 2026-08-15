import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type Database from 'better-sqlite3';
import Fastify from 'fastify';
import { migrate, openDatabase } from '../src/server/db.js';
import { registerPublicRoutes } from '../src/server/routes/public.js';
import { createSource } from '../src/server/sources/repository.js';
import { base58DecodeUtf8, base58EncodeUtf8 } from '../src/server/subscription/base58.js';
import { buildSubscription } from '../src/server/subscription/service.js';

describe('subscriptions', () => {
  test('strictly decodes Bitcoin Base58 UTF-8', () => {
    expect(base58DecodeUtf8('2xuZUfBKa')).toBe('你好');
    expect(base58DecodeUtf8(base58EncodeUtf8('\0hello'))).toBe('\0hello');
    expect(() => base58DecodeUtf8('0OIl')).toThrow(/base58/i);
    expect(() => base58DecodeUtf8('5Q')).toThrow(/utf-8/i);
  });
  let db: Database.Database;
  beforeEach(() => { db = openDatabase(':memory:'); migrate(db); });
  afterEach(() => db.close());

  test('filters category, enabled state, and failure threshold and emits public fields only', () => {
    createSource(db, { sourceKey: 'normal', name: 'Normal', api: 'https://public.example/api', classificationMode: 'normal' });
    createSource(db, { sourceKey: 'adult', name: 'Adult', api: 'https://adult.example/api', classificationMode: 'adult' });
    const failed = createSource(db, { sourceKey: 'failed', name: 'Failed', api: 'https://failed.example/api' });
    createSource(db, { sourceKey: 'off', name: 'Off', api: 'https://off.example/api', enabled: false });
    db.prepare("UPDATE sources SET health_status = 'unhealthy', consecutive_failures = 3 WHERE id = ?").run(failed.id);

    expect(Object.keys(buildSubscription({ db, cacheTime: 7200, failureThreshold: 3 }).api_site)).toEqual(['normal']);
    expect(Object.keys(buildSubscription({ db, cacheTime: 7200, failureThreshold: 3, source: 'adult' }).api_site)).toEqual(['adult']);
    expect(Object.keys(buildSubscription({ db, cacheTime: 7200, failureThreshold: 3, source: 'all' }).api_site)).toEqual(['adult', 'normal']);
    expect(buildSubscription({ db, cacheTime: 7200, failureThreshold: 3 }).api_site.normal).toEqual({ name: 'Normal', api: 'https://public.example/api' });
  });

  test('encodes UTF-8 with Bitcoin Base58 and rewrites proxy URLs', () => {
    expect(base58EncodeUtf8('你好')).toBe('2xuZUfBKa');
    createSource(db, { sourceKey: 'a/b', name: 'A', api: 'https://public.example/api', classificationMode: 'normal' });
    expect(buildSubscription({ db, cacheTime: 60, failureThreshold: 3, proxy: true, baseUrl: 'https://sync.example/root', token: 'secret' }).api_site['a/b'].api)
      .toBe('https://sync.example/api/proxy/a%2Fb?token=secret');
  });

  test('validates public route query, token, output format, and preflight', async () => {
    createSource(db, { sourceKey: 'normal', name: 'Normal', api: 'https://public.example/api' });
    const app = Fastify();
    registerPublicRoutes(app, { db, subscriptionToken: 'secret' });
    expect((await app.inject('/api/source')).statusCode).toBe(401);
    expect((await app.inject('/api/source?token=secret&ac=no')).statusCode).toBe(400);
    expect((await app.inject('/api/source?token=secret&source=no')).statusCode).toBe(400);
    expect((await app.inject('/api/source?token=secret&format=no')).statusCode).toBe(400);
    expect((await app.inject('/api/source?token=secret&proxy=no')).statusCode).toBe(400);
    const json = await app.inject('/api/source?token=secret');
    expect(json.statusCode).toBe(200);
    expect(json.headers['access-control-allow-origin']).toBe('*');
    expect(json.json()).toMatchObject({ cache_time: 7200, api_site: { normal: { name: 'Normal' } } });
    const encoded = await app.inject('/api/source?token=secret&format=base58');
    expect(encoded.body).toBe(base58EncodeUtf8(JSON.stringify(json.json())));
    const preflight = await app.inject({ method: 'OPTIONS', url: '/api/source' });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('*');
    await app.close();
  });
});
