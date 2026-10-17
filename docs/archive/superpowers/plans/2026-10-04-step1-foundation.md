# Step 1: Foundation: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running TypeScript service with the full Postgres schema (CHECKs, partial index, append-only triggers), READ/WRITE bearer auth, the audit row on every POST, idempotency, per-token rate limits, the error format, `/health`, and the `admin` CLI (`token create|revoke|list`, `doctor`). Gates G0/G1 pass for these.

**Architecture:** Fastify app built by `buildApp(deps)` (all dependencies injected so tests can swap the clock, the audit writer and the logger). Cross-cutting behaviour lives in root-level hooks whose **registration order is the contract**: onRequest (audit id → auth) → preHandler (rate limit → scope → idempotency) → handler → onSend (idempotency store → audit write). DB access via Kysely over `pg`; schema in one plain-SQL node-pg-migrate migration. No business endpoints yet: POST behaviour is tested through test-only routes that exist only in the test app.

**Tech Stack:** Node ≥22 (ESM, TypeScript strict), Fastify 5, zod, Kysely + pg, node-pg-migrate (SQL migrations), Vitest (projects `unit`, `api`), MSW (network blocking), tsx, Postgres 16 in docker.

**Spec:** `CLAUDE.md`, `docs/specs/00-architecture.md` (§4 data model, §6 auth/audit/idempotency, §7 errors/health), `docs/specs/test-plan.md` (AU, ID, AL, RN-3), `docs/specs/buy.md` (check order 1–2, purchases), `docs/specs/listing-strategy.md` §1, §5 (categories, settings), `docs/specs/report.md` (R-11).

## Global Constraints

- Money: integer cents, USD. Never floats for money.
- Time: `timestamptz` in UTC; `date` columns are returned as `'YYYY-MM-DD'` strings (never JS `Date`).
- Errors: `{"error":{"code":"UPPER_SNAKE","message":"…","details":{}}}` for every non-2xx response.
- Domains lowercase in the DB (CHECK).
- `renewals_used` CHECK 0..1. `drop_date = expiry_date + 1 year` while `renewals_used = 0` (29 Feb → 28 Feb).
- `ledger_entries`, `audit_log`, `listing_history`: append-only, enforced by DB triggers (UPDATE, DELETE and TRUNCATE rejected).
- Tokens: random ≥32 bytes, stored as SHA-256 hex; the plain token is printed once by the admin command; **no API route creates, lists or reveals tokens**.
- READ token: GET/HEAD only. WRITE: everything. Missing/unknown/revoked token → 401. READ on POST → 403 `SCOPE_FORBIDDEN`.
- Every POST requires `Idempotency-Key` (400 `IDEMPOTENCY_KEY_REQUIRED`); same key + same body → stored response replayed with `Idempotent-Replayed: true`; same key + different body → 409 `IDEMPOTENCY_KEY_MISMATCH`.
- Every POST (success, refusal, error, replay, 401, 429) writes exactly one `audit_log` row.
- Rate limit per token: 60/min GET, 10/min POST → 429.
- `/health`: no auth, `{status, db, version, adapters:[{name, enabled}]}`, no secrets, no business data.
- Caps/settings are never writable via the API. No settings route exists.
- Cloudflare is never an allowed registrar (DB CHECK).
- No real keys anywhere. Fake test values only (`pk1_fake_…`, `sk1_fake_…`). Secrets never logged or returned.
- No network calls in tests: MSW `onUnhandledRequest: 'error'` in every test project. (Localhost Postgres over a TCP socket is allowed.)
- No LLM calls. No email/chat.
- ESM everywhere: relative imports end in `.js` (TypeScript NodeNext).
- Don't edit a spec test to make it pass without Dvir's OK.

## Review Focus

1. **Same body, different JSON key order or whitespace** → must count as the *same* request (replay, not 409). Test in Task 6 (`canonical body hashing`).
2. **Two in-flight requests with the same key** → exactly one executes; the other gets 409 `IDEMPOTENCY_KEY_IN_USE`; side effect happens once. Test in Task 6 (`concurrent same key`).
3. **Handler crashes (500)** → the key is released so a retry with the same key can run, and the audit row is still written. Test in Task 6 (`500 releases the key`).
4. **Audit write fails after the handler succeeded** → client gets 500 `AUDIT_WRITE_FAILED`, but the real result is stored under the key, so a retry replays it instead of re-executing (protects a future `/buy` from double-charging). Test in Task 6 (`audit failure keeps stored result`).
5. **Test DB guard** → the test setup must refuse to wipe a database whose name doesn't end in `_test` (protects a dev/prod DB from `DROP SCHEMA`). Test in Task 2 (`global setup refuses non-test DB`).

## Decisions taken in this plan that the spec doesn't spell out (Dvir to confirm)

| # | Decision | Why |
|---|---|---|
| D1 | New table `idempotency_keys` (generic, all POSTs). `purchases.idempotency_key` stays as in the spec | §6 requires replay for every POST; `purchases` only covers `/buy` |
| D2 | Replays, 401s and 429s on POST also write an audit row (`result_summary` `replayed:…`, `UNAUTHORIZED`, `RATE_LIMITED`) | AL-1: "exactly one audit row per request, including 4xx" |
| D3 | New error codes: `UNAUTHORIZED` 401, `IDEMPOTENCY_KEY_IN_USE` 409, `RATE_LIMITED` 429, `VALIDATION_ERROR` 422, `INVALID_BODY` 400/413/415, `NOT_FOUND` 404, `INTERNAL` 500, `AUDIT_WRITE_FAILED` 500 | The spec doesn't name these |
| D4 | `purchases` partial unique index covers `created`, `register_sent`, `succeeded`, **`unknown`** (approved by Dvir; spec updated) | An unknown purchase may have charged |
| D5 | Settings row seeded by the migration with the spec defaults. The `POC_CAP_CENTS`, `MAX_DOMAINS`, `GEO_*`, `HIGH_VALUE_*`, `SEDO_HYBRID_AS`, `APPROVAL_MAX_AGE_HOURS` env vars are **not read** (recommend deleting them from `.env.example` later: two sources of truth). `allowed_registrars` defaults to `{porkbun}` | Caps change only via admin command or migration |
| D6 | `/health` returns **503** with `status:"degraded", db:"down"` when the DB is unreachable | Render's health check then flags the instance |
| D7 | Append-only tables also reject TRUNCATE; tests reset with `session_replication_role = replica` | Stronger than the spec; prod never truncates |
| D8 | `domains` CHECKs beyond the spec: owned+ rows must have registrar, registrar_api, buy_date, cost, expiry, drop_date; `drop_date = expiry + 1y` while `renewals_used = 0`; `registrar <> 'cloudflare'` | Enforces founder rules 3 and 5 in the DB |
| D9 | `audit_log.id` is `aud_<32 hex>`, pre-allocated at request start; `ledger_entries.audit_id` / `listing_history.audit_id` have **no FK** (the audit row is inserted when the response is sent) | Append-only audit row must carry the final status, yet `/buy` must cite `audit_id` in the ledger note |
| D10 | `/health` adapter `enabled` = in `ENABLED_REGISTRARS` **and** keys set **and** adapter implemented. In step 1 no adapter is implemented, so all are `false` | Spec: enabled only when keys set and contract tests pass |
| D11 | Local docker Postgres on **port 5433** (a native Postgres already uses 5432 on Dvir's Mac) | Avoid clash |

---

## File structure

```
package.json, package-lock.json, tsconfig.json, tsconfig.build.json, vitest.config.ts, .nvmrc
docker-compose.yml
docker/initdb/01-test-db.sql            creates domain_trading_test
migrations/1759600000000_initial-schema.sql
src/
  main.ts                               start the HTTP server
  app.ts                                buildApp(deps): Fastify instance, hook order
  config.ts                             loadConfig(env) → Config
  admin.ts                              CLI entry: token create|revoke|list, doctor
  admin/tokens.ts                       createApiToken / revokeApiToken / listApiTokens
  admin/doctor.ts                       runDoctor(config, db) → lines
  auth/tokens.ts                        generateToken / hashToken
  db/types.ts                           Kysely Database interface
  db/client.ts                          createDb(url), pingDb(db)
  http/errors.ts                        AppError, errorBody, registerErrorHandling
  http/methods.ts                       isMutating(method)
  http/auth.ts                          registerAuth (onRequest), registerScope (preHandler)
  http/audit.ts                         registerAuditId, registerAuditWrite, dbAuditWriter, newAuditId
  http/idempotency.ts                   registerIdempotency, requestHash
  http/rate-limit.ts                    SlidingWindowLimiter, registerRateLimit
  http/redact.ts                        redact(value)
  http/canonical-json.ts                canonicalJson(value)
  api/health.ts                         GET /health
  registrars/registry.ts                REGISTRAR_ENV, adapterStatus(config)
tests/
  setup/network.ts                      MSW server, onUnhandledRequest:'error'
  setup/global-db.ts                    drop+migrate the _test DB once per run
  setup/api.ts                          resetDb before each api test
  helpers/env.ts                        TEST_DATABASE_URL, testEnv()
  helpers/db.ts                         testDb, resetDb, insertOwnedDomain
  helpers/app.ts                        makeApp(opts), test routes, sideEffects, logCapture
  helpers/tokens.ts                     issueToken(scope)
  unit/*.test.ts
  api/*.test.ts
```

---

### Task 1: Project scaffold, config, network-blocked test runner

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `.nvmrc`, `docker-compose.yml`, `docker/initdb/01-test-db.sql`, `src/config.ts`, `src/registrars/registry.ts`, `tests/setup/network.ts`, `tests/helpers/env.ts`, `tests/unit/config.test.ts`, `tests/unit/network-block.test.ts`
- Modify: `.env.example` (DATABASE_URL port 5432 → 5433, add `PORT`, `LOG_LEVEL`, `TEST_DATABASE_URL`)

**Interfaces:**
- Produces:
  - `loadConfig(env: NodeJS.ProcessEnv): Config`
  - `interface Config { databaseUrl: string; appEnv: 'development'|'test'|'production'; port: number; host: string; logLevel: string; enabledRegistrars: string[]; version: string; env: Readonly<Record<string, string>>; secretValues: string[] }`
  - `REGISTRAR_ENV: Record<string, readonly string[]>`
  - `adapterStatus(config: Config): { name: string; enabled: boolean; reason: string | null }[]`
  - `IMPLEMENTED_ADAPTERS: ReadonlySet<string>` (empty in step 1)
  - `TEST_DATABASE_URL: string`, `testEnv(overrides?): NodeJS.ProcessEnv`

- [ ] **Step 1: Create the project files**

`package.json`:
```json
{
  "name": "domain-trading",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/main.js",
    "dev": "tsx watch --env-file-if-exists=.env src/main.ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:unit": "vitest run --project unit",
    "test:api": "vitest run --project api",
    "migrate": "node-pg-migrate -m migrations -j sql",
    "admin": "tsx --env-file-if-exists=.env src/admin.ts",
    "db:up": "docker compose up -d --wait db"
  }
}
```
Then install (latest majors; the lockfile pins them):
```bash
npm install fastify zod kysely pg node-pg-migrate tsx dotenv
npm install -D typescript @types/node @types/pg vitest msw
```
(`tsx` and `dotenv` are runtime deps: `npm run admin` runs from source in the Render shell; node-pg-migrate auto-loads `.env` through `dotenv` when present. If your node-pg-migrate version doesn't, add `--envPath .env` to the `migrate` script.)

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src", "tests", "vitest.config.ts"]
}
```
`tsconfig.build.json`:
```json
{ "extends": "./tsconfig.json", "compilerOptions": { "rootDir": "src", "outDir": "dist" }, "include": ["src"] }
```
`.nvmrc`: `22`

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['tests/setup/network.ts'],
    fileParallelism: false,
    env: { APP_ENV: 'test' },
    projects: [
      { extends: true, test: { name: 'unit', include: ['tests/unit/**/*.test.ts'] } },
      {
        extends: true,
        test: {
          name: 'api',
          include: ['tests/api/**/*.test.ts'],
          globalSetup: ['tests/setup/global-db.ts'],
          setupFiles: ['tests/setup/network.ts', 'tests/setup/api.ts'],
        },
      },
    ],
  },
});
```
(Until Task 2 creates `tests/setup/global-db.ts` and `tests/setup/api.ts`, run only `--project unit`.)

`docker-compose.yml`:
```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: dt
      POSTGRES_PASSWORD: dt
      POSTGRES_DB: domain_trading
    ports:
      - "5433:5432"   # 5432 is taken by a native Postgres on Dvir's Mac
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./docker/initdb:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U dt -d domain_trading"]
      interval: 2s
      timeout: 3s
      retries: 30
volumes:
  pgdata: {}
```
`docker/initdb/01-test-db.sql`:
```sql
CREATE DATABASE domain_trading_test OWNER dt;
```
`.env.example`: change the core block to:
```
DATABASE_URL=postgres://dt:dt@localhost:5433/domain_trading   # docker compose (port 5433)
TEST_DATABASE_URL=postgres://dt:dt@localhost:5433/domain_trading_test
PORT=3000
LOG_LEVEL=info
```
(keep every other line unchanged).

- [ ] **Step 2: Write the network-block setup and its test**

`tests/setup/network.ts`:
```ts
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';

export const mswServer = setupServer();

beforeAll(() => mswServer.listen({ onUnhandledRequest: 'error' }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());
```
`tests/unit/network-block.test.ts`:
```ts
import { describe, expect, it } from 'vitest';

describe('network blocking', () => {
  it('fails any unmocked outbound HTTP request', async () => {
    await expect(fetch('https://api.porkbun.com/api/json/v3/ping')).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Write the failing config tests**

`tests/helpers/env.ts`:
```ts
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://dt:dt@localhost:5433/domain_trading_test';

/** A complete, fake-valued env for tests. Never put real keys here. */
export function testEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: TEST_DATABASE_URL,
    APP_ENV: 'test',
    ENABLED_REGISTRARS: 'porkbun',
    PORKBUN_API_KEY: 'pk1_fake_test_key_000000000000',
    PORKBUN_SECRET_API_KEY: 'sk1_fake_test_secret_00000000',
    GODADDY_PAT: 'fake_godaddy_pat_0000000000',
    GITHUB_BACKUP_TOKEN: 'github_pat_fake_000000000000',
    ...overrides,
  };
}
```
`tests/unit/config.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { adapterStatus } from '../../src/registrars/registry.js';
import { testEnv } from '../helpers/env.js';

