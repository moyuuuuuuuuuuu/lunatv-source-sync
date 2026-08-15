# LunaTV Source Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Dockerized LunaTV source manager with JSON import, adult filtering, health checks, Base58 subscriptions, token protection, and a controlled CORS proxy.

**Architecture:** A TypeScript/Fastify server owns SQLite persistence, scheduling, subscriptions, proxying, and management APIs. A Vue 3 SPA is built into static assets served by Fastify; one `linux/amd64` container persists only `/app/data`.

**Tech Stack:** Node.js 22, TypeScript, Fastify, better-sqlite3, Vue 3, Vite, Vitest, Docker

**Spec:** `docs/superpowers/specs/2026-08-15-lunatv-source-sync-design.md`

## Global Constraints

- Build only for `linux/amd64`.
- Keep administrator credentials in environment variables; generate and persist a resettable subscription token.
- Persist source data, settings, and health history in `/app/data/app.db`.
- Never expose an arbitrary-URL proxy; proxy only enabled sources stored in SQLite.
- Publish new and not-yet-checked sources; hide a source after the configured consecutive-failure threshold; restore it after success.
- Track only required source, migration, test, Docker, example configuration, and documentation files.
- Prefer the fastest maintainable implementation; test high-risk behavior and the Docker/API path rather than cosmetic UI details.

---

### Task 1: Project shell, configuration, and SQLite schema

**Files:**
- Create: `.gitignore`
- Create: `.env.example`
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `src/server/config.ts`
- Create: `src/server/db.ts`
- Create: `src/server/schema.sql`
- Create: `src/server/types.ts`
- Test: `tests/db.test.ts`

**Interfaces:**
- Produces: `loadConfig(): AppConfig`
- Produces: `openDatabase(path: string): Database.Database`
- Produces: `migrate(db: Database.Database): void`
- Produces: shared `SourceRecord`, `Settings`, and `HealthStatus` types

- [x] **Step 1: Add package scripts and dependencies**

Define `dev`, `build`, `start`, `test`, and `typecheck` scripts. Install Fastify, cookie/static plugins, `better-sqlite3`, Vue, Vite, TypeScript, Vitest, and minimal type packages. Require Node 22.

- [x] **Step 2: Add repository hygiene and environment example**

