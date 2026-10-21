// CR-074 (v5.29.0): GET /rdap/:domain, POST /rdap/batch, GET /lookups/usage; the shared RDAP cache and the rolling 24-hour limit.
import { http, HttpResponse } from 'msw';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { cachedRdapLookup } from '../../../src/core/rdap-cache.js';
import type { RdapLookup, RdapLookupFn } from '../../../src/core/rdap.js';
import { makeApp } from '../../helpers/app.js';
import { testDb } from '../../helpers/db.js';
import { issueToken } from '../../helpers/tokens.js';
import { mswServer } from '../../setup/network.js';
import { fixture, respond } from '../../helpers/screening-fixtures.js';

let app: FastifyInstance;
afterEach(async () => app?.close());

const COM = 'https://rdap.verisign.com/com/v1/domain/:d';
let asked: string[] = [];
/** Verisign mock: google.com is the recorded registered answer, every other name is a 404 RDAP answer (not registered). */
function mockVerisign() {
  asked = [];
  mswServer.use(http.get(COM, ({ params }) => {
    asked.push(String(params.d));
    if (params.d === 'google.com') return respond(fixture('rdap/google_com.json'));
    return new HttpResponse(null, { status: 404, headers: { 'content-type': 'application/rdap+json' } });
  }));
}
const setLimit = (n: number) => sql`update settings set lookups_rdap_daily_limit = ${n}`.execute(testDb);
const names = (n: number, p = 'rl') => Array.from({ length: n }, (_, i) => `${p}${String(i).padStart(4, 'a')}`.replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]!) + '.com');
const usageRows = async () => Number((await sql<{ n: string }>`select count(*)::text as n from lookup_usage`.execute(testDb)).rows[0]!.n);

async function boot(opts: { clock?: number; rdapLookup?: RdapLookupFn } = {}) {
  const state = { t: opts.clock ?? Date.parse('2026-10-21T09:00:00Z') };
  app = await makeApp({ now: () => state.t, ...(opts.rdapLookup && { screening: { rdapLookup: opts.rdapLookup } }) });
  const bots = (await issueToken('bots')).auth;
  return { state, bots, get: (url: string, h = bots) => app.inject({ method: 'GET', url, headers: h }), batch: (domains: unknown, h = bots, extra: object = {}) => app.inject({ method: 'POST', url: '/rdap/batch', headers: h, payload: { domains, ...extra } }) };
}