describe('loadConfig', () => {
  it('parses a valid env with defaults', () => {
    const c = loadConfig(testEnv());
    expect(c.appEnv).toBe('test');
    expect(c.port).toBe(3000);
    expect(c.enabledRegistrars).toEqual(['porkbun']);
    expect(c.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('rejects a missing DATABASE_URL', () => {
    const env = testEnv();
    delete env.DATABASE_URL;
    expect(() => loadConfig(env)).toThrow(/DATABASE_URL/);
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() => loadConfig(testEnv({ DATABASE_URL: 'mysql://x' }))).toThrow(/DATABASE_URL/);
  });

  it('collects every non-empty secret value (registrar keys, backup token, DB password)', () => {
    const c = loadConfig(testEnv());
    expect(c.secretValues).toEqual(
      expect.arrayContaining([
        'pk1_fake_test_key_000000000000',
        'sk1_fake_test_secret_00000000',
        'fake_godaddy_pat_0000000000',
        'github_pat_fake_000000000000',
        'dt',
      ]),
    );
  });

  it('lowercases and trims ENABLED_REGISTRARS', () => {
    expect(loadConfig(testEnv({ ENABLED_REGISTRARS: ' Porkbun, NameCom ' })).enabledRegistrars).toEqual([
      'porkbun',
      'namecom',
    ]);
  });
});

describe('adapterStatus', () => {
  it('lists every known registrar, all disabled in step 1 (no adapter implemented)', () => {
    const s = adapterStatus(loadConfig(testEnv()));
    expect(s.map((a) => a.name)).toEqual(
      expect.arrayContaining(['porkbun', 'dynadot', 'namecom', 'namecheap', 'godaddy', 'spaceship', 'namesilo']),
    );
    expect(s.every((a) => a.enabled === false)).toBe(true);
    expect(s.find((a) => a.name === 'porkbun')?.reason).toBe('not implemented');
  });

  it('never lists cloudflare', () => {
    expect(adapterStatus(loadConfig(testEnv())).some((a) => a.name === 'cloudflare')).toBe(false);
  });

  it('reports missing keys before "not implemented"', () => {
    const s = adapterStatus(loadConfig(testEnv({ PORKBUN_API_KEY: '' })));
    expect(s.find((a) => a.name === 'porkbun')?.reason).toBe('keys missing');
  });

  it('reports registrars not in ENABLED_REGISTRARS', () => {
    const s = adapterStatus(loadConfig(testEnv()));
    expect(s.find((a) => a.name === 'dynadot')?.reason).toBe('not in ENABLED_REGISTRARS');
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `npx vitest run --project unit`
Expected: network-block test PASSES; config tests FAIL (`Cannot find module '../../src/config.js'`).

- [ ] **Step 5: Implement config and registry**

`src/config.ts`:
```ts
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { REGISTRAR_ENV } from './registrars/registry.js';

const EnvSchema = z.object({
  DATABASE_URL: z
    .string({ required_error: 'DATABASE_URL is required' })
    .refine((v) => /^postgres(ql)?:\/\//.test(v), 'DATABASE_URL must be a postgres:// URL'),
  APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),
  ENABLED_REGISTRARS: z.string().default(''),
});

export interface Config {
  databaseUrl: string;
  appEnv: 'development' | 'test' | 'production';
  port: number;
  host: string;
  logLevel: string;
  enabledRegistrars: string[];
  version: string;
  /** Raw env (strings only). Read secrets from here; never log it. */
  env: Readonly<Record<string, string>>;
  /** Every non-empty secret value, for leak tests (AU-8) and log redaction. */
  secretValues: string[];
}

const SECRET_ENV = ['GITHUB_BACKUP_TOKEN', ...Object.values(REGISTRAR_ENV).flat()];

function readVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return pkg.version;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${msg}`);
  }
  const e = parsed.data;
  const strings: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') strings[k] = v;

  const secretValues = SECRET_ENV.map((k) => strings[k] ?? '').filter((v) => v.length > 0);
  const dbPassword = decodeURIComponent(new URL(e.DATABASE_URL).password);
  if (dbPassword) secretValues.push(dbPassword);

  return {
    databaseUrl: e.DATABASE_URL,
    appEnv: e.APP_ENV,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    enabledRegistrars: e.ENABLED_REGISTRARS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    version: readVersion(),
    env: Object.freeze(strings),
    secretValues,
  };
}
```
(If the installed zod is v4, replace `{ required_error: '…' }` with `{ error: 'DATABASE_URL is required' }`; the test only checks that the message contains `DATABASE_URL`.)

`src/registrars/registry.ts`:
```ts
import type { Config } from '../config.js';

/** Env vars each registrar adapter needs. Cloudflare is deliberately absent (founder rule 5). */
export const REGISTRAR_ENV: Record<string, readonly string[]> = {
  porkbun: ['PORKBUN_API_KEY', 'PORKBUN_SECRET_API_KEY'],
  dynadot: ['DYNADOT_API_KEY', 'DYNADOT_API_SECRET'],
  namecom: ['NAMECOM_USERNAME', 'NAMECOM_API_TOKEN'],
  namecheap: ['NAMECHEAP_API_USER', 'NAMECHEAP_API_KEY', 'NAMECHEAP_USERNAME', 'NAMECHEAP_CLIENT_IP'],
  godaddy: ['GODADDY_PAT'],
  spaceship: ['SPACESHIP_API_KEY', 'SPACESHIP_API_SECRET'],
  namesilo: ['NAMESILO_API_KEY'],
};

/** Adapters with code behind them. Step 2 adds 'porkbun'. */
export const IMPLEMENTED_ADAPTERS: ReadonlySet<string> = new Set<string>();

export function adapterStatus(config: Config): { name: string; enabled: boolean; reason: string | null }[] {
  return Object.entries(REGISTRAR_ENV).map(([name, keys]) => {
    let reason: string | null = null;
    if (!config.enabledRegistrars.includes(name)) reason = 'not in ENABLED_REGISTRARS';
    else if (keys.some((k) => !config.env[k])) reason = 'keys missing';
    else if (!IMPLEMENTED_ADAPTERS.has(name)) reason = 'not implemented';
    return { name, enabled: reason === null, reason };
  });
}
```
Note: `config.ts` imports `registry.ts` for `REGISTRAR_ENV`, and `registry.ts` imports only the `Config` *type* from `config.ts`: no runtime cycle.

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run --project unit && npx tsc --noEmit`
Expected: all unit tests PASS, typecheck clean.

- [ ] **Step 7: Start the DB**

Run: `npm run db:up && docker compose exec db psql -U dt -l | grep domain_trading`
Expected: both `domain_trading` and `domain_trading_test` listed.

- [ ] **Step 8: Commit**
```bash
git add package.json package-lock.json tsconfig.json tsconfig.build.json vitest.config.ts .nvmrc docker-compose.yml docker/ src/ tests/ .env.example
git commit -m "feat: TypeScript scaffold, config, registrar registry, network-blocked tests"
```

---

### Task 2: Database schema, Kysely types, test DB harness

**Files:**
- Create: `migrations/1759600000000_initial-schema.sql`, `src/db/types.ts`, `src/db/client.ts`, `tests/setup/global-db.ts`, `tests/setup/api.ts`, `tests/helpers/db.ts`, `tests/api/schema.test.ts`, `tests/unit/global-db-guard.test.ts`

**Interfaces:**
- Consumes: `TEST_DATABASE_URL` (Task 1).
- Produces:
  - `Database` (Kysely schema interface) and row types in `src/db/types.ts`
  - `createDb(url: string): Kysely<Database>`
  - `pingDb(db: Kysely<Database>, timeoutMs?: number): Promise<boolean>`
  - `testDb: Kysely<Database>`, `resetDb(db): Promise<void>`, `insertOwnedDomain(db, overrides?): Promise<number>` (returns id)
  - `assertTestDatabaseUrl(url: string): void` (exported from `tests/setup/global-db.ts`)

- [ ] **Step 1: Write the migration**

`migrations/1759600000000_initial-schema.sql`:
```sql
-- Up Migration

CREATE FUNCTION reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only table %: % is not allowed', TG_TABLE_NAME, TG_OP;
END
$$;

CREATE TABLE api_tokens (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  scope         text NOT NULL CHECK (scope IN ('read', 'write')),
  token_sha256  text NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  last_used_at  timestamptz
);
CREATE UNIQUE INDEX api_tokens_active_name ON api_tokens (name) WHERE revoked_at IS NULL;

-- One row only. Changed only by the admin command or a migration, never the API.
CREATE TABLE settings (
  id                        boolean PRIMARY KEY DEFAULT true CHECK (id),
  poc_cap_cents             integer NOT NULL DEFAULT 50000 CHECK (poc_cap_cents > 0),
  max_domains               integer NOT NULL DEFAULT 10 CHECK (max_domains > 0),
  approval_max_age_hours    integer NOT NULL DEFAULT 72 CHECK (approval_max_age_hours > 0),
  lander_target             text NOT NULL DEFAULT 'afternic' CHECK (lander_target IN ('afternic', 'sedo', 'custom')),
  allowed_registrars        text[] NOT NULL DEFAULT '{porkbun}'
                            CHECK (NOT ('cloudflare' = ANY (allowed_registrars))),
  geo_bin_min_cents         integer NOT NULL DEFAULT 29900,
  geo_bin_max_cents         integer NOT NULL DEFAULT 49900,
  high_value_categories     text[] NOT NULL DEFAULT '{trend,b2b,collision,regulation,buzzword}',
  high_value_min_bin_cents  integer NOT NULL DEFAULT 250000 CHECK (high_value_min_bin_cents > 0),
  high_value_guard_modes    text[] NOT NULL DEFAULT '{bin}',
  sedo_hybrid_as            text NOT NULL DEFAULT 'buy_now' CHECK (sedo_hybrid_as IN ('buy_now', 'make_offer')),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (geo_bin_min_cents > 0 AND geo_bin_min_cents <= geo_bin_max_cents),
  CHECK (high_value_guard_modes <@ ARRAY['bin', 'offer', 'hybrid']),
  CHECK (high_value_categories <@ ARRAY['geo', 'trend', 'b2b', 'collision', 'regulation', 'buzzword', 'other'])
);
INSERT INTO settings DEFAULT VALUES;

CREATE TABLE deals (
  id           text PRIMARY KEY CHECK (id ~ '^D-[0-9]{3,}$'),
  domain       text CHECK (domain = lower(domain)),
  strategy     text,
  status_note  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE domains (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain               text NOT NULL UNIQUE CHECK (domain = lower(domain) AND length(domain) BETWEEN 4 AND 253),
  deal_id              text CHECK (deal_id ~ '^D-[0-9]{3,}$'),
  registrar            text CHECK (registrar <> 'cloudflare'),
  status               text NOT NULL CHECK (status IN ('pending_purchase', 'owned', 'listed', 'sold', 'dropped')),
  buy_date             date,
  cost_cents           integer CHECK (cost_cents >= 0),
  expiry_date          date,
  renewal_price_cents  integer CHECK (renewal_price_cents >= 0),
  renewals_used        smallint NOT NULL DEFAULT 0 CHECK (renewals_used BETWEEN 0 AND 1),
  drop_date            date,
  category             text CHECK (category IN ('geo', 'trend', 'b2b', 'collision', 'regulation', 'buzzword', 'other')),
  listing_mode         text CHECK (listing_mode IN ('bin', 'offer', 'hybrid')),
  bin_cents            integer CHECK (bin_cents > 0),
  floor_cents          integer CHECK (floor_cents > 0),
  min_offer_cents      integer CHECK (min_offer_cents >= 2000),
  lto_max_months       smallint CHECK (lto_max_months BETWEEN 2 AND 60),
  display_name         text,
  lander               text,
  lander_ns            text[],
  lander_set_at        timestamptz,
  ns_verified_at       timestamptz,
  registrar_api        text CHECK (registrar_api IN ('full', 'manage', 'none')),
  sold_at              timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT domains_category_once_owned CHECK (status = 'pending_purchase' OR category IS NOT NULL),
  CONSTRAINT domains_owned_fields CHECK (
    status = 'pending_purchase' OR (
      registrar IS NOT NULL AND registrar_api IS NOT NULL AND buy_date IS NOT NULL
      AND cost_cents IS NOT NULL AND expiry_date IS NOT NULL AND drop_date IS NOT NULL
    )
  ),
  CONSTRAINT domains_drop_date_rule CHECK (
    renewals_used = 1 OR drop_date IS NULL OR drop_date = (expiry_date + interval '1 year')::date
  )
);

CREATE TABLE ledger_entries (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_on   date NOT NULL,
  domain_id     bigint REFERENCES domains (id),
  deal_id       text,
  type          text NOT NULL CHECK (type IN ('registration', 'renewal', 'fee', 'commission', 'sale',
                                              'payout_fee', 'refund', 'tool', 'ai', 'adjustment')),
  amount_cents  integer NOT NULL CHECK (amount_cents <> 0),
  currency      text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  counterparty  text,
  receipt_ref   text,
  note          text,
  audit_id      text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_domain ON ledger_entries (domain_id);

CREATE TABLE listing_history (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain_id        bigint NOT NULL REFERENCES domains (id),
  at               timestamptz NOT NULL DEFAULT now(),
  source           text NOT NULL CHECK (source IN ('buy', 'import', 'list')),
  category         text CHECK (category IN ('geo', 'trend', 'b2b', 'collision', 'regulation', 'buzzword', 'other')),
  mode             text CHECK (mode IN ('bin', 'offer', 'hybrid')),
  bin_cents        integer CHECK (bin_cents > 0),
  floor_cents      integer CHECK (floor_cents > 0),
  min_offer_cents  integer CHECK (min_offer_cents >= 2000),
  lto_max_months   smallint CHECK (lto_max_months BETWEEN 2 AND 60),
  lander           text,
  override         boolean NOT NULL DEFAULT false,
  override_reason  text,
  approval_text    text,
  approval_at      timestamptz,
  audit_id         text
);
CREATE INDEX listing_history_domain ON listing_history (domain_id, at);

CREATE TABLE quotes (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  check_id                text NOT NULL,
  domain                  text NOT NULL CHECK (domain = lower(domain)),
  registrar               text NOT NULL,
  quoted_at               timestamptz NOT NULL DEFAULT now(),
  available               boolean,
  premium                 boolean,
  first_year_cents        integer,
  renewal_cents           integer,
  privacy_cents_per_year  integer,
  two_year_cents          integer,
  eligible                boolean NOT NULL,
  exclusion_reason        text,
  raw                     jsonb
);
CREATE INDEX quotes_check ON quotes (check_id);
CREATE INDEX quotes_domain ON quotes (domain, quoted_at);

CREATE TABLE purchases (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key  text NOT NULL UNIQUE,
  request_hash     text NOT NULL,
  domain           text NOT NULL CHECK (domain = lower(domain)),
  state            text NOT NULL CHECK (state IN ('created', 'register_sent', 'succeeded', 'failed', 'unknown')),
  dry_run          boolean NOT NULL DEFAULT false,
  registrar        text CHECK (registrar <> 'cloudflare'),
  check_id         text,
  charged_cents    integer CHECK (charged_cents >= 0),
  order_id         text,
  max_price_cents  integer NOT NULL CHECK (max_price_cents > 0),
  approval_text    text NOT NULL,
  approval_at      timestamptz NOT NULL,
  response         jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- Spec (00-architecture §4): one created/register_sent/succeeded/unknown row per domain (D4, Dvir 4 Oct 2026).
CREATE UNIQUE INDEX purchases_one_open_per_domain ON purchases (domain)
  WHERE state IN ('created', 'register_sent', 'succeeded', 'unknown');

CREATE TABLE receipts (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  purchase_id  bigint REFERENCES purchases (id),
  registrar    text NOT NULL,
  order_id     text NOT NULL,
  raw          jsonb,
  fetched_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id               text PRIMARY KEY CHECK (id ~ '^aud_[0-9a-f]{32}$'),
  at               timestamptz NOT NULL DEFAULT now(),
  token_id         bigint REFERENCES api_tokens (id),
  scope            text CHECK (scope IN ('read', 'write', 'admin')),
  method           text NOT NULL,
  path             text NOT NULL,
  idempotency_key  text,
  approval_text    text,
  approval_at      timestamptz,
  request          jsonb,
  status_code      integer NOT NULL,
  result_summary   text,
  client_ip        text
);
CREATE INDEX audit_log_at ON audit_log (at);

CREATE TABLE idempotency_keys (
  key                    text PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 255),
  request_hash           text NOT NULL,
  method                 text NOT NULL,
  path                   text NOT NULL,
  token_id               bigint REFERENCES api_tokens (id),
  state                  text NOT NULL CHECK (state IN ('in_progress', 'completed')),
  status_code            integer,
  response_body          text,
  response_content_type  text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  completed_at           timestamptz
);

CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER listing_history_append_only BEFORE UPDATE OR DELETE ON listing_history
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER listing_history_no_truncate BEFORE TRUNCATE ON listing_history
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- Down Migration

DROP TABLE idempotency_keys, audit_log, receipts, purchases, quotes, listing_history,
  ledger_entries, domains, deals, settings, api_tokens;
DROP FUNCTION reject_mutation();
```

- [ ] **Step 2: Write the Kysely types and client**

`src/db/types.ts`:
```ts
import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/** 'YYYY-MM-DD'. pg's date parser is overridden in client.ts so dates never become JS Date. */
export type DateString = string;
type Timestamp = ColumnType<Date, Date | string, Date | string>;
type TimestampDefault = ColumnType<Date, Date | string | undefined, Date | string>;
type Json = ColumnType<unknown, string, string>; // insert/update with JSON.stringify(...)

export type Scope = 'read' | 'write';
export type Category = 'geo' | 'trend' | 'b2b' | 'collision' | 'regulation' | 'buzzword' | 'other';
export type ListingMode = 'bin' | 'offer' | 'hybrid';
export type DomainStatus = 'pending_purchase' | 'owned' | 'listed' | 'sold' | 'dropped';
export type RegistrarApi = 'full' | 'manage' | 'none';
export type LedgerType =
  | 'registration' | 'renewal' | 'fee' | 'commission' | 'sale'
  | 'payout_fee' | 'refund' | 'tool' | 'ai' | 'adjustment';
export type PurchaseState = 'created' | 'register_sent' | 'succeeded' | 'failed' | 'unknown';

export interface ApiTokensTable {
  id: Generated<number>;
  name: string;
  scope: Scope;
  token_sha256: string;
  created_at: TimestampDefault;
  revoked_at: Timestamp | null;
  last_used_at: Timestamp | null;
}

export interface SettingsTable {
  id: Generated<boolean>;
  poc_cap_cents: Generated<number>;
  max_domains: Generated<number>;
  approval_max_age_hours: Generated<number>;
  lander_target: Generated<'afternic' | 'sedo' | 'custom'>;
  allowed_registrars: Generated<string[]>;
  geo_bin_min_cents: Generated<number>;
  geo_bin_max_cents: Generated<number>;
  high_value_categories: Generated<Category[]>;
  high_value_min_bin_cents: Generated<number>;
  high_value_guard_modes: Generated<ListingMode[]>;
  sedo_hybrid_as: Generated<'buy_now' | 'make_offer'>;
  updated_at: TimestampDefault;
}

export interface DealsTable {
  id: string;
  domain: string | null;
  strategy: string | null;
  status_note: string | null;
  created_at: TimestampDefault;
  updated_at: TimestampDefault;
}

export interface DomainsTable {
  id: Generated<number>;
  domain: string;
  deal_id: string | null;
  registrar: string | null;
  status: DomainStatus;
  buy_date: DateString | null;
  cost_cents: number | null;
  expiry_date: DateString | null;
  renewal_price_cents: number | null;
  renewals_used: Generated<number>;
  drop_date: DateString | null;
  category: Category | null;
  listing_mode: ListingMode | null;
  bin_cents: number | null;
  floor_cents: number | null;
  min_offer_cents: number | null;
  lto_max_months: number | null;
  display_name: string | null;
  lander: string | null;
  lander_ns: string[] | null;
  lander_set_at: Timestamp | null;
  ns_verified_at: Timestamp | null;
  registrar_api: RegistrarApi | null;
  sold_at: Timestamp | null;
  created_at: TimestampDefault;
  updated_at: TimestampDefault;
}

export interface LedgerEntriesTable {
  id: Generated<number>;
  occurred_on: DateString;
  domain_id: number | null;
  deal_id: string | null;
  type: LedgerType;
  amount_cents: number;
  currency: Generated<'USD'>;
  counterparty: string | null;
  receipt_ref: string | null;
  note: string | null;
  audit_id: string | null;
  created_at: TimestampDefault;
}

export interface ListingHistoryTable {
  id: Generated<number>;
  domain_id: number;
  at: TimestampDefault;
  source: 'buy' | 'import' | 'list';
  category: Category | null;
  mode: ListingMode | null;
  bin_cents: number | null;
  floor_cents: number | null;
  min_offer_cents: number | null;
  lto_max_months: number | null;
  lander: string | null;
  override: Generated<boolean>;
  override_reason: string | null;
  approval_text: string | null;
  approval_at: Timestamp | null;
  audit_id: string | null;
}

export interface QuotesTable {
  id: Generated<number>;
  check_id: string;
  domain: string;
  registrar: string;
  quoted_at: TimestampDefault;
  available: boolean | null;
  premium: boolean | null;
  first_year_cents: number | null;
  renewal_cents: number | null;
  privacy_cents_per_year: number | null;
  two_year_cents: number | null;
  eligible: boolean;
  exclusion_reason: string | null;
  raw: Json | null;
}

export interface PurchasesTable {
  id: Generated<number>;
  idempotency_key: string;
  request_hash: string;
  domain: string;
  state: PurchaseState;
  dry_run: Generated<boolean>;
  registrar: string | null;
  check_id: string | null;
  charged_cents: number | null;
  order_id: string | null;
  max_price_cents: number;
  approval_text: string;
  approval_at: Timestamp;
  response: Json | null;
  created_at: TimestampDefault;
  updated_at: TimestampDefault;
}

export interface ReceiptsTable {
  id: Generated<number>;
  purchase_id: number | null;
  registrar: string;
  order_id: string;
  raw: Json | null;
  fetched_at: TimestampDefault;
}

export interface AuditLogTable {
  id: string;
  at: TimestampDefault;
  token_id: number | null;
  scope: Scope | 'admin' | null;
  method: string;
  path: string;
  idempotency_key: string | null;
  approval_text: string | null;
  approval_at: Timestamp | null;
  request: Json | null;
  status_code: number;
  result_summary: string | null;
  client_ip: string | null;
}

export interface IdempotencyKeysTable {
  key: string;
  request_hash: string;
  method: string;
  path: string;
  token_id: number | null;
  state: 'in_progress' | 'completed';
  status_code: number | null;
  response_body: string | null;
  response_content_type: string | null;
  created_at: TimestampDefault;
  completed_at: Timestamp | null;
}

export interface Database {
  api_tokens: ApiTokensTable;
  settings: SettingsTable;
  deals: DealsTable;
  domains: DomainsTable;
  ledger_entries: LedgerEntriesTable;
  listing_history: ListingHistoryTable;
  quotes: QuotesTable;
  purchases: PurchasesTable;
  receipts: ReceiptsTable;
  audit_log: AuditLogTable;
  idempotency_keys: IdempotencyKeysTable;
}

export type AuditRowInsert = Insertable<AuditLogTable>;
export type DomainRow = Selectable<DomainsTable>;
export type DomainInsert = Insertable<DomainsTable>;
export type DomainUpdate = Updateable<DomainsTable>;
```
`src/db/client.ts`:
```ts
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import type { Database } from './types.js';

// bigint ids fit comfortably in a JS number here; dates stay 'YYYY-MM-DD' strings (no timezone shifts).
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export function createDb(url: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url, max: 10 }) }),
  });
}

export async function pingDb(db: Kysely<Database>, timeoutMs = 2000): Promise<boolean> {
  const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs).unref());
  const ping = sql`select 1`.execute(db).then(
    () => true,
    () => false,
  );
  return Promise.race([ping, timeout]);
}
```

- [ ] **Step 3: Write the test DB harness**

`tests/setup/global-db.ts`:
```ts
import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { TEST_DATABASE_URL } from '../helpers/env.js';

/** Refuse to wipe anything that isn't clearly a test database. */
export function assertTestDatabaseUrl(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to reset database "${name}": test DB names must end with _test`);
  }
}