Ignore `.env`, `data/`, `uploads/`, `logs/`, `node_modules/`, `dist/`, `coverage/`, `*.db`, `*.db-shm`, and `*.db-wal`. Document `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `SESSION_SECRET`, `PORT`, `DATABASE_PATH`, and `ADULT_KEYWORDS_EXTRA` in `.env.example` with non-secret examples.

- [x] **Step 3: Write the failing migration test**

The test opens an in-memory database, runs `migrate`, and asserts the existence of `sources`, `health_checks`, `settings`, and `sessions`, plus default settings `check_interval_hours=24`, `request_timeout_ms=10000`, `failure_threshold=3`, and `cache_time=7200`.

- [x] **Step 4: Run the focused test and confirm failure**

Run: `npm test -- tests/db.test.ts`

Expected: failure because `openDatabase` and `migrate` do not exist.

- [x] **Step 5: Implement configuration and schema**

Validate required administrator variables at startup. Create sources with unique `source_key`, LunaTV fields, classification mode/result, enabled/ignore-check flags, current health state, failure count, timestamps, and latency. Create bounded health history, key/value settings, and expiring hashed sessions. Enable WAL, foreign keys, and busy timeout.

- [x] **Step 6: Run database tests and typecheck**

Run: `npm test -- tests/db.test.ts && npm run typecheck`

Expected: all pass.

- [x] **Step 7: Commit the project foundation**

```bash
git add .gitignore .env.example package.json package-lock.json tsconfig.json vite.config.ts src/server/config.ts src/server/db.ts src/server/schema.sql src/server/types.ts tests/db.test.ts
git commit -m "feat: initialize source sync service"
```

### Task 2: Import, overwrite, classification, and source repository

**Files:**
- Create: `src/server/sources/classify.ts`
- Create: `src/server/sources/import.ts`
- Create: `src/server/sources/repository.ts`
- Test: `tests/source-import.test.ts`

**Interfaces:**
- Consumes: `SourceRecord` and migrated SQLite database from Task 1
- Produces: `classifyAdult(input, extraKeywords): boolean`
- Produces: `previewImport(payload): ImportPreview`
- Produces: `applyImport(db, preview): ImportResult`
- Produces: repository functions for list/get/create/update/delete and bulk state changes

- [x] **Step 1: Write failing import tests**

Cover a valid `api_site`, invalid missing `name`/`api`, automatic adult keywords across key/name/URL/comment, explicit `adult` overrides, same-key overwrite, and retention of existing health history.

- [x] **Step 2: Run the import tests and confirm failure**

Run: `npm test -- tests/source-import.test.ts`

Expected: missing module failures.

- [x] **Step 3: Implement classification and validation**

Normalize case, match a conservative built-in keyword set plus comma-separated environment additions, and model classification as `auto | adult | normal`. Parse only object-shaped `api_site` input, retain allowed LunaTV fields, and return item-level validation errors without writing files.

- [x] **Step 4: Implement transactional overwrite and repository operations**

Upsert by `source_key`; overwrite display/API fields and classification while retaining health rows and current health metadata. Implement paginated filtering and explicit transactional bulk updates/deletes.

- [x] **Step 5: Run focused and full tests**

Run: `npm test -- tests/source-import.test.ts && npm test`

Expected: all pass.

- [x] **Step 6: Commit source management core**

```bash
git add src/server/sources tests/source-import.test.ts
git commit -m "feat: import and classify LunaTV sources"
```

### Task 3: Subscription generation, Base58, and controlled proxy

**Files:**
- Create: `src/server/subscription/base58.ts`
- Create: `src/server/subscription/service.ts`
- Create: `src/server/proxy/safety.ts`
- Create: `src/server/proxy/service.ts`
- Create: `src/server/routes/public.ts`
- Test: `tests/subscription.test.ts`
- Test: `tests/proxy.test.ts`

**Interfaces:**
- Consumes: source repository and global settings
- Produces: `base58EncodeUtf8(value: string): string`
- Produces: `buildSubscription(options): LunaConfig`
- Produces: public routes `/api/source` and `/api/proxy/:sourceKey`

- [x] **Step 1: Write failing subscription tests**

Assert default normal filtering; explicit normal/adult/all filtering; enabled and failure-threshold rules; omission of internal fields; JSON shape; reference-compatible Base58 output; token validation; `ac`, `format`, `proxy`, and `source` validation; and CORS preflight behavior.

- [x] **Step 2: Write failing proxy safety tests**

Assert lookup by registered source key, query merging, refusal of disabled/missing sources, rejection of loopback/private/link-local/metadata IPv4 and IPv6 addresses, redirect revalidation, stripped sensitive headers, timeout behavior, and CORS response headers.

- [x] **Step 3: Run the focused tests and confirm failure**

Run: `npm test -- tests/subscription.test.ts tests/proxy.test.ts`

Expected: missing implementation failures.

- [x] **Step 4: Implement subscription and Base58 generation**

Serialize compact UTF-8 JSON and encode with `123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz`. When `proxy=1`, replace only each emitted source's `api` with an absolute `/api/proxy/:sourceKey` URL including the configured token when present.

- [x] **Step 5: Implement the controlled proxy**

Resolve the source solely by path key, validate protocol and every resolved address before connecting, manually follow a small redirect limit with repeated validation, merge LunaTV query parameters with the upstream URL, limit time and response size, and expose only safe response headers.

- [x] **Step 6: Register public routes and run tests**

Run: `npm test -- tests/subscription.test.ts tests/proxy.test.ts && npm run typecheck`

Expected: all pass.

- [x] **Step 7: Commit public subscription service**

```bash
git add src/server/subscription src/server/proxy src/server/routes/public.ts tests/subscription.test.ts tests/proxy.test.ts
git commit -m "feat: add subscriptions and controlled CORS proxy"
```

### Task 4: Health checks and global scheduler

**Files:**
- Create: `src/server/health/check.ts`
- Create: `src/server/health/scheduler.ts`
- Create: `src/server/health/repository.ts`
- Test: `tests/health.test.ts`

**Interfaces:**
- Consumes: source repository, SQLite settings, and outbound request safety checks
- Produces: `checkSource(source, settings): Promise<CheckResult>`
- Produces: `runHealthBatch(db): Promise<BatchResult>`
- Produces: `startScheduler(db): SchedulerHandle`

- [x] **Step 1: Write failing health-state tests**

Cover correct `ac=list` query merging, JSON and XML acceptance, malformed/empty response rejection, timeout/retry behavior, consecutive failure increment, success reset, hidden-after-threshold behavior, recovery, ignore-check publishing, and bounded history pruning.

- [x] **Step 2: Run the test and confirm failure**

Run: `npm test -- tests/health.test.ts`

Expected: missing health modules.

- [x] **Step 3: Implement checker and persistence**

Use limited concurrency and at most two retries. Store status, latency, checked time, short error code/message, and history; prune history to 30 entries per source in the same transaction.

- [x] **Step 4: Implement reschedulable global scheduler**

Persist `check_interval_hours` and next-run time, prevent overlapping batches, reschedule immediately after setting changes, and expose manual single/bulk/batch triggers that reuse `checkSource`.

- [x] **Step 5: Run health and regression tests**

Run: `npm test -- tests/health.test.ts && npm test`

Expected: all pass.

- [x] **Step 6: Commit health checking**

```bash
git add src/server/health tests/health.test.ts
git commit -m "feat: add scheduled source health checks"
```

### Task 5: Authentication and management API

**Files:**
- Create: `src/server/auth/service.ts`
- Create: `src/server/routes/auth.ts`
- Create: `src/server/routes/admin.ts`
- Create: `src/server/app.ts`
- Create: `src/server/index.ts`
- Test: `tests/admin-api.test.ts`

**Interfaces:**
- Consumes: repositories, importer, scheduler, and environment configuration
- Produces: `buildApp(options): Promise<FastifyInstance>`
- Produces: login/logout/session middleware and `/api/admin/*` endpoints

- [x] **Step 1: Write failing authentication and API tests**

Cover successful/failed login, HttpOnly/SameSite cookie, logout, unauthenticated rejection, login throttling, CSRF enforcement for writes, import preview/apply, CRUD and bulk actions, immediate checks, settings validation, dashboard counts, and secret redaction.

- [x] **Step 2: Run the API tests and confirm failure**

Run: `npm test -- tests/admin-api.test.ts`

Expected: missing app/auth modules.

- [x] **Step 3: Implement environment-backed authentication**

Compare credentials using timing-safe comparisons, store only a hash of random session tokens with expiry in SQLite, rotate on login, use secure cookies when configured behind HTTPS, and require a session-bound CSRF header for state changes.

- [x] **Step 4: Implement management API and application composition**

Expose narrowly validated endpoints for dashboard, sources, import preview/apply, bulk changes, health triggers, health history, settings, and subscription examples. Register public routes separately from session-protected admin routes.

- [x] **Step 5: Run API, full test, and typecheck suites**

Run: `npm test -- tests/admin-api.test.ts && npm test && npm run typecheck`

Expected: all pass.

- [x] **Step 6: Commit the application API**

```bash
git add src/server tests/admin-api.test.ts
git commit -m "feat: add authenticated management API"
```

### Task 6: Vue management interface

**Files:**
- Create: `index.html`
- Create: `src/client/main.ts`
- Create: `src/client/App.vue`
- Create: `src/client/api.ts`
- Create: `src/client/styles.css`
- Create: `src/client/views/LoginView.vue`
- Create: `src/client/views/DashboardView.vue`
- Create: `src/client/views/SourcesView.vue`
- Create: `src/client/views/SettingsView.vue`
- Create: `src/client/components/SourceEditor.vue`
- Create: `src/client/components/ImportDialog.vue`
- Create: `src/client/components/SubscriptionLinks.vue`

**Interfaces:**
- Consumes: `/api/auth/*` and `/api/admin/*`
- Produces: responsive single-admin SPA built into `dist/client`

- [x] **Step 1: Build the shared client API and login flow**

Implement credentialed requests, CSRF header propagation, safe error messages, session bootstrap, login, and logout.

- [x] **Step 2: Build dashboard and source management**

Render required counts/statuses, searchable/filterable source table, pagination, CRUD editor, bulk selection/actions, manual health checks, and clear status/error displays.

- [x] **Step 3: Build import, settings, and subscription panels**

Support JSON file selection, preview counts and item errors before apply; integer-hour/timeout/threshold/cache settings; and copyable URLs for source, format, and proxy combinations without revealing the token in logs.

- [x] **Step 4: Verify the production build**

Run: `npm run build && npm run typecheck`

Expected: server and client builds complete without errors.

- [x] **Step 5: Commit the management interface**

```bash
git add index.html src/client vite.config.ts
git commit -m "feat: add source management dashboard"
```

### Task 7: Docker packaging, documentation, and end-to-end verification

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `.dockerignore`
- Create: `scripts/smoke-test.sh`
- Create: `README.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: built server/client and environment contract
- Produces: runnable `linux/amd64` image exposing port 3000 and persisting `/app/data`

- [x] **Step 1: Add multi-stage Docker build and Compose file**

Build dependencies and assets in a Node 22 builder, install production dependencies for the final image, run as a non-root user, expose port 3000, add an HTTP healthcheck, declare `/app/data`, and set Compose platform to `linux/amd64`.

- [x] **Step 2: Add smoke script**

The script starts the Compose service with test credentials/token, waits for `/health`, logs in, imports a small fixture through the API, requests normal JSON and Base58 subscriptions, asserts CORS headers, and confirms an invalid source/format is rejected.

- [x] **Step 3: Document deployment and operation**

Document Synology-compatible directory creation, `.env` setup, `docker compose up -d`, volume backup, login URL, import/overwrite behavior, adult overrides, health scheduling, subscription examples, proxy mode, token rotation, upgrade, and troubleshooting.

- [x] **Step 4: Run final verification**

Run:

```bash
npm test
npm run typecheck
npm run build
docker build --platform linux/amd64 -t lunatv-source-sync:test .
bash scripts/smoke-test.sh
git diff --check
```

Expected: all commands pass and the smoke test reports successful login, import, subscription, Base58, CORS, and validation checks.

- [x] **Step 5: Commit packaging and documentation**

```bash
git add Dockerfile docker-compose.yml .dockerignore scripts/smoke-test.sh README.md package.json package-lock.json
git commit -m "docs: package and document LunaTV source sync"
```