describe('RDAP lookup service (CR-074)', () => {
  it('RL529-1 (AT-1): google.com is registered with created set; a second call within the TTL has cache_age_s > 0 and uses no limit', async () => {
    mockVerisign();
    const { state, get } = await boot();
    const a = await get('/rdap/google.com');
    expect(a.statusCode).toBe(200);
    expect(a.json()).toMatchObject({ domain: 'google.com', registered: true, source: 'rdap', cache_age_s: 0 });
    expect(a.json().created).toMatch(/^1997-09-15T/);
    expect(a.json().status).toContain('client transfer prohibited');
    expect(a.json().reason_code).toBeUndefined();
    state.t += 3_600_000;
    const b = await get('/rdap/google.com');
    expect(b.json()).toMatchObject({ registered: true, cache_age_s: 3600, created: a.json().created, checked_at: a.json().checked_at });
    expect(asked).toEqual(['google.com']);
    expect(await usageRows()).toBe(1);
    // past the TTL (24 h) it asks again
    state.t += 25 * 3_600_000;
    expect((await get('/rdap/google.com')).json().cache_age_s).toBe(0);
    expect(asked).toHaveLength(2);
  });

  it('RL529-2 (AT-2): limit 2 used up: a 3rd uncached name is 429 LOOKUP_LIMIT with retry_after_s; a cached name is still 200', async () => {
    mockVerisign();
    const { state, get } = await boot();
    await setLimit(2);
    expect((await get('/rdap/aaaaone.com')).statusCode).toBe(200);
    state.t += 1000;
    expect((await get('/rdap/aaaatwo.com')).statusCode).toBe(200);
    state.t += 1000;
    const c = await get('/rdap/aaaathree.com');
    expect(c.statusCode).toBe(429);
    expect(c.json().error.code).toBe('LOOKUP_LIMIT');
    expect(c.json().error.details.retry_after_s).toBe(86_400 - 2);
    expect(c.headers['retry-after']).toBe(String(86_400 - 2));
    expect(asked).toHaveLength(2);
    const cached = await get('/rdap/aaaaone.com');
    expect(cached.statusCode).toBe(200);
    expect(cached.json().cache_age_s).toBe(2);
  });

  it('RL529-3 (AT-3): 150 lookups at 23:50 IDT and 60 at 00:10 IDT with limit 200: only 50 of the 60 run, the 201st within 24 h is refused, and slots return gradually (no midnight reset)', async () => {
    mockVerisign();
    const t2350 = Date.parse('2026-10-21T20:50:00Z'); // 23:50 IDT (UTC+3 until 25 Oct)
    const t0010 = Date.parse('2026-10-21T21:10:00Z'); // 00:10 IDT, the next calendar day
    const { state, get, batch } = await boot({ clock: t0010 });
    await sql`insert into lookup_usage (source, at, by_token) select 'rdap', ${new Date(t2350)}, 'seed' from generate_series(1, 150)`.execute(testDb);
    const r = await batch(names(60));
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j).toMatchObject({ count: 60, live_n: 50, cached_n: 0, limit_hit: true });
    expect(j.retry_after_s).toBe(Math.ceil((t2350 + 86_400_000 - t0010) / 1000));
    expect(j.rows.filter((x: { reason_code?: string }) => x.reason_code === 'LOOKUP_LIMIT')).toHaveLength(10);
    expect(j.rows.filter((x: { registered: boolean | null }) => x.registered === false)).toHaveLength(50);
    expect(j.rows.filter((x: { registered: boolean | null }) => x.registered === null).every((x: { registered: null }) => x.registered === null)).toBe(true);
    const over = await get('/rdap/aaaaextra.com');
    expect(over.statusCode).toBe(429);
    const u = (await get('/lookups/usage')).json();
    expect(u).toMatchObject({ source: 'rdap', used: 200, limit: 200, resets_gradually: true });
    // output times carry the Asia/Jerusalem offset; the instants are the UTC ones
    expect(Date.parse(u.next_slot_at)).toBe(t2350 + 86_400_000);
    expect(Date.parse(u.window_start)).toBe(t0010 - 86_400_000);
    // one second after the 150 seeded rows age out, slots are free again
    state.t = t2350 + 86_400_000 + 1000;
    const u2 = (await get('/lookups/usage')).json();
    expect(u2.used).toBe(50);
    expect(Date.parse(u2.next_slot_at)).toBe(t0010 + 86_400_000);
    expect((await get('/rdap/aaaaextra.com')).statusCode).toBe(200);
  });

  it('RL529-4 (AT-4): a timeout is registered null with reason_code TIMEOUT, never false; other errors are SOURCE_ERROR and RATE_LIMITED; none is cached as a result', async () => {
    const err = (reasonCode: RdapLookup['reasonCode']): RdapLookupFn => async () => ({ outcome: 'unknown', reasonCode, httpStatus: null, url: '', retrievedAt: new Date(), body: null, facts: null });
    for (const code of ['TIMEOUT', 'SOURCE_ERROR', 'RATE_LIMITED'] as const) {
      const { get, batch } = await boot({ rdapLookup: err(code) });
      const r = await get('/rdap/timeoutname.com');
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ registered: null, reason_code: code, created: null, expires: null, registrar: null, status: [] });
      expect((await batch(['timeoutname.com'])).json().rows[0]).toMatchObject({ registered: null, reason_code: code });
      expect(Number((await sql<{ n: string }>`select count(*)::text as n from rdap_cache`.execute(testDb)).rows[0]!.n)).toBe(0);
      expect(await usageRows()).toBe(2); // the registry was asked twice: both slots are spent, the error answer is not cached
      await app.close();
      await sql`truncate lookup_usage`.execute(testDb);
    }
  });

  it('RL529-4b: a real Verisign timeout (mock server that never answers within the timeout) gives TIMEOUT through the default lookup', async () => {
    const real: RdapLookupFn = async (d) => (await import('../../../src/core/rdap.js')).rdapLookup(d, { timeoutMs: 30 });
    mswServer.use(http.get(COM, async () => { await new Promise((r) => setTimeout(r, 300)); return new HttpResponse(null, { status: 404 }); }));
    const { get } = await boot({ rdapLookup: real });
    expect((await get('/rdap/slowname.com')).json()).toMatchObject({ registered: null, reason_code: 'TIMEOUT' });
  });

  it('RL529-5: fresh=true forces a live lookup and counts against the limit; fills the cache', async () => {
    mockVerisign();
    const { state, get } = await boot();
    await get('/rdap/google.com');
    state.t += 10_000;
    const f = await get('/rdap/google.com?fresh=true');
    expect(f.json().cache_age_s).toBe(0);
    expect(asked).toHaveLength(2);
    expect((await get('/lookups/usage')).json().used).toBe(2);
    await setLimit(2);
    expect((await get('/rdap/google.com?fresh=true')).statusCode).toBe(429);
    expect((await get('/rdap/google.com')).statusCode).toBe(200); // cached still served
    expect((await get('/rdap/google.com?fresh=maybe')).statusCode).toBe(400);
  });

  it('RL529-6: internal steps share the cache and never count: a cachedRdapLookup fills it, the bot route reads it with no usage; and an internal call reads what a bot lookup stored', async () => {
    mockVerisign();
    const { state, get } = await boot();
    const base: RdapLookupFn = async (d) => { asked.push(`internal:${d}`); return (await import('../../../src/core/rdap.js')).rdapLookup(d); };
    const fresh = cachedRdapLookup(testDb, base, { now: () => state.t, ttlMs: 0 });
    expect((await fresh('google.com')).outcome).toBe('registered');
    expect(await usageRows()).toBe(0);
    state.t += 60_000;
    const hit = await get('/rdap/google.com');
    expect(hit.json()).toMatchObject({ registered: true, cache_age_s: 60 });
    expect(await usageRows()).toBe(0);
    // a bot lookup of another name is read by an internal step with a TTL, without another registry call
    await get('/rdap/bbbbtwo.com');
    const before = asked.length;
    const reading = cachedRdapLookup(testDb, base, { now: () => state.t, ttlMs: 86_400_000 });
    expect(await reading('bbbbtwo.com')).toMatchObject({ outcome: 'not_registered' });
    expect((await reading('google.com')).facts?.statuses).toContain('client transfer prohibited');
    expect(asked).toHaveLength(before);
    // limit 0: the bot cannot ask, the internal step still can
    await setLimit(0);
    expect((await get('/rdap/ccccthree.com')).statusCode).toBe(429);
    expect((await fresh('ccccthree.com')).outcome).toBe('not_registered');
    expect((await get('/rdap/ccccthree.com')).statusCode).toBe(200);
  });

  it('RL529-7 (AT-6): 501 names are 400 VALIDATION_ERROR; so are an empty list and an unknown field; 500 names are accepted', async () => {
    mockVerisign();
    const { batch } = await boot();
    const big = await batch(names(501));
    expect(big.statusCode).toBe(400);
    expect(big.json().error.code).toBe('VALIDATION_ERROR');
    expect((await batch([])).statusCode).toBe(400);
    expect((await batch(['a.com'], undefined, { extra: 1 })).statusCode).toBe(400);
    await setLimit(1000);
    const ok = await batch(names(500, 'zz'));
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ count: 500, live_n: 500, limit_hit: false });
  });

  it('RL529-8: batch order, duplicates and the cache-first rule; a whole-call 429 only when no row can be answered', async () => {
    mockVerisign();
    const { get, batch } = await boot();
    await get('/rdap/google.com');
    await setLimit(2);
    const r = await batch(['Google.com', 'ddddone.com', 'ddddone.com', 'ddddtwo.com']);
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.rows.map((x: { domain: string }) => x.domain)).toEqual(['google.com', 'ddddone.com', 'ddddone.com', 'ddddtwo.com']);
    expect(j).toMatchObject({ cached_n: 1, live_n: 1, limit_hit: true });
    expect(j.rows[3]).toMatchObject({ registered: null, reason_code: 'LOOKUP_LIMIT' });
    // nothing cached and no slot: 429
    const w = await batch(['eeeeone.com', 'eeeetwo.com']);
    expect(w.statusCode).toBe(429);
    expect(w.json().error.code).toBe('LOOKUP_LIMIT');
    expect((await batch(['notadomain'])).statusCode).toBe(422);
  });

  it('RL529-9: two calls at once never pass the limit (reserved under a lock before the lookup)', async () => {
    mockVerisign();
    const { get } = await boot();
    await setLimit(3);
    const res = await Promise.all(names(8, 'cc').map((n) => get(`/rdap/${n}`)));
    expect(res.filter((r) => r.statusCode === 200)).toHaveLength(3);
    expect(res.filter((r) => r.statusCode === 429)).toHaveLength(5);
    expect(await usageRows()).toBe(3);
  });

  it('RL529-10: bots, READ and WRITE tokens may call the routes (the batch is a read-only POST: no Idempotency-Key, no audit row); no token is 401; /lookups/usage shape', async () => {
    mockVerisign();
    const { get, batch, bots } = await boot();
    const read = (await issueToken('read', 'rl-read')).auth;
    const write = (await issueToken('write', 'rl-write')).auth;
    for (const h of [bots, read, write]) {
      expect((await get('/rdap/google.com', h)).statusCode).toBe(200);
      expect((await batch(['google.com'], h)).statusCode).toBe(200);
    }
    expect((await app.inject({ method: 'GET', url: '/rdap/google.com' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/rdap/batch', payload: { domains: ['google.com'] } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/lookups/usage' })).statusCode).toBe(401);
    expect((await get('/lookups/usage')).json()).toMatchObject({ source: 'rdap', used: 1, limit: 200, remaining: 199, window_hours: 24, resets_gradually: true });
    const audits = await sql<{ n: string }>`select count(*)::text as n from audit_log where path like '/rdap%'`.execute(testDb);
    expect(Number(audits.rows[0]!.n)).toBe(0);
    expect((await app.inject({ method: 'GET', url: '/rdap/google.net', headers: bots })).statusCode).toBe(422);
  });
});