export default async function setup(): Promise<void> {
  assertTestDatabaseUrl(TEST_DATABASE_URL);
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await client.end();
  await runner({
    databaseUrl: TEST_DATABASE_URL,
    dir: 'migrations',
    direction: 'up',
    migrationsTable: 'pgmigrations',
    count: Infinity,
    log: () => {},
  });
}
```
(If the installed node-pg-migrate's `runner` doesn't pick up `.sql` files automatically, check its docs for the SQL-migration option and pass it here and in the `migrate` script; the migration file itself must not change.)

`tests/helpers/db.ts`:
```ts
import { sql, type Kysely } from 'kysely';
import { createDb } from '../../src/db/client.js';
import type { Database, DomainInsert } from '../../src/db/types.js';
import { TEST_DATABASE_URL } from './env.js';

export const testDb: Kysely<Database> = createDb(TEST_DATABASE_URL);

const TABLES = [
  'idempotency_keys', 'audit_log', 'receipts', 'purchases', 'quotes', 'listing_history',
  'ledger_entries', 'domains', 'deals', 'api_tokens',
];

/** Wipe all data. Append-only triggers are bypassed with replication role on ONE connection. */
export async function resetDb(db: Kysely<Database>): Promise<void> {
  await db.connection().execute(async (conn) => {
    await sql`SET session_replication_role = replica`.execute(conn);
    await sql.raw(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`).execute(conn);
    await sql`SET session_replication_role = origin`.execute(conn);
    await sql`DELETE FROM settings`.execute(conn);
    await sql`INSERT INTO settings DEFAULT VALUES`.execute(conn);
  });
}

export async function insertOwnedDomain(db: Kysely<Database>, overrides: Partial<DomainInsert> = {}): Promise<number> {
  const row: DomainInsert = {
    domain: 'examplecityroofing.com',
    status: 'owned',
    registrar: 'porkbun',
    registrar_api: 'full',
    buy_date: '2026-10-04',
    cost_cents: 1108,
    expiry_date: '2027-10-04',
    renewal_price_cents: 1108,
    drop_date: '2028-10-04',
    category: 'geo',
    deal_id: null,
    display_name: null,
    listing_mode: null,
    bin_cents: null,
    floor_cents: null,
    min_offer_cents: null,
    lto_max_months: null,
    lander: null,
    lander_ns: null,
    lander_set_at: null,
    ns_verified_at: null,
    sold_at: null,
    ...overrides,
  };
  const r = await db.insertInto('domains').values(row).returning('id').executeTakeFirstOrThrow();
  return r.id;
}
```
`tests/setup/api.ts`:
```ts
import { afterAll, beforeEach } from 'vitest';
import { resetDb, testDb } from '../helpers/db.js';

beforeEach(async () => {
  await resetDb(testDb);
});

afterAll(async () => {
  await testDb.destroy();
});
```

- [ ] **Step 4: Write the failing schema tests**

`tests/unit/global-db-guard.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { assertTestDatabaseUrl } from '../setup/global-db.js';

describe('global setup refuses non-test DB', () => {
  it('throws for a DB name without _test', () => {
    expect(() => assertTestDatabaseUrl('postgres://dt:dt@localhost:5433/domain_trading')).toThrow(/_test/);
  });
  it('accepts a _test DB', () => {
    expect(() => assertTestDatabaseUrl('postgres://dt:dt@localhost:5433/domain_trading_test')).not.toThrow();
  });
});
```
`tests/api/schema.test.ts`:
```ts
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { insertOwnedDomain, testDb as db } from '../helpers/db.js';

const ledgerRow = (domainId: number) => ({
  occurred_on: '2026-10-04',
  domain_id: domainId,
  deal_id: 'D-002',
  type: 'registration' as const,
  amount_cents: -1108,
  counterparty: 'porkbun',
  receipt_ref: 'porkbun:123',
  note: 'test',
  audit_id: null,
});

describe('schema: append-only (AL-2, B-23, LH-3)', () => {
  it('AL-2/B-23: UPDATE ledger_entries raises', async () => {
    const id = await insertOwnedDomain(db);
    await db.insertInto('ledger_entries').values(ledgerRow(id)).execute();
    await expect(db.updateTable('ledger_entries').set({ note: 'x' }).execute()).rejects.toThrow(/append-only/);
  });

  it('AL-2: DELETE ledger_entries raises', async () => {
    const id = await insertOwnedDomain(db);
    await db.insertInto('ledger_entries').values(ledgerRow(id)).execute();
    await expect(db.deleteFrom('ledger_entries').execute()).rejects.toThrow(/append-only/);
  });

  it('AL-2: UPDATE and DELETE audit_log raise', async () => {
    await db
      .insertInto('audit_log')
      .values({ id: 'aud_' + '0'.repeat(32), method: 'POST', path: '/x', status_code: 200 })
      .execute();
    await expect(db.updateTable('audit_log').set({ status_code: 500 }).execute()).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom('audit_log').execute()).rejects.toThrow(/append-only/);
  });

  it('LH-3: UPDATE and DELETE listing_history raise', async () => {
    const id = await insertOwnedDomain(db);
    await db
      .insertInto('listing_history')
      .values({ domain_id: id, source: 'list', category: 'geo', mode: 'bin', bin_cents: 39900 })
      .execute();
    await expect(db.updateTable('listing_history').set({ bin_cents: 1 }).execute()).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom('listing_history').execute()).rejects.toThrow(/append-only/);
  });

  it('TRUNCATE on append-only tables raises (outside the test reset)', async () => {
    await expect(sql`TRUNCATE ledger_entries`.execute(db)).rejects.toThrow(/append-only/);
    await expect(sql`TRUNCATE audit_log CASCADE`.execute(db)).rejects.toThrow(/append-only/);
  });
});

describe('schema: domains CHECKs', () => {
  it('RN-3: renewals_used = 2 fails', async () => {
    await expect(insertOwnedDomain(db, { renewals_used: 2 })).rejects.toThrow(/renewals_used/);
  });

  it('rejects an uppercase domain', async () => {
    await expect(insertOwnedDomain(db, { domain: 'Example.com' })).rejects.toThrow(/domains_domain_check/);
  });

  it('rejects min_offer below $20', async () => {
    await expect(insertOwnedDomain(db, { min_offer_cents: 1999 })).rejects.toThrow(/min_offer/);
  });

  it('drop_date must equal expiry + 1 year while renewals_used = 0', async () => {
    await expect(insertOwnedDomain(db, { drop_date: '2029-10-04' })).rejects.toThrow(/domains_drop_date_rule/);
  });

  it('29 Feb expiry → 28 Feb drop_date is accepted', async () => {
    await expect(
      insertOwnedDomain(db, { expiry_date: '2028-02-29', drop_date: '2029-02-28' }),
    ).resolves.toBeTypeOf('number');
  });

  it('an owned domain needs a category', async () => {
    await expect(insertOwnedDomain(db, { category: null })).rejects.toThrow(/domains_category_once_owned/);
  });

  it('an owned domain needs registrar, cost and dates', async () => {
    await expect(insertOwnedDomain(db, { cost_cents: null })).rejects.toThrow(/domains_owned_fields/);
  });

  it('a pending_purchase row may have no dates yet', async () => {
    await expect(
      insertOwnedDomain(db, {
        status: 'pending_purchase', registrar: null, registrar_api: null, buy_date: null,
        cost_cents: null, expiry_date: null, drop_date: null, renewal_price_cents: null,
      }),
    ).resolves.toBeTypeOf('number');
  });

  it('cloudflare is never a registrar', async () => {
    await expect(insertOwnedDomain(db, { registrar: 'cloudflare' })).rejects.toThrow(/registrar/);
  });

  it('dates come back as YYYY-MM-DD strings', async () => {
    const id = await insertOwnedDomain(db);
    const row = await db.selectFrom('domains').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.expiry_date).toBe('2027-10-04');
    expect(typeof row.id).toBe('number');
  });
});

describe('schema: purchases', () => {
  const purchase = (key: string, state: 'created' | 'succeeded' | 'failed') => ({
    idempotency_key: key,
    request_hash: 'h',
    domain: 'examplecityroofing.com',
    state,
    max_price_cents: 1150,
    approval_text: 'yes buy examplecityroofing.com',
    approval_at: new Date(),
  });

  it('an unknown purchase also blocks a new one (D4)', async () => {
    await db.insertInto('purchases').values({ ...purchase('k1', 'failed'), state: 'unknown' }).execute();
    await expect(db.insertInto('purchases').values(purchase('k2', 'created')).execute()).rejects.toThrow(
      /purchases_one_open_per_domain/,
    );
  });

  it('only one open (created/register_sent/succeeded/unknown) purchase per domain', async () => {
    await db.insertInto('purchases').values(purchase('k1', 'created')).execute();
    await expect(db.insertInto('purchases').values(purchase('k2', 'succeeded')).execute()).rejects.toThrow(
      /purchases_one_open_per_domain/,
    );
  });

  it('failed purchases do not block a new one', async () => {
    await db.insertInto('purchases').values(purchase('k1', 'failed')).execute();
    await expect(db.insertInto('purchases').values(purchase('k2', 'created')).execute()).resolves.toBeDefined();
  });
});

describe('schema: settings', () => {
  it('has exactly one row with the spec defaults', async () => {
    const rows = await db.selectFrom('settings').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      poc_cap_cents: 50000,
      max_domains: 10,
      approval_max_age_hours: 72,
      lander_target: 'afternic',
      allowed_registrars: ['porkbun'],
      geo_bin_min_cents: 29900,
      geo_bin_max_cents: 49900,
      high_value_categories: ['trend', 'b2b', 'collision', 'regulation', 'buzzword'],
      high_value_min_bin_cents: 250000,
      high_value_guard_modes: ['bin'],
      sedo_hybrid_as: 'buy_now',
    });
  });

  it('a second settings row is impossible', async () => {
    await expect(sql`INSERT INTO settings DEFAULT VALUES`.execute(db)).rejects.toThrow(/settings_pkey/);
  });

  it('cloudflare cannot be allowed', async () => {
    await expect(
      db.updateTable('settings').set({ allowed_registrars: ['porkbun', 'cloudflare'] }).execute(),
    ).rejects.toThrow(/allowed_registrars/);
  });
});
```

- [ ] **Step 5: Run to verify**

Run: `npx vitest run`
Expected: before Step 1–3 code exists, FAIL on imports; after, **all PASS**. If a constraint-name regex doesn't match, check the actual Postgres error message (`\d domains` in psql) and fix the *migration* (e.g. name the constraint) rather than loosening the test.

- [ ] **Step 6: Apply the migration to the dev DB too**

Run: `cp -n .env.example .env; npm run migrate up`
Expected: `Migrations complete!` (`.env` is gitignored.)

- [ ] **Step 7: Commit**
```bash
git add migrations/ src/db/ tests/
git commit -m "feat: initial schema with CHECKs, partial index, append-only triggers; test DB harness"
```

---

### Task 3: App skeleton: error format, `/health`, route table

**Files:**
- Create: `src/http/errors.ts`, `src/http/methods.ts`, `src/api/health.ts`, `src/app.ts`, `src/main.ts`, `tests/helpers/app.ts`, `tests/api/health.test.ts`, `tests/api/errors.test.ts`

**Interfaces:**
- Consumes: `Config`, `loadConfig`, `adapterStatus`, `createDb`, `pingDb`, `testDb`, `testEnv`.
- Produces:
  - `class AppError extends Error { status: number; code: string; details: Record<string, unknown> }` with `constructor(status, code, message, details = {})`
  - `errorBody(code: string, message: string, details?: Record<string, unknown>): { error: { code; message; details } }`
  - `registerErrorHandling(app: FastifyInstance): void`
  - `isMutating(method: string): boolean` (true for anything except GET/HEAD/OPTIONS)
  - `interface AppDeps { config: Config; db: Kysely<Database>; now?: () => number; audit?: AuditWriter; logger?: FastifyServerOptions['logger']; registerExtraRoutes?: (app: FastifyInstance) => void }` (`audit` is consumed from Task 5; in this task declare `audit?: unknown` and narrow in Task 5)
  - `buildApp(deps: AppDeps): Promise<FastifyInstance>`; the instance is decorated with `routeTable: { method: string; url: string }[]`
  - `makeApp(opts?: { now?: () => number; audit?: AuditWriter; testRoutes?: boolean; logStream?: NodeJS.WritableStream; db?: Kysely<Database>; env?: Record<string,string> }): Promise<FastifyInstance>`

- [ ] **Step 1: Write the failing tests**

`tests/helpers/app.ts` (initial version; Task 4–6 extend the test routes):
```ts
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { Writable } from 'node:stream';
import { z } from 'zod';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { Database } from '../../src/db/types.js';
import { testDb } from './db.js';
import { testEnv } from './env.js';

/** Counts handler executions, to prove side effects happen once. */
export const sideEffects = { count: 0 };

export function registerTestRoutes(app: FastifyInstance): void {
  app.get('/__test/ping', async () => ({ pong: true }));

  app.post('/__test/echo', async (req, reply) => {
    const body = z
      .object({
        value: z.string(),
        approval_ref: z.object({ text: z.string(), approved_at: z.string() }).strict().optional(),
      })
      .strict()
      .parse(req.body);
    sideEffects.count += 1;
    return reply.code(201).send({ echo: body.value, n: sideEffects.count });
  });

  app.post('/__test/boom', async () => {
    sideEffects.count += 1;
    throw new Error('boom');
  });

  app.post('/__test/slow', async (_req, reply) => {
    await new Promise((r) => setTimeout(r, 300));
    sideEffects.count += 1;
    return reply.code(201).send({ ok: true });
  });
}

export function logCapture(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  return { stream, text: () => chunks.join('') };
}

export async function makeApp(
  opts: {
    now?: () => number;
    audit?: import('../../src/http/audit.js').AuditWriter;
    testRoutes?: boolean;
    logStream?: Writable;
    db?: Kysely<Database>;
    env?: Record<string, string>;
  } = {},
): Promise<FastifyInstance> {
  sideEffects.count = 0;
  const app = await buildApp({
    config: loadConfig(testEnv(opts.env)),
    db: opts.db ?? testDb,
    now: opts.now,
    audit: opts.audit,
    logger: opts.logStream ? { level: 'info', stream: opts.logStream } : false,
    registerExtraRoutes: opts.testRoutes === false ? undefined : registerTestRoutes,
  });
  await app.ready();
  return app;
}
```
(The `audit` option's type import resolves once Task 5 creates `src/http/audit.ts`. Until then, type it as `unknown`.)

`tests/api/health.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createDb } from '../../src/db/client.js';
import { makeApp } from '../helpers/app.js';

let app: FastifyInstance;
afterEach(async () => app?.close());

describe('GET /health (R-11)', () => {
  it('needs no auth and returns exactly status, db, version, adapters', async () => {
    app = await makeApp({ testRoutes: false });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(['adapters', 'db', 'status', 'version']);
    expect(body).toMatchObject({ status: 'ok', db: 'ok' });
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    for (const a of body.adapters) expect(Object.keys(a).sort()).toEqual(['enabled', 'name']);
  });

  it('never reveals secrets or key prefixes', async () => {
    app = await makeApp({ testRoutes: false });
    const text = (await app.inject({ method: 'GET', url: '/health' })).body;
    expect(text).not.toMatch(/pk1_|sk1_|fake_|github_pat/);
  });

  it('returns 503 degraded when the DB is down', async () => {
    const deadDb = createDb('postgres://dt:dt@127.0.0.1:1/nothing_test');
    app = await makeApp({ testRoutes: false, db: deadDb });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'degraded', db: 'down' });
    await deadDb.destroy();
  });
});
```
`tests/api/errors.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../helpers/app.js';

let app: FastifyInstance;
afterEach(async () => app?.close());

describe('error format', () => {
  it('unknown route (with auth handled later) → error envelope', async () => {
    app = await makeApp({ testRoutes: false });
    const res = await app.inject({ method: 'GET', url: '/health/nope' });
    // Before Task 4 this is 404 NOT_FOUND; after Task 4 auth runs first and it is 401 UNAUTHORIZED.
    const body = res.json();
    expect(body.error).toMatchObject({ code: expect.stringMatching(/^[A-Z_]+$/), message: expect.any(String) });
    expect(body.error.details).toEqual(expect.any(Object));
  });

  it('exposes a route table of every registered route', async () => {
    app = await makeApp({ testRoutes: false });
    expect(app.routeTable).toEqual(expect.arrayContaining([{ method: 'GET', url: '/health' }]));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project api tests/api/health.test.ts tests/api/errors.test.ts`
Expected: FAIL (`Cannot find module '../../src/app.js'`).

- [ ] **Step 3: Implement**

`src/http/methods.ts`:
```ts
/** Methods that change state: they need WRITE scope, an Idempotency-Key and an audit row. */
export function isMutating(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}
```
`src/http/errors.ts`:
```ts
import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function errorBody(code: string, message: string, details: Record<string, unknown> = {}) {
  return { error: { code, message, details } };
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send(errorBody(err.code, err.message, err.details));
    }
    if (err instanceof ZodError) {
      const issues = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      return reply.code(422).send(errorBody('VALIDATION_ERROR', 'Request body is invalid', { issues }));
    }
    const fe = err as FastifyError;
    if (typeof fe.code === 'string' && fe.code.startsWith('FST_ERR_CTP_')) {
      return reply.code(fe.statusCode ?? 400).send(errorBody('INVALID_BODY', fe.message));
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send(errorBody('INTERNAL', 'Internal error'));
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send(errorBody('NOT_FOUND', 'Route not found')));
}
```
`src/api/health.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { Config } from '../config.js';
import { pingDb } from '../db/client.js';
import type { Database } from '../db/types.js';
import { adapterStatus } from '../registrars/registry.js';

export function registerHealth(app: FastifyInstance, config: Config, db: Kysely<Database>): void {
  app.get('/health', async (_req, reply) => {
    const dbOk = await pingDb(db);
    return reply.code(dbOk ? 200 : 503).send({
      status: dbOk ? 'ok' : 'degraded',
      db: dbOk ? 'ok' : 'down',
      version: config.version,
      adapters: adapterStatus(config).map(({ name, enabled }) => ({ name, enabled })),
    });
  });
}
```
`src/app.ts` (Tasks 4–7 insert their `register*` calls at the marked places; **the order of these calls is the contract**):
```ts
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Kysely } from 'kysely';
import { registerHealth } from './api/health.js';
import type { Config } from './config.js';
import type { Database } from './db/types.js';
import { registerErrorHandling } from './http/errors.js';

declare module 'fastify' {
  interface FastifyInstance {
    routeTable: { method: string; url: string }[];
  }
}

export interface AppDeps {
  config: Config;
  db: Kysely<Database>;
  /** Clock in ms, for the rate limiter. */
  now?: () => number;
  audit?: unknown; // narrowed to AuditWriter in Task 5
  logger?: FastifyServerOptions['logger'];
  /** Test-only routes. Production never passes this. */
  registerExtraRoutes?: (app: FastifyInstance) => void;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ?? { level: deps.config.logLevel, redact: ['req.headers.authorization'] },
    trustProxy: true,
    bodyLimit: 64 * 1024,
  });

  const routeTable: { method: string; url: string }[] = [];
  app.decorate('routeTable', routeTable);
  app.addHook('onRoute', (r) => {
    for (const method of [r.method].flat()) routeTable.push({ method, url: r.url });
  });

  registerErrorHandling(app);
  // onRequest:  [Task 5] registerAuditId  →  [Task 4] registerAuth
  // preHandler: [Task 7] registerRateLimit →  [Task 4] registerScope  →  [Task 6] registerIdempotency (preHandler part)
  // onSend:     [Task 6] idempotency store →  [Task 5] registerAuditWrite

  registerHealth(app, deps.config, deps.db);
  deps.registerExtraRoutes?.(app);
  return app;
}
```
`src/main.ts`:
```ts
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';

const config = loadConfig(process.env);
const db = createDb(config.databaseUrl);
const app = await buildApp({ config, db });

const shutdown = async () => {
  await app.close();
  await db.destroy();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: config.port, host: config.host });
```
Note: `routeTable` filters out Fastify's auto-generated `HEAD` routes? It does not: Fastify registers HEAD for each GET, and `onRoute` sees them. That's fine; tests that iterate it must skip `HEAD`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 5: Smoke-run the server**

Run: `npm run dev` in one shell, `curl -s localhost:3000/health` in another, then stop the server.
Expected: `{"status":"ok","db":"ok","version":"0.1.0","adapters":[…all enabled:false…]}`

- [ ] **Step 6: Commit**
```bash
git add src/ tests/
git commit -m "feat: Fastify app skeleton, error envelope, /health, route table"
```

---

### Task 4: Bearer auth, scopes, token admin functions

**Files:**
- Create: `src/auth/tokens.ts`, `src/admin/tokens.ts`, `src/http/auth.ts`, `tests/helpers/tokens.ts`, `tests/unit/tokens.test.ts`, `tests/api/auth.test.ts`, `tests/api/admin-tokens.test.ts`
- Modify: `src/app.ts` (register auth + scope hooks)

**Interfaces:**
- Consumes: `AppError`, `isMutating`, `Database`, `testDb`, `makeApp`.
- Produces:
  - `generateToken(): string` → `'dt_' + base64url(32 random bytes)`
  - `hashToken(token: string): string` → SHA-256 hex
  - `interface AuthContext { tokenId: number; scope: 'read' | 'write'; name: string }`
  - `FastifyRequest.auth: AuthContext | null`
  - `registerAuth(app, db): void` (onRequest), `registerScope(app): void` (preHandler)
  - `PUBLIC_PATHS: ReadonlySet<string>` = `{'/health'}`
  - `createApiToken(db, { name: string; scope: 'read'|'write' }): Promise<{ id: number; token: string }>` (writes an `admin` audit row)
  - `revokeApiToken(db, id: number): Promise<boolean>` (writes an `admin` audit row when something was revoked)
  - `listApiTokens(db): Promise<{ id; name; scope; created_at; revoked_at; last_used_at }[]>`
  - `issueToken(scope: 'read'|'write', name?: string): Promise<{ id: number; token: string; auth: { authorization: string } }>`
  - `newAuditId(): string` → `'aud_' + 32 hex` (defined here in `src/http/audit.ts` as a one-function file; Task 5 adds the rest of that file)

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/tokens.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { generateToken, hashToken } from '../../src/auth/tokens.js';

describe('tokens', () => {
  it('generates dt_ + ≥32 random bytes (base64url, 43 chars)', () => {
    const t = generateToken();
    expect(t).toMatch(/^dt_[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toBe(t);
  });

  it('hashes to 64 lowercase hex chars, deterministically', () => {
    expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
```

- [ ] **Step 2: Write the failing API tests**

`tests/helpers/tokens.ts`:
```ts
import { createApiToken } from '../../src/admin/tokens.js';
import { testDb } from './db.js';

let n = 0;
export async function issueToken(scope: 'read' | 'write', name?: string) {
  const { id, token } = await createApiToken(testDb, { name: name ?? `test-${scope}-${++n}`, scope });
  return { id, token, auth: { authorization: `Bearer ${token}` } };
}
```
`tests/api/auth.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { revokeApiToken } from '../../src/admin/tokens.js';
import { makeApp } from '../helpers/app.js';
import { testDb } from '../helpers/db.js';
import { issueToken } from '../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());

const concrete = (url: string) => url.replace(/:(\w+)/g, '$1');

describe('auth (AU)', () => {
  it('AU-1: no Authorization → 401 on every route except /health', async () => {
    app = await makeApp({ testRoutes: false });
    const routes = app.routeTable.filter((r) => r.method !== 'HEAD' && r.url !== '/health');
    for (const r of routes) {
      const res = await app.inject({ method: r.method as 'GET', url: concrete(r.url) });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHORIZED');
    }
    // and the test app's routes too
    const t = await makeApp();
    for (const [method, url] of [['GET', '/__test/ping'], ['POST', '/__test/echo']] as const) {
      expect((await t.inject({ method, url })).statusCode).toBe(401);
    }
    await t.close();
  });

  it('AU-1: unknown routes also answer 401 without a token (no route probing)', async () => {
    app = await makeApp();
    expect((await app.inject({ method: 'GET', url: '/nope' })).statusCode).toBe(401);
  });

  it('AU-2: malformed or unknown token → 401', async () => {
    app = await makeApp();
    for (const authorization of ['Bearer', 'Basic abc', 'Bearer dt_unknown', 'dt_x', 'Bearer a b']) {
      const res = await app.inject({ method: 'GET', url: '/__test/ping', headers: { authorization } });
      expect(res.statusCode, authorization).toBe(401);
    }
  });

  it('accepts a case-insensitive "bearer" scheme', async () => {
    app = await makeApp();
    const { token } = await issueToken('read');
    const res = await app.inject({ method: 'GET', url: '/__test/ping', headers: { authorization: `bearer ${token}` } });
    expect(res.statusCode).toBe(200);
  });

  it('AU-3: READ token on a POST → 403 SCOPE_FORBIDDEN, handler not run', async () => {
    app = await makeApp();
    const { auth } = await issueToken('read');
    const res = await app.inject({
      method: 'POST', url: '/__test/echo',
      headers: { ...auth, 'idempotency-key': 'k-au3' }, payload: { value: 'x' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('SCOPE_FORBIDDEN');
    const { sideEffects } = await import('../helpers/app.js');
    expect(sideEffects.count).toBe(0);
    // AU-3's "audit row written" assertion is added in Task 5.
  });

  it('AU-4: READ token on GET → 200', async () => {
    app = await makeApp();
    const { auth } = await issueToken('read');
    expect((await app.inject({ method: 'GET', url: '/__test/ping', headers: auth })).statusCode).toBe(200);
  });

  it('AU-5: WRITE token on GET → 200', async () => {
    app = await makeApp();
    const { auth } = await issueToken('write');
    expect((await app.inject({ method: 'GET', url: '/__test/ping', headers: auth })).statusCode).toBe(200);
  });

  it('AU-6: revoked token → 401 on the very next request', async () => {
    app = await makeApp();
    const { id, auth } = await issueToken('write');
    expect((await app.inject({ method: 'GET', url: '/__test/ping', headers: auth })).statusCode).toBe(200);
    await revokeApiToken(testDb, id);
    expect((await app.inject({ method: 'GET', url: '/__test/ping', headers: auth })).statusCode).toBe(401);
  });

  it('AU-7: no route creates, lists or reveals tokens; no settings route', async () => {
    app = await makeApp({ testRoutes: false });
    for (const r of app.routeTable) {
      expect(r.url).not.toMatch(/token|settings/i);
    }
  });

  it('updates last_used_at', async () => {
    app = await makeApp();
    const { id, auth } = await issueToken('read');
    await app.inject({ method: 'GET', url: '/__test/ping', headers: auth });
    const row = await testDb.selectFrom('api_tokens').select('last_used_at').where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.last_used_at).not.toBeNull();
  });
});
```
`tests/api/admin-tokens.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { createApiToken, listApiTokens, revokeApiToken } from '../../src/admin/tokens.js';
import { hashToken } from '../../src/auth/tokens.js';
import { testDb as db } from '../helpers/db.js';

describe('admin token functions', () => {
  it('stores only the SHA-256, never the plain token', async () => {
    const { id, token } = await createApiToken(db, { name: 'gavriel-read', scope: 'read' });
    const row = await db.selectFrom('api_tokens').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.token_sha256).toBe(hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it('writes an admin audit row without the token', async () => {
    const { token } = await createApiToken(db, { name: 'gavriel-write', scope: 'write' });
    const rows = await db.selectFrom('audit_log').selectAll().where('scope', '=', 'admin').execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ method: 'ADMIN', path: 'token create', status_code: 200 });
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('rejects a second active token with the same name, allows it after revoke', async () => {
    const { id } = await createApiToken(db, { name: 'gavriel-read', scope: 'read' });
    await expect(createApiToken(db, { name: 'gavriel-read', scope: 'read' })).rejects.toThrow();
    expect(await revokeApiToken(db, id)).toBe(true);
    await expect(createApiToken(db, { name: 'gavriel-read', scope: 'read' })).resolves.toBeDefined();
  });

  it('revoke is false for an unknown or already revoked id', async () => {
    const { id } = await createApiToken(db, { name: 'x', scope: 'read' });
    expect(await revokeApiToken(db, id)).toBe(true);
    expect(await revokeApiToken(db, id)).toBe(false);
    expect(await revokeApiToken(db, 99999)).toBe(false);
  });

  it('list never includes the hash', async () => {
    await createApiToken(db, { name: 'x', scope: 'read' });
    const list = await listApiTokens(db);
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0]!)).not.toContain('token_sha256');
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run`
Expected: FAIL (modules missing).

- [ ] **Step 4: Implement**

`src/auth/tokens.ts`:
```ts
import { createHash, randomBytes } from 'node:crypto';

export function generateToken(): string {
  return `dt_${randomBytes(32).toString('base64url')}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
```
`src/http/audit.ts` (first function only; Task 5 adds the rest):
```ts
import { randomBytes } from 'node:crypto';

export function newAuditId(): string {
  return `aud_${randomBytes(16).toString('hex')}`;
}
```
`src/admin/tokens.ts`:
```ts
import type { Kysely } from 'kysely';
import { generateToken, hashToken } from '../auth/tokens.js';
import type { Database, Scope } from '../db/types.js';
import { newAuditId } from '../http/audit.js';

export async function createApiToken(
  db: Kysely<Database>,
  input: { name: string; scope: Scope },
): Promise<{ id: number; token: string }> {
  const token = generateToken();
  return db.transaction().execute(async (trx) => {
    const { id } = await trx
      .insertInto('api_tokens')
      .values({ name: input.name, scope: input.scope, token_sha256: hashToken(token) })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('audit_log')
      .values({
        id: newAuditId(),
        scope: 'admin',
        method: 'ADMIN',
        path: 'token create',
        request: JSON.stringify({ name: input.name, scope: input.scope }),
        status_code: 200,
        result_summary: `created token ${id}`,
      })
      .execute();
    return { id, token };
  });
}

export async function revokeApiToken(db: Kysely<Database>, id: number): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const r = await trx
      .updateTable('api_tokens')
      .set({ revoked_at: new Date() })
      .where('id', '=', id)
      .where('revoked_at', 'is', null)
      .returning('id')
      .executeTakeFirst();
    if (!r) return false;
    await trx
      .insertInto('audit_log')
      .values({
        id: newAuditId(),
        scope: 'admin',
        method: 'ADMIN',
        path: 'token revoke',
        request: JSON.stringify({ id }),
        status_code: 200,
        result_summary: `revoked token ${id}`,
      })
      .execute();
    return true;
  });
}

export async function listApiTokens(db: Kysely<Database>) {
  return db
    .selectFrom('api_tokens')
    .select(['id', 'name', 'scope', 'created_at', 'revoked_at', 'last_used_at'])
    .orderBy('id')
    .execute();
}
```
`src/http/auth.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { hashToken } from '../auth/tokens.js';
import type { Database, Scope } from '../db/types.js';
import { AppError } from './errors.js';
import { isMutating } from './methods.js';

export interface AuthContext {
  tokenId: number;
  scope: Scope;
  name: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/health']);
const BEARER = /^Bearer ([A-Za-z0-9_-]+)$/i;

export function pathOf(url: string): string {
  return url.split('?')[0] ?? url;
}

export function registerAuth(app: FastifyInstance, db: Kysely<Database>): void {
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    if (PUBLIC_PATHS.has(pathOf(req.url))) return;
    const m = BEARER.exec(req.headers.authorization ?? '');
    if (!m?.[1]) throw new AppError(401, 'UNAUTHORIZED', 'Missing or invalid bearer token');
    const row = await db
      .updateTable('api_tokens')
      .set({ last_used_at: new Date() })
      .where('token_sha256', '=', hashToken(m[1]))
      .where('revoked_at', 'is', null)
      .returning(['id', 'scope', 'name'])
      .executeTakeFirst();
    if (!row) throw new AppError(401, 'UNAUTHORIZED', 'Missing or invalid bearer token');
    req.auth = { tokenId: row.id, scope: row.scope, name: row.name };
  });
}

export function registerScope(app: FastifyInstance): void {
  app.addHook('preHandler', async (req) => {
    if (!req.auth) return; // public route
    if (isMutating(req.method) && req.auth.scope !== 'write') {
      throw new AppError(403, 'SCOPE_FORBIDDEN', 'This token may only call GET endpoints');
    }
  });
}
```
`src/app.ts`: add imports and calls in the marked order:
```ts
import { registerAuth, registerScope } from './http/auth.js';
// …inside buildApp, after registerErrorHandling(app):
  registerAuth(app, deps.db);   // onRequest
  registerScope(app);           // preHandler
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS. If `errors.test.ts` "unknown route" now gets 401, that's expected (its assertion only checks the envelope).

- [ ] **Step 6: Commit**
```bash
git add src/ tests/
git commit -m "feat: bearer auth with READ/WRITE scopes, token admin functions (AU-1..7)"
```

---

### Task 5: Audit row on every POST

**Files:**
- Modify: `src/http/audit.ts` (add writer + hooks), `src/app.ts`, `tests/helpers/app.ts` (type the `audit` option), `tests/api/auth.test.ts` (complete AU-3)
- Create: `src/http/redact.ts`, `tests/unit/redact.test.ts`, `tests/api/audit.test.ts`

**Interfaces:**
- Consumes: `AuthContext`, `errorBody`, `isMutating`, `newAuditId`, `AuditRowInsert`.
- Produces:
  - `interface AuditWriter { write(row: AuditRowInsert): Promise<void> }`
  - `dbAuditWriter(db): AuditWriter`
  - `FastifyRequest.auditId: string | null` (set for every mutating request, before auth)
  - `FastifyRequest.auditSummary: string | null` (handlers may set a custom summary)
  - `registerAuditId(app): void` (onRequest), `registerAuditWrite(app, writer): void` (onSend)
  - `redact(value: unknown): unknown`
  - `AppDeps.audit?: AuditWriter` (replaces `unknown`)

- [ ] **Step 1: Write the failing tests**

`tests/unit/redact.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { redact } from '../../src/http/redact.js';

describe('redact', () => {
  it('masks secret-looking keys at any depth, keeps the rest', () => {
    expect(
      redact({
        domain: 'x.com',
        api_key: 'pk1_x',
        nested: { secretApiKey: 's', list: [{ password: 'p', ok: 1 }] },
        godaddy_pat: 'g',
        authorization: 'Bearer t',
        approval_ref: { text: 'yes buy x.com', approved_at: '2026-10-04T09:00:00+03:00' },
      }),
    ).toEqual({
      domain: 'x.com',
      api_key: '[REDACTED]',
      nested: { secretApiKey: '[REDACTED]', list: [{ password: '[REDACTED]', ok: 1 }] },
      godaddy_pat: '[REDACTED]',
      authorization: '[REDACTED]',
      approval_ref: { text: 'yes buy x.com', approved_at: '2026-10-04T09:00:00+03:00' },
    });
  });

  it('passes through primitives and null', () => {
    expect(redact(null)).toBeNull();
    expect(redact('a')).toBe('a');
    expect(redact(3)).toBe(3);
  });
});
```
`tests/api/audit.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../helpers/app.js';
import { testDb as db } from '../helpers/db.js';
import { issueToken } from '../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());

const httpAuditRows = () =>
  db.selectFrom('audit_log').selectAll().where('method', '<>', 'ADMIN').orderBy('at').execute();

const approval = { text: 'yes buy examplecityroofing.com', approved_at: '2026-10-04T09:10:00+03:00' };

describe('audit (AL)', () => {
  it('AL-1: exactly one audit row per POST: success, 401, 403, 400, 422, 500', async () => {
    app = await makeApp();
    const w = await issueToken('write');
    const r = await issueToken('read');
    const calls = [
      { headers: { ...w.auth, 'idempotency-key': 'a1' }, payload: { value: 'ok' }, url: '/__test/echo' },  // 201
      { headers: {}, payload: { value: 'x' }, url: '/__test/echo' },                                          // 401
      { headers: { ...r.auth, 'idempotency-key': 'a2' }, payload: { value: 'x' }, url: '/__test/echo' },  // 403
      { headers: { ...w.auth }, payload: { value: 'x' }, url: '/__test/echo' },                              // 400 (Task 6)
      { headers: { ...w.auth, 'idempotency-key': 'a3' }, payload: { nope: 1 }, url: '/__test/echo' },     // 422
      { headers: { ...w.auth, 'idempotency-key': 'a4' }, payload: {}, url: '/__test/boom' },               // 500
    ];
    for (const c of calls) await app.inject({ method: 'POST', ...c });
    const rows = await httpAuditRows();
    expect(rows).toHaveLength(calls.length);
    expect(new Set(rows.map((x) => x.id)).size).toBe(calls.length);
  });

  it('GET requests write no audit row', async () => {
    app = await makeApp();
    const { auth } = await issueToken('read');
    await app.inject({ method: 'GET', url: '/__test/ping', headers: auth });
    expect(await httpAuditRows()).toHaveLength(0);
  });

  it('AL-3: row has scope, token id, approval text/time, idempotency key, status, summary, request; no token', async () => {
    app = await makeApp();
    const w = await issueToken('write');
    await app.inject({
      method: 'POST', url: '/__test/echo',
      headers: { ...w.auth, 'idempotency-key': 'k-al3' },
      payload: { value: 'hello', approval_ref: approval },
    });
    const [row] = await httpAuditRows();
    expect(row).toMatchObject({
      token_id: w.id,
      scope: 'write',
      method: 'POST',
      path: '/__test/echo',
      idempotency_key: 'k-al3',
      approval_text: approval.text,
      status_code: 201,
      result_summary: 'ok',
    });
    expect(row!.id).toMatch(/^aud_[0-9a-f]{32}$/);
    expect(row!.approval_at?.toISOString()).toBe('2026-10-04T06:10:00.000Z');
    expect(row!.request).toMatchObject({ value: 'hello' });
    expect(JSON.stringify(row)).not.toContain(w.token);
  });

  it('AL-3: an error row carries the error code as summary', async () => {
    app = await makeApp();
    const w = await issueToken('write');
    await app.inject({
      method: 'POST', url: '/__test/echo', headers: { ...w.auth, 'idempotency-key': 'k-422' }, payload: { nope: 1 },
    });
    const [row] = await httpAuditRows();
    expect(row).toMatchObject({ status_code: 422, result_summary: 'VALIDATION_ERROR' });
  });

  it('a 401 row has no token and scope', async () => {
    app = await makeApp();
    await app.inject({ method: 'POST', url: '/__test/echo', payload: { value: 'x' } });
    const [row] = await httpAuditRows();
    expect(row).toMatchObject({ token_id: null, scope: null, status_code: 401, result_summary: 'UNAUTHORIZED' });
  });

  it('an unparseable approved_at keeps the text and stores a null time', async () => {
    app = await makeApp();
    const w = await issueToken('write');
    await app.inject({
      method: 'POST', url: '/__test/echo', headers: { ...w.auth, 'idempotency-key': 'k-bad-date' },
      payload: { value: 'x', approval_ref: { text: 'yes', approved_at: 'yesterday' } },
    });
    const [row] = await httpAuditRows();
    expect(row).toMatchObject({ approval_text: 'yes', approval_at: null });
  });
});
```
In `tests/api/auth.test.ts`, extend AU-3 (replace the comment line):
```ts
    const rows = await testDb.selectFrom('audit_log').selectAll().where('method', '=', 'POST').execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status_code: 403, scope: 'read', result_summary: 'SCOPE_FORBIDDEN' });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run`
Expected: FAIL. (The AL-1 "400" case passes only after Task 6; until then expect that one call to return 201. The row count still equals the call count, so AL-1 passes now too.)

- [ ] **Step 3: Implement**

`src/http/redact.ts`:
```ts
const SECRET_KEY = /(secret|password|passwd|token|api[-_]?key|authorization|(^|_)pat)$/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 10) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    return out;
  }
  return value;
}
```
`src/http/audit.ts` (full file):
```ts
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { AuditRowInsert, Database } from '../db/types.js';
import { errorBody } from './errors.js';
import { isMutating } from './methods.js';
import { redact } from './redact.js';

declare module 'fastify' {
  interface FastifyRequest {
    auditId: string | null;
    auditSummary: string | null;
  }
}

export interface AuditWriter {
  write(row: AuditRowInsert): Promise<void>;
}

export function newAuditId(): string {
  return `aud_${randomBytes(16).toString('hex')}`;
}

export function dbAuditWriter(db: Kysely<Database>): AuditWriter {
  return {
    async write(row) {
      await db.insertInto('audit_log').values(row).execute();
    },
  };
}

/** onRequest, registered FIRST so even a 401 gets an id. */
export function registerAuditId(app: FastifyInstance): void {
  app.decorateRequest('auditId', null);
  app.decorateRequest('auditSummary', null);
  app.addHook('onRequest', async (req) => {
    if (isMutating(req.method)) req.auditId = newAuditId();
  });
}

function bodyObject(req: FastifyRequest): Record<string, unknown> | null {
  const b = req.body;
  return b !== null && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
}

function extractApproval(body: Record<string, unknown> | null): { text: string | null; at: Date | null } {
  const ref = body?.approval_ref;
  if (ref === null || typeof ref !== 'object') return { text: null, at: null };
  const { text, approved_at } = ref as Record<string, unknown>;
  const at = typeof approved_at === 'string' ? new Date(approved_at) : null;
  return {
    text: typeof text === 'string' ? text : null,
    at: at && !Number.isNaN(at.getTime()) ? at : null,
  };
}

function summarize(status: number, payload: unknown): string {
  if (status < 400) return 'ok';
  try {
    const code = (JSON.parse(String(payload)) as { error?: { code?: string } }).error?.code;
    return code ?? `HTTP_${status}`;
  } catch {
    return `HTTP_${status}`;
  }
}

/** onSend, registered LAST (after the idempotency store), so it records the final status. */
export function registerAuditWrite(app: FastifyInstance, writer: AuditWriter): void {
  app.addHook('onSend', async (req, reply, payload) => {
    if (!req.auditId) return payload;
    const body = bodyObject(req);
    const approval = extractApproval(body);
    const replayed = reply.getHeader('idempotent-replayed') === 'true';
    const key = req.headers['idempotency-key'];
    const summary = req.auditSummary ?? summarize(reply.statusCode, payload);
    try {
      await writer.write({
        id: req.auditId,
        token_id: req.auth?.tokenId ?? null,
        scope: req.auth?.scope ?? null,
        method: req.method,
        path: req.url,
        idempotency_key: typeof key === 'string' ? key.slice(0, 255) : null,
        approval_text: approval.text,
        approval_at: approval.at,
        request: body ? JSON.stringify(redact(body)) : null,
        status_code: reply.statusCode,
        result_summary: replayed ? `replayed:${summary}` : summary,
        client_ip: req.ip,
      });
      return payload;
    } catch (err) {
      req.log.error({ auditId: req.auditId, errMessage: (err as Error).message }, 'audit write failed');
      reply.code(500);
      reply.removeHeader('idempotent-replayed');
      reply.header('content-type', 'application/json; charset=utf-8');
      return JSON.stringify(
        errorBody(
          'AUDIT_WRITE_FAILED',
          'The request was processed but could not be audited. Retry with the same Idempotency-Key.',
        ),
      );
    }
  });
}
```
`src/app.ts`: type `audit?: AuditWriter` in `AppDeps`, and register in order:
```ts
import { dbAuditWriter, registerAuditId, registerAuditWrite, type AuditWriter } from './http/audit.js';
// …after registerErrorHandling(app):
  registerAuditId(app);          // onRequest (first)
  registerAuth(app, deps.db);    // onRequest
  registerScope(app);            // preHandler
  // [Task 6] registerIdempotency(app, deps.db) goes here (preHandler + onSend)
  registerAuditWrite(app, deps.audit ?? dbAuditWriter(deps.db)); // onSend (last)
```
`tests/helpers/app.ts`: change the `audit` option type to `AuditWriter` (import from `../../src/http/audit.js`).

- [ ] **Step 4: Run tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS. **Check specifically** that the 401 case wrote a row. That proves onSend runs for errors thrown in onRequest. If it doesn't, move the write into an `onResponse` hook **only** for the error path and tell the reviewer.

- [ ] **Step 5: Commit**
```bash
git add src/ tests/
git commit -m "feat: audit row on every POST, incl. 401/403/4xx/5xx; redaction (AL-1, AL-3, AU-3)"
```

---

### Task 6: Idempotency

**Files:**
- Create: `src/http/canonical-json.ts`, `src/http/idempotency.ts`, `tests/unit/canonical-json.test.ts`, `tests/api/idempotency.test.ts`
- Modify: `src/app.ts`

**Interfaces:**
- Consumes: `AppError`, `isMutating`, `Database`, `AuditWriter` (for the failure test), `makeApp`, `sideEffects`.
- Produces:
  - `canonicalJson(value: unknown): string` (object keys sorted recursively)
  - `requestHash(method: string, url: string, body: unknown): string` (SHA-256 hex)
  - `FastifyRequest.idem: { key: string; claimed: boolean } | null`
  - `registerIdempotency(app, db): void` (adds one preHandler and one onSend)

- [ ] **Step 1: Write the failing tests**

`tests/unit/canonical-json.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/http/canonical-json.js';
import { requestHash } from '../../src/http/idempotency.js';

describe('canonical body hashing', () => {
  it('sorts keys recursively; arrays keep order', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe('{"a":{"c":null,"d":[2,1]},"b":1}');
  });

  it('same body with different key order → same hash; different path → different hash', () => {
    const h1 = requestHash('POST', '/buy', { domain: 'x.com', max_price: 11.5 });
    const h2 = requestHash('POST', '/buy', { max_price: 11.5, domain: 'x.com' });
    expect(h1).toBe(h2);
    expect(requestHash('POST', '/list/x.com', { domain: 'x.com', max_price: 11.5 })).not.toBe(h1);
    expect(requestHash('POST', '/buy', { domain: 'x.com', max_price: 11.6 })).not.toBe(h1);
  });

  it('undefined body hashes like null', () => {
    expect(requestHash('POST', '/x', undefined)).toBe(requestHash('POST', '/x', null));
  });
});
```
`tests/api/idempotency.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { dbAuditWriter, type AuditWriter } from '../../src/http/audit.js';
import { makeApp, sideEffects } from '../helpers/app.js';
import { testDb as db } from '../helpers/db.js';
import { issueToken } from '../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());

async function post(url: string, key: string | undefined, payload: unknown, auth: Record<string, string>) {
  const headers: Record<string, string> = { ...auth, 'content-type': 'application/json' };
  if (key !== undefined) headers['idempotency-key'] = key;
  return app.inject({ method: 'POST', url, headers, payload: typeof payload === 'string' ? payload : JSON.stringify(payload) });
}

describe('idempotency (ID)', () => {
  it('ID-1: missing key → 400 IDEMPOTENCY_KEY_REQUIRED, handler not run', async () => {
    app = await makeApp();
    const { auth } = await issueToken('write');
    const res = await post('/__test/echo', undefined, { value: 'x' }, auth);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(sideEffects.count).toBe(0);
  });

  it('ID-1: empty or oversized key → 400', async () => {
    app = await makeApp();
    const { auth } = await issueToken('write');
    expect((await post('/__test/echo', '', { value: 'x' }, auth)).statusCode).toBe(400);
    expect((await post('/__test/echo', 'k'.repeat(256), { value: 'x' }, auth)).statusCode).toBe(400);
  });

  it('ID-2: same key + same body → stored response replayed with Idempotent-Replayed: true; side effect once', async () => {
    app = await makeApp();
    const { auth } = await issueToken('write');
    const a = await post('/__test/echo', 'k1', { value: 'x' }, auth);
    const b = await post('/__test/echo', 'k1', { value: 'x' }, auth);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.body).toBe(a.body);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(a.headers['idempotent-replayed']).toBeUndefined();
    expect(sideEffects.count).toBe(1);
  });

  it('canonical body hashing: same body, different key order and whitespace → replay', async () => {
    app = await makeApp();
    const { auth } = await issueToken('write');
    await post('/__test/echo', 'k-order', '{"value":"x","approval_ref":{"text":"t","approved_at":"2026-10-04T09:00:00Z"}}', auth);
    const b = await post('/__test/echo', 'k-order', '{ "approval_ref": {"approved_at":"2026-10-04T09:00:00Z","text":"t"},  "value": "x" }', auth);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(sideEffects.count).toBe(1);
  });

  it('a stored 4xx (422) is replayed too', async () => {
    app = await makeApp();
    const { auth } = await issueToken('write');
    const a = await post('/__test/echo', 'k-422', { nope: 1 }, auth);
    const b = await post('/__test/echo', 'k-422', { nope: 1 }, auth);
    expect(a.statusCode).toBe(422);
    expect(b.statusCode).toBe(422);
    expect(b.headers['idempotent-replayed']).toBe('true');
  });

  it('ID-3: same key, different body → 409 IDEMPOTENCY_KEY_MISMATCH, not executed', async () => {
    app = await makeApp();
    const { auth } = await issueToken('write');
    await post('/__test/echo', 'k2', { value: 'x' }, auth);
    const res = await post('/__test/echo', 'k2', { value: 'y' }, auth);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_MISMATCH');
    expect(sideEffects.count).toBe(1);
  });

  it('ID-3: same key on a different path → 409 mismatch', async () => {
    app = await makeApp();
    const { auth } = await issueToken('write');
    await post('/__test/echo', 'k3', { value: 'x' }, auth);
    expect((await post('/__test/slow', 'k3', { value: 'x' }, auth)).statusCode).toBe(409);
  });

  it('concurrent same key: one executes, the other gets 409 IDEMPOTENCY_KEY_IN_USE', async () => {
    app = await makeApp();
    const { auth } = await issueToken('write');
    const [a, b] = await Promise.all([post('/__test/slow', 'k-c', {}, auth), post('/__test/slow', 'k-c', {}, auth)]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([201, 409]);
    const conflict = a.statusCode === 409 ? a : b;
    expect(conflict.json().error.code).toBe('IDEMPOTENCY_KEY_IN_USE');
    expect(sideEffects.count).toBe(1);
  });

  it('500 releases the key: a retry with the same key runs again, and both attempts are audited', async () => {
    app = await makeApp();
    const { auth } = await issueToken('write');
    expect((await post('/__test/boom', 'k-500', {}, auth)).statusCode).toBe(500);
    expect((await post('/__test/boom', 'k-500', {}, auth)).statusCode).toBe(500);
    expect(sideEffects.count).toBe(2);
    const rows = await db.selectFrom('idempotency_keys').selectAll().where('key', '=', 'k-500').execute();
    expect(rows).toHaveLength(0);
    const audits = await db.selectFrom('audit_log').selectAll().where('idempotency_key', '=', 'k-500').execute();
    expect(audits).toHaveLength(2);
  });

  it('403 and 401 responses are not stored under the key', async () => {
    app = await makeApp();
    const r = await issueToken('read');
    const w = await issueToken('write');
    expect((await post('/__test/echo', 'k-scope', { value: 'x' }, r.auth)).statusCode).toBe(403);
    expect((await post('/__test/echo', 'k-scope', { value: 'x' }, w.auth)).statusCode).toBe(201);
  });

  it('replays write their own audit row marked replayed', async () => {
    app = await makeApp();
    const { auth } = await issueToken('write');
    await post('/__test/echo', 'k-aud', { value: 'x' }, auth);
    await post('/__test/echo', 'k-aud', { value: 'x' }, auth);
    const audits = await db
      .selectFrom('audit_log').select(['result_summary']).where('idempotency_key', '=', 'k-aud').orderBy('at').execute();
    expect(audits.map((a) => a.result_summary)).toEqual(['ok', 'replayed:ok']);
  });

  it('audit failure keeps stored result: client gets 500 AUDIT_WRITE_FAILED, retry replays without re-executing', async () => {
    const real = dbAuditWriter(db);
    let failNext = true;
    const flaky: AuditWriter = {
      async write(row) {
        if (failNext) {
          failNext = false;
          throw new Error('db down');
        }
        await real.write(row);
      },
    };
    app = await makeApp({ audit: flaky });
    const { auth } = await issueToken('write');
    const a = await post('/__test/echo', 'k-af', { value: 'x' }, auth);
    expect(a.statusCode).toBe(500);
    expect(a.json().error.code).toBe('AUDIT_WRITE_FAILED');
    const b = await post('/__test/echo', 'k-af', { value: 'x' }, auth);
    expect(b.statusCode).toBe(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(sideEffects.count).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run`
Expected: FAIL (modules missing; ID tests fail).

- [ ] **Step 3: Implement**

`src/http/canonical-json.ts`:
```ts
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}
```
`src/http/idempotency.ts`:
```ts
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { canonicalJson } from './canonical-json.js';
import { AppError } from './errors.js';
import { isMutating } from './methods.js';

declare module 'fastify' {
  interface FastifyRequest {
    idem: { key: string; claimed: boolean } | null;
  }
}

const KEY = /^[\x21-\x7e]{1,255}$/; // visible ASCII, 1–255 chars

export function requestHash(method: string, url: string, body: unknown): string {
  return createHash('sha256').update(`${method} ${url}\n${canonicalJson(body ?? null)}`).digest('hex');
}

/**
 * preHandler (runs after auth + scope): claim the key, or replay / refuse.
 * onSend (runs before the audit write): store the final response, or release the key on 5xx.
 */
export function registerIdempotency(app: FastifyInstance, db: Kysely<Database>): void {
  app.decorateRequest('idem', null);

  app.addHook('preHandler', async (req, reply) => {
    if (!isMutating(req.method)) return;
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !KEY.test(key)) {
      throw new AppError(
        400,
        'IDEMPOTENCY_KEY_REQUIRED',
        'An Idempotency-Key header (1–255 visible ASCII characters) is required on every POST',
      );
    }
    const hash = requestHash(req.method, req.url, req.body);
    const inserted = await db
      .insertInto('idempotency_keys')
      .values({
        key,
        request_hash: hash,
        method: req.method,
        path: req.url,
        token_id: req.auth?.tokenId ?? null,
        state: 'in_progress',
      })
      .onConflict((oc) => oc.column('key').doNothing())
      .returning('key')
      .executeTakeFirst();
    if (inserted) {
      req.idem = { key, claimed: true };
      return;
    }
    const existing = await db.selectFrom('idempotency_keys').selectAll().where('key', '=', key).executeTakeFirst();
    if (existing && existing.request_hash !== hash) {
      throw new AppError(409, 'IDEMPOTENCY_KEY_MISMATCH', 'This Idempotency-Key was used with a different request');
    }
    if (!existing || existing.state !== 'completed' || existing.status_code === null) {
      throw new AppError(409, 'IDEMPOTENCY_KEY_IN_USE', 'A request with this Idempotency-Key is still in progress');
    }
    reply
      .code(existing.status_code)
      .header('idempotent-replayed', 'true')
      .type(existing.response_content_type ?? 'application/json; charset=utf-8');
    return reply.send(existing.response_body ?? '');
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const idem = req.idem;
    if (!idem?.claimed) return payload;
    idem.claimed = false;
    try {
      if (reply.statusCode >= 500) {
        await db.deleteFrom('idempotency_keys').where('key', '=', idem.key).where('state', '=', 'in_progress').execute();
      } else {
        const ct = reply.getHeader('content-type');
        await db
          .updateTable('idempotency_keys')
          .set({
            state: 'completed',
            status_code: reply.statusCode,
            response_body: typeof payload === 'string' ? payload : payload == null ? '' : String(payload),
            response_content_type: typeof ct === 'string' ? ct : null,
            completed_at: new Date(),
          })
          .where('key', '=', idem.key)
          .execute();
      }
    } catch (err) {
      // Leave the client's response untouched; the key stays in_progress (retries get IN_USE, never a re-run).
      req.log.error({ key: idem.key, errMessage: (err as Error).message }, 'idempotency store failed');
    }
    return payload;
  });
}
```
`src/app.ts`: register in the marked place, **between `registerScope` and `registerAuditWrite`**:
```ts
import { registerIdempotency } from './http/idempotency.js';
// …
  registerScope(app);                   // preHandler
  registerIdempotency(app, deps.db);    // preHandler (after scope) + onSend (before audit write)
  registerAuditWrite(app, deps.audit ?? dbAuditWriter(deps.db)); // onSend (last)
```
Why the audit-failure test passes: the idempotency onSend hook stores the real 201 *before* the audit hook fails and rewrites the client response to 500, so the retry replays the 201.

- [ ] **Step 4: Run tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS, including AL-1's 400 case (the call without a key now returns 400 and is still audited).

- [ ] **Step 5: Commit**
```bash
git add src/ tests/
git commit -m "feat: idempotency for every POST: replay, mismatch, in-use, 5xx release (ID-1..3)"
```

---

### Task 7: Per-token rate limits

**Files:**
- Create: `src/http/rate-limit.ts`, `tests/unit/rate-limit.test.ts`, `tests/api/rate-limit.test.ts`
- Modify: `src/app.ts`

**Interfaces:**
- Consumes: `AppError`, `isMutating`, `AppDeps.now`.
- Produces:
  - `class SlidingWindowLimiter { constructor(limit: number, windowMs: number, now?: () => number); take(key: string): number }` (returns 0 when allowed (and records the hit), else ms until a slot frees)
  - `registerRateLimit(app, now?: () => number): void` (preHandler; GET/HEAD 60/min, others 10/min, keyed by token id)

- [ ] **Step 1: Write the failing tests**

`tests/unit/rate-limit.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { SlidingWindowLimiter } from '../../src/http/rate-limit.js';

describe('SlidingWindowLimiter', () => {
  it('allows `limit` hits per window, then reports the wait', () => {
    let t = 1_000_000;
    const l = new SlidingWindowLimiter(3, 60_000, () => t);
    expect([l.take('a'), l.take('a'), l.take('a')]).toEqual([0, 0, 0]);
    expect(l.take('a')).toBe(60_000);
    t += 30_000;
    expect(l.take('a')).toBe(30_000);
    t += 30_000;
    expect(l.take('a')).toBe(0); // first hit fell out of the window
  });

  it('keys are independent', () => {
    const l = new SlidingWindowLimiter(1, 60_000, () => 0);
    expect(l.take('a')).toBe(0);
    expect(l.take('b')).toBe(0);
    expect(l.take('a')).toBeGreaterThan(0);
  });
});
```
`tests/api/rate-limit.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../helpers/app.js';
import { testDb as db } from '../helpers/db.js';
import { issueToken } from '../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());

describe('rate limit (AU-9)', () => {
  it('AU-9: the 11th POST in one minute → 429 RATE_LIMITED with Retry-After, and is audited', async () => {
    let t = 0;
    app = await makeApp({ now: () => t });
    const { auth } = await issueToken('write');
    for (let i = 1; i <= 10; i++) {
      const res = await app.inject({
        method: 'POST', url: '/__test/echo', headers: { ...auth, 'idempotency-key': `rl-${i}` }, payload: { value: 'x' },
      });
      expect(res.statusCode, `call ${i}`).toBe(201);
    }
    const res = await app.inject({
      method: 'POST', url: '/__test/echo', headers: { ...auth, 'idempotency-key': 'rl-11' }, payload: { value: 'x' },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    const audit = await db.selectFrom('audit_log').selectAll().where('idempotency_key', '=', 'rl-11').execute();
    expect(audit).toMatchObject([{ status_code: 429, result_summary: 'RATE_LIMITED' }]);

    t += 60_001;
    const later = await app.inject({
      method: 'POST', url: '/__test/echo', headers: { ...auth, 'idempotency-key': 'rl-12' }, payload: { value: 'x' },
    });
    expect(later.statusCode).toBe(201);
  });

  it('a rate-limited request does not burn its idempotency key', async () => {
    app = await makeApp({ now: () => 0 });
    const { auth } = await issueToken('write');
    for (let i = 1; i <= 10; i++) {
      await app.inject({ method: 'POST', url: '/__test/echo', headers: { ...auth, 'idempotency-key': `b-${i}` }, payload: { value: 'x' } });
    }
    await app.inject({ method: 'POST', url: '/__test/echo', headers: { ...auth, 'idempotency-key': 'b-11' }, payload: { value: 'x' } });
    const row = await db.selectFrom('idempotency_keys').selectAll().where('key', '=', 'b-11').executeTakeFirst();
    expect(row).toBeUndefined();
  });

  it('61st GET in one minute → 429; GETs and POSTs have separate budgets', async () => {
    app = await makeApp({ now: () => 0 });
    const { auth } = await issueToken('write');
    for (let i = 1; i <= 60; i++) {
      expect((await app.inject({ method: 'GET', url: '/__test/ping', headers: auth })).statusCode).toBe(200);
    }
    expect((await app.inject({ method: 'GET', url: '/__test/ping', headers: auth })).statusCode).toBe(429);
    const post = await app.inject({
      method: 'POST', url: '/__test/echo', headers: { ...auth, 'idempotency-key': 'sep-1' }, payload: { value: 'x' },
    });
    expect(post.statusCode).toBe(201);
  });

  it('limits are per token', async () => {
    app = await makeApp({ now: () => 0 });
    const a = await issueToken('write');
    const b = await issueToken('write');
    for (let i = 1; i <= 10; i++) {
      await app.inject({ method: 'POST', url: '/__test/echo', headers: { ...a.auth, 'idempotency-key': `a-${i}` }, payload: { value: 'x' } });
    }
    const res = await app.inject({
      method: 'POST', url: '/__test/echo', headers: { ...b.auth, 'idempotency-key': 'b-1' }, payload: { value: 'x' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('/health is never rate limited', async () => {
    app = await makeApp({ now: () => 0 });
    for (let i = 0; i < 70; i++) expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run`
Expected: FAIL (module missing; 11th POST returns 201).

- [ ] **Step 3: Implement**

`src/http/rate-limit.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { AppError } from './errors.js';
import { isMutating } from './methods.js';

/** In-memory sliding window. Fine for one Render instance; revisit if we ever scale out. */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(key: string): number {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => x > t - this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return recent[0]! + this.windowMs - t;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return 0;
  }
}

export function registerRateLimit(app: FastifyInstance, now: () => number = Date.now): void {
  const reads = new SlidingWindowLimiter(60, 60_000, now);
  const writes = new SlidingWindowLimiter(10, 60_000, now);
  app.addHook('preHandler', async (req, reply) => {
    if (!req.auth) return; // public routes (/health) are not limited
    const wait = (isMutating(req.method) ? writes : reads).take(String(req.auth.tokenId));
    if (wait > 0) {
      const seconds = Math.ceil(wait / 1000);
      reply.header('retry-after', String(seconds));
      throw new AppError(429, 'RATE_LIMITED', 'Too many requests for this token', { retry_after_seconds: seconds });
    }
  });
}
```
`src/app.ts`: rate limit is the **first preHandler** (before scope and idempotency, so a 429 never claims a key):
```ts
import { registerRateLimit } from './http/rate-limit.js';
// …
  registerAuditId(app);                 // onRequest
  registerAuth(app, deps.db);           // onRequest
  registerRateLimit(app, deps.now);     // preHandler (first)
  registerScope(app);                   // preHandler
  registerIdempotency(app, deps.db);    // preHandler + onSend
  registerAuditWrite(app, deps.audit ?? dbAuditWriter(deps.db)); // onSend (last)
```
Remove the order-comment block from Task 3 and leave this list with its comments in its place.

- [ ] **Step 4: Run tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 5: Commit**
```bash
git add src/ tests/
git commit -m "feat: per-token rate limits 60/min GET, 10/min POST (AU-9)"
```

---

### Task 8: Admin CLI (`token create|revoke|list`, `doctor`), secret-leak sweep, README

**Files:**
- Create: `src/admin.ts`, `src/admin/doctor.ts`, `tests/api/admin-cli.test.ts`, `tests/api/secrets.test.ts`
- Modify: `README.md` (status line + "Run locally" section)

**Interfaces:**
- Consumes: `createApiToken`, `revokeApiToken`, `listApiTokens`, `loadConfig`, `createDb`, `pingDb`, `adapterStatus`, `makeApp`, `logCapture`, `issueToken`.
- Produces:
  - `runDoctor(config: Config, db: Kysely<Database>): Promise<string[]>` (lines to print; never contains a secret)
  - CLI: `npm run admin -- token create --scope read|write --name <name>` / `token revoke --id <n>` / `token list` / `doctor`. Exit 0 ok, 1 failure, 2 usage error.

- [ ] **Step 1: Write the failing tests**

`tests/api/admin-cli.test.ts`:
```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { testDb as db } from '../helpers/db.js';
import { testEnv } from '../helpers/env.js';

const run = promisify(execFile);
const cli = (args: string[]) =>
  run('npx', ['tsx', 'src/admin.ts', ...args], { env: { ...process.env, ...testEnv() } });

describe('admin CLI', () => {
  it('token create prints the token once and stores only its hash', async () => {
    const { stdout } = await cli(['token', 'create', '--scope', 'read', '--name', 'gavriel-read']);
    const token = /dt_[A-Za-z0-9_-]{43}/.exec(stdout)?.[0];
    expect(token).toBeDefined();
    const rows = await db.selectFrom('api_tokens').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('token list shows tokens without hashes; token revoke revokes', async () => {
    await cli(['token', 'create', '--scope', 'write', '--name', 'gavriel-write']);
    const list = (await cli(['token', 'list'])).stdout;
    expect(list).toContain('gavriel-write');
    expect(list).not.toMatch(/[0-9a-f]{64}/);
    await cli(['token', 'revoke', '--id', '1']);
    const row = await db.selectFrom('api_tokens').select('revoked_at').where('id', '=', 1).executeTakeFirstOrThrow();
    expect(row.revoked_at).not.toBeNull();
  });

  it('bad usage exits 2', async () => {
    await expect(cli(['token', 'create', '--scope', 'admin', '--name', 'x'])).rejects.toMatchObject({ code: 2 });
    await expect(cli(['nope'])).rejects.toMatchObject({ code: 2 });
  });

  it('doctor reports DB, migrations and adapters and never prints a secret', async () => {
    const { stdout } = await cli(['doctor']);
    expect(stdout).toMatch(/db: ok/);
    expect(stdout).toMatch(/migrations: 1 applied/);
    expect(stdout).toMatch(/porkbun: disabled \(not implemented\)/);
    for (const secret of ['pk1_', 'sk1_', 'fake_godaddy_pat', 'github_pat_fake', ':dt@']) {
      expect(stdout).not.toContain(secret);
    }
  });
});
```
`tests/api/secrets.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../../src/config.js';
import { logCapture, makeApp } from '../helpers/app.js';
import { testDb as db } from '../helpers/db.js';
import { testEnv } from '../helpers/env.js';
import { issueToken } from '../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());

describe('AU-8 (step-1 scope): secrets never leak', () => {
  it('responses, logs and audit rows contain no env secret, no pk1_/sk1_ prefix and no bearer token', async () => {
    const logs = logCapture();
    app = await makeApp({ logStream: logs.stream });
    const w = await issueToken('write');
    const r = await issueToken('read');
    const bodies: string[] = [];
    const reqs = [
      { method: 'GET' as const, url: '/health', headers: {} },
      { method: 'GET' as const, url: '/__test/ping', headers: r.auth },
      { method: 'GET' as const, url: '/__test/ping', headers: { authorization: 'Bearer dt_wrong' } },
      { method: 'POST' as const, url: '/__test/echo', headers: { ...w.auth, 'idempotency-key': 's1' }, payload: { value: 'x' } },
      { method: 'POST' as const, url: '/__test/echo', headers: { ...r.auth, 'idempotency-key': 's2' }, payload: { value: 'x' } },
      { method: 'POST' as const, url: '/__test/boom', headers: { ...w.auth, 'idempotency-key': 's3' }, payload: {} },
    ];
    for (const q of reqs) bodies.push((await app.inject(q)).body);
    const audit = JSON.stringify(await db.selectFrom('audit_log').selectAll().execute());
    const haystack = [bodies.join('\n'), logs.text(), audit].join('\n');

    const secrets = loadConfig(testEnv()).secretValues.filter((s) => s.length >= 6); // skip the 2-char docker password
    for (const s of [...secrets, w.token, r.token]) expect(haystack).not.toContain(s);
    expect(haystack).not.toMatch(/pk1_|sk1_/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run`
Expected: admin-cli FAILS (no `src/admin.ts`); secrets test should already PASS (if it fails, fix the leak; **do not** weaken the test).

- [ ] **Step 3: Implement**

`src/admin/doctor.ts`:
```ts
import { sql, type Kysely } from 'kysely';
import type { Config } from '../config.js';
import { pingDb } from '../db/client.js';
import type { Database } from '../db/types.js';
import { adapterStatus } from '../registrars/registry.js';

export async function runDoctor(config: Config, db: Kysely<Database>): Promise<string[]> {
  const lines = [`version: ${config.version}`, `env: ${config.appEnv}`];
  const dbOk = await pingDb(db);
  lines.push(`db: ${dbOk ? 'ok' : 'down'}`);
  if (dbOk) {
    const r = await sql<{ n: number }>`select count(*)::int as n from pgmigrations`.execute(db).catch(() => null);
    lines.push(r ? `migrations: ${r.rows[0]?.n ?? 0} applied` : 'migrations: table missing (run npm run migrate up)');
  }
  for (const a of adapterStatus(config)) {
    lines.push(`${a.name}: ${a.enabled ? 'enabled' : `disabled (${a.reason})`}`);
  }
  return lines;
}
```
`src/admin.ts`:
```ts
import { parseArgs } from 'node:util';
import { createApiToken, listApiTokens, revokeApiToken } from './admin/tokens.js';
import { runDoctor } from './admin/doctor.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';

const USAGE = `usage:
  npm run admin -- token create --scope read|write --name <name>
  npm run admin -- token revoke --id <id>
  npm run admin -- token list
  npm run admin -- doctor`;

class UsageError extends Error {}

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { scope: { type: 'string' }, name: { type: 'string' }, id: { type: 'string' } },
  });
  const [cmd, sub] = positionals;
  const config = loadConfig(process.env);
  const db = createDb(config.databaseUrl);
  try {
    if (cmd === 'doctor') {
      for (const line of await runDoctor(config, db)) console.log(line);
      return 0;
    }
    if (cmd === 'token' && sub === 'create') {
      const scope = values.scope;
      if (scope !== 'read' && scope !== 'write') throw new UsageError('--scope must be read or write');
      if (!values.name) throw new UsageError('--name is required');
      const { id, token } = await createApiToken(db, { name: values.name, scope });
      console.log(`Created token ${id} (${scope}, "${values.name}"). It is shown ONCE; store it now:`);
      console.log(token);
      return 0;
    }
    if (cmd === 'token' && sub === 'revoke') {
      const id = Number(values.id);
      if (!Number.isInteger(id) || id <= 0) throw new UsageError('--id must be a positive integer');
      const ok = await revokeApiToken(db, id);
      console.log(ok ? `Revoked token ${id}` : `No active token with id ${id}`);
      return ok ? 0 : 1;
    }
    if (cmd === 'token' && sub === 'list') {
      for (const t of await listApiTokens(db)) {
        console.log(
          [t.id, t.name, t.scope, `created ${t.created_at.toISOString()}`,
           t.revoked_at ? `REVOKED ${t.revoked_at.toISOString()}` : 'active',
           `last used ${t.last_used_at?.toISOString() ?? 'never'}`].join('  '),
        );
      }
      return 0;
    }
    throw new UsageError(`unknown command: ${positionals.join(' ') || '(none)'}`);
  } finally {
    await db.destroy();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof UsageError || (err as { code?: string }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      console.error(`${(err as Error).message}\n${USAGE}`);
      process.exit(2);
    }
    console.error(`error: ${(err as Error).message}`);
    process.exit(1);
  },
);
```
Note: `loadConfig` errors print only the zod issue text (variable names, not values). Check this holds.

`README.md`: replace the status line and add a run section:
```markdown
**Status (4 Oct 2026):** step 1 (foundation) built: schema, auth, audit, idempotency, rate limits, `/health`, admin CLI.

## Run locally
1. `npm install`
2. `npm run db:up` (Postgres 16 in docker on port 5433; creates `domain_trading` and `domain_trading_test`)
3. `cp .env.example .env` (fake/blank keys are fine for local work)
4. `npm run migrate up`
5. `npm run admin -- token create --scope write --name dvir-local` (the token is printed once)
6. `npm run dev`, then `curl localhost:3000/health`

Tests: `npm test` (unit + API; needs step 2). Network is blocked in tests.
```

- [ ] **Step 4: Run the full suite, typecheck and build**

Run: `npx vitest run && npx tsc --noEmit && npm run build && ls dist/main.js`
Expected: all PASS; `dist/main.js` exists.

- [ ] **Step 5: Commit**
```bash
git add src/ tests/ README.md
git commit -m "feat: admin CLI (token create/revoke/list, doctor), secret-leak sweep, README run steps"
```

---

### Task 9 (Opus, not Sonnet): Gate report

- [ ] Run `npx vitest run --reporter=verbose` and `npx tsc --noEmit`; record the counts.
- [ ] Map spec IDs → test names: AU-1–AU-7, AU-9, AU-8 (step-1 scope), ID-1, ID-2 (generic), ID-3, AL-1–AL-3, RN-3, B-23, LH-3 (schema part), R-11.
- [ ] Whole-change review against `CLAUDE.md` founder rules 2, 7, 8, 9 and the Decisions table D1–D11.
- [ ] Report to Dvir: counts, covered IDs, open decisions, anything manual. Push to `main` after his OK.

---

## Self-review notes

- **Spec coverage:** §4 tables: all 10 spec tables plus `idempotency_keys` (D1) are in Task 2. §6 auth: Task 4. §6 audit: Task 5. §6 idempotency: Task 6. §6 rate limit: Task 7. §7 errors and health: Task 3. Admin token commands and `doctor`: Tasks 4 and 8. AU-8 is partial by design; it is fully covered in step 4 when all endpoints exist. AU-4/AU-5 cover only the test route until real GETs exist; AU-1 and AU-7 iterate the live route table, so they grow automatically.
- **Deliberately not in step 1:** money formatting helpers (step 2, with the first money-returning endpoint), the reconciler, adapters, and listing validation.
