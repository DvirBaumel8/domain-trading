// v5.20.0 (CR-069): the shared `bots` token scope, its rotation route, and the X-Bot-Name audit field.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { BOTS_ROUTES } from '../../../src/http/auth.js';
import { makeApp } from '../../helpers/app.js';
import { testDb } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { issueToken } from '../../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
let clock = Date.parse('2026-10-20T09:00:00Z');
const MIN = 60_000;

type H = Record<string, string>;
const call = (method: 'GET' | 'POST' | 'PATCH', url: string, h: H, payload?: unknown, key: string = randomUUID()) =>
  app.inject({ method, url, headers: { ...h, ...(method !== 'GET' ? { 'idempotency-key': key } : {}) }, ...(payload !== undefined ? { payload: payload as object } : {}) });
async function setup() {
  clock = Date.parse('2026-10-20T09:00:00Z');
  app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => clock });
  return { bots: (await issueToken('bots', 'bots-shared')).auth, write: (await issueToken('write', 'gavriel')).auth, read: (await issueToken('read', 'reader')).auth };
}
const sale = { domain: 'septicdrone.com', price_usd: 1500, sale_date: '2026-09-01', venue: 'namebio', source: 'unreported-sales' };

describe('bots token scope (CR-069)', () => {
  it('B520-1: a bots token can GET /health, /portfolio, /visits, /visits/weekly and upload data (POST /engine/sales 201, /data/rdap, /candidates/intake not SCOPE_FORBIDDEN)', async () => {
    const { bots } = await setup();
    for (const url of ['/health', '/portfolio', '/visits', '/visits/weekly?week_ending=2026-10-17']) expect((await call('GET', url, bots)).statusCode, url).toBe(200);
    expect((await call('POST', '/engine/sales', bots, { rows: [sale] })).statusCode).toBe(201);
    expect((await call('POST', '/candidates/intake', bots, { names: [] })).json().error?.code).not.toBe('SCOPE_FORBIDDEN');
    expect((await call('POST', '/data/rdap', bots, { rows: [], dry_run: true })).json().error?.code).not.toBe('SCOPE_FORBIDDEN');
  });

  it('B520-2: a real /buy, /list, /listings venue, price/plan (horizon), /sold, /offers, /portfolio/import and a settings activation are 403 SCOPE_FORBIDDEN for a bots token; dry_run false or "strict" too', async () => {
    const { bots } = await setup();
    const money: [string, unknown][] = [
      ['/buy', { domain: 'x.com', max_price: 10 }], ['/buy', { domain: 'x.com', max_price: 10, dry_run: false }], ['/buy', { domain: 'x.com', max_price: 10, dry_run: 'strict' }],
      ['/list/x.com', { mode: 'bin' }], ['/listings/x.com/venue', {}], ['/portfolio/x.com/horizon', {}], ['/sold/x.com', {}], ['/offers', {}],
      ['/portfolio/import', {}], ['/selection/settings/v1/activate', {}], ['/export/afternic/uploaded', {}], ['/offers/1/outcome', {}], ['/reviews/run', {}],
    ];
    for (const [url, body] of money) {
      clock += 10_000; // stay under the general write limit of 10 a minute
      const res = await call('POST', url, bots, body);
      expect(res.statusCode, url).toBe(403);
      expect(res.json().error.code, url).toBe('SCOPE_FORBIDDEN');
    }
    const jobs = await call('POST', '/jobs/run', bots, { job: 'tick' });
    expect(jobs.statusCode).toBe(401);
  });

  it('B520-3: /buy with dry_run true passes the bots scope and writes no purchase', async () => {
    const { bots } = await setup();
    const res = await call('POST', '/buy', bots, { domain: 'examplecityroofing.com', max_price: 11.5, dry_run: true });
    expect(res.json().error?.code).not.toBe('SCOPE_FORBIDDEN');
    expect(res.statusCode).not.toBe(403);
    expect(Number((await sql<{ n: string }>`select count(*)::text as n from purchases where dry_run = false`.execute(testDb)).rows[0]!.n)).toBe(0);
  });

  it('B520-4: rotation returns the raw token once; it is in no audit_log row and no idempotency_keys row; a replay answers token null', async () => {
    await setup();
    await testDb.deleteFrom('api_tokens').where('scope', '=', 'bots').execute();
    const write = (await issueToken('write', 'w2')).auth;
    const key = randomUUID();
    const res = await call('POST', '/tokens/bots/rotate', write, undefined, key);
    expect(res.statusCode, res.body).toBe(200);
    const { token, expires_old_at } = res.json();
    expect(token).toMatch(/^dt_/);
    expect(expires_old_at).toBeNull(); // no shared token existed yet
    for (const t of ['audit_log', 'idempotency_keys']) {
      const n = await sql<{ n: string }>`select count(*)::text as n from ${sql.table(t)} r where r::text like ${`%${token}%`}`.execute(testDb);
      expect(Number(n.rows[0]!.n), t).toBe(0);
    }
    const hash = (await import('../../../src/core/tokens.js')).hashToken(token);
    expect((await sql<{ n: string }>`select count(*)::text as n from audit_log r where r::text like ${`%${hash}%`}`.execute(testDb)).rows[0]!.n).toBe('0');
    const replay = await call('POST', '/tokens/bots/rotate', write, undefined, key);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json().token).toBeNull();
    expect(replay.body).not.toContain(token);
    const audit = await testDb.selectFrom('audit_log').select(['path', 'scope', 'status_code']).where('path', '=', '/tokens/bots/rotate').execute();
    expect(audit.length).toBe(2);
    expect(audit[0]).toMatchObject({ scope: 'write', status_code: 200 });
    const row = await testDb.selectFrom('api_tokens').select(['name', 'scope']).where('token_sha256', '=', hash).executeTakeFirstOrThrow();
    expect(row).toEqual({ name: 'bots-shared', scope: 'bots' });
  });

  it('B520-5: after a rotation the new token works, the old one works for 10 more minutes (+9 min ok) and is 401 after (+11 min); a bots token can rotate itself', async () => {
    const { write } = await setup();
    const a = (await call('POST', '/tokens/bots/rotate', write)).json().token as string;
    const A = { authorization: `Bearer ${a}` };
    expect((await call('GET', '/portfolio', A)).statusCode).toBe(200);
    clock += MIN;
    const r2 = await call('POST', '/tokens/bots/rotate', A); // self-rotation with a bots token
    expect(r2.statusCode).toBe(200);
    const b = r2.json().token as string;
    expect(Date.parse(r2.json().expires_old_at)).toBe(clock + 10 * MIN);
    const B = { authorization: `Bearer ${b}` };
    expect((await call('GET', '/portfolio', B)).statusCode).toBe(200);
    clock += 9 * MIN;
    expect((await call('GET', '/portfolio', A)).statusCode).toBe(200);
    expect((await call('GET', '/portfolio', B)).statusCode).toBe(200);
    clock += 2 * MIN;
    expect((await call('GET', '/portfolio', A)).statusCode).toBe(401);
    expect((await call('GET', '/portfolio', B)).statusCode).toBe(200);
    // a third rotation does not extend the already expiring one
    const live = await testDb.selectFrom('api_tokens').select(['name', 'expires_at']).where('scope', '=', 'bots').where('name', 'like', 'bots-shared%').orderBy('id').execute();
    expect(live.map((t) => t.name.startsWith('bots-shared-old-'))).toEqual([true, true, false]);
    expect(live[0]!.expires_at).not.toBeNull();
    expect(live[1]!.expires_at).not.toBeNull();
    expect(live[2]!.expires_at).toBeNull();
  });

  it('B520-6: X-Bot-Name lands in the audit row (trimmed); an invalid or over-long name is ignored; GET /audit shows it', async () => {
    const { bots, write } = await setup();
    await call('POST', '/engine/sales', { ...bots, 'x-bot-name': '  data-engineer ' }, { rows: [sale] });
    await call('POST', '/engine/sales', { ...bots, 'x-bot-name': 'bad<script>' }, { rows: [{ ...sale, domain: 'alpha.com' }] });
    await call('POST', '/engine/sales', { ...bots, 'x-bot-name': 'a'.repeat(41) }, { rows: [{ ...sale, domain: 'beta.com' }] });
    const rows = await testDb.selectFrom('audit_log').select(['bot_name', 'scope']).where('path', '=', '/engine/sales').orderBy('at').execute();
    expect(rows.map((r) => r.bot_name)).toEqual(['data-engineer', null, null]);
    expect(rows.every((r) => r.scope === 'bots')).toBe(true);
    const api = (await call('GET', '/audit?limit=50', write)).json().rows as { path: string; bot_name: string | null }[];
    expect(api.find((r) => r.path === '/engine/sales' && r.bot_name === 'data-engineer')).toBeTruthy();
  });

  it('B520-7: a READ token cannot rotate (403); a bots token cannot call POST /visits/hit (403)', async () => {
    const { read, bots } = await setup();
    const r = await call('POST', '/tokens/bots/rotate', read);
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('SCOPE_FORBIDDEN');
    expect((await call('POST', '/visits/hit', bots, { domain: 'x.com' })).statusCode).toBe(403);
  });

  it('B520-8: every registered mutating route is classified for a bots token (and the table lists no route that does not exist)', async () => {
    const { read } = await setup();
    await app.close();
    app = await makeApp({ testRoutes: false, now: () => clock });
    const doc = (await call('GET', '/openapi.json', read)).json() as { paths: Record<string, Record<string, { 'x-idempotency-key'?: string }>> };
    const mutating: string[] = [];
    for (const [path, ops] of Object.entries(doc.paths)) for (const [method, op] of Object.entries(ops)) if (op['x-idempotency-key'] === 'required') mutating.push(`${method.toUpperCase()} ${path}`);
    expect(mutating.length).toBeGreaterThan(50);
    const exempt = new Set(['POST /visits/hit']); // visits token only
    const unclassified = mutating.filter((r) => !exempt.has(r) && !(r in BOTS_ROUTES));
    expect(unclassified).toEqual([]);
    expect(Object.keys(BOTS_ROUTES).filter((r) => !mutating.includes(r))).toEqual([]);
  });
});
