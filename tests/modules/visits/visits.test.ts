// v5.18.0 (CR-068): the visitor counter. IDs V518-1.. are listed in docs/internal/visits.md.
import { randomUUID } from 'node:crypto';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { PorkbunAdapter } from '../../../src/modules/registrars/porkbun.js';
import { RetentionJob } from '../../../src/modules/ops/jobs/retention.js';
import { makeApp } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { listedDomain } from '../../helpers/listing.js';
import { FAKE_KEYS, PORKBUN_BASE, record, recorded } from '../../helpers/porkbun-msw.js';
import { issueToken } from '../../helpers/tokens.js';
import { mswServer } from '../../setup/network.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const NOW = Date.parse('2026-10-20T09:00:00Z'); // a Tuesday
const PROXY = 'https://domain-trading-api-proxy.example.workers.dev';
const LISTED = 'ukcbamcompliance.com';
const AFNS = ['ns1.afternic.com', 'ns2.afternic.com'];
const PBNS = ['curitiba.ns.porkbun.com', 'fortaleza.ns.porkbun.com'];

async function setup(opts: { adapters?: FakeAdapter[] | PorkbunAdapter[]; enabled?: boolean } = {}) {
  app = await makeApp({ adapters: opts.adapters ?? [new FakeAdapter('porkbun')], now: () => NOW, env: { PUBLIC_BASE_URL: PROXY } });
  await db.updateTable('settings').set({ visits_enabled: opts.enabled !== false }).execute();
  return {
    v: (await issueToken('visits', 'visit-counter')).auth, w: (await issueToken('write', 'gavriel')).auth,
    r: (await issueToken('read')).auth, d: (await issueToken('data', 'data-engineer')).auth,
  };
}
const post = (url: string, h: Record<string, string>, payload: unknown, key: string = randomUUID()) =>
  app.inject({ method: 'POST', url, headers: { ...h, 'idempotency-key': key }, payload: payload as object });
const get = (url: string, h: Record<string, string>) => app.inject({ method: 'GET', url, headers: h });
const hit = (h: Record<string, string>, over: Record<string, unknown> = {}) => post('/visits/hit', h, { domain: LISTED, ua_class: 'human', ...over });
const approval = (text: string) => ({ text, approved_at: '2026-10-20T11:30:00+03:00' });
const seed = (domain = LISTED, over: Parameters<typeof listedDomain>[0] = {}) => listedDomain({ domain, lander: 'custom', lander_ns: PBNS, ...over });

describe('visits: hit', () => {
  it('V518-1: AT-1: with visits.enabled off POST /visits/hit is 409 VISITS_DISABLED and stores nothing; POST /visits/settings (WRITE) switches it with no approval line (5.19.0)', async () => {
    const { v, w, r } = await setup({ enabled: false });
    await seed();
    const res = await hit(v);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('VISITS_DISABLED');
    expect(await db.selectFrom('visit_daily').selectAll().execute()).toEqual([]);

    expect((await post('/visits/settings', r, { enabled: true })).statusCode).toBe(403);
    const on = await post('/visits/settings', w, { enabled: true });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json()).toMatchObject({ enabled: true, previous: false });
    expect((await hit(v)).statusCode).toBe(202);
    const audit = await db.selectFrom('audit_log').select(['path', 'approval_text']).where('path', '=', '/visits/settings').execute();
    expect(audit.length).toBeGreaterThanOrEqual(1);
    // a sent approval_ref is still accepted (and ignored)
    expect((await post('/visits/settings', w, { enabled: true, approval_ref: approval('anything') })).statusCode).toBe(200);
  });

  it('V518-2: AT-3: 3 human and 2 bot hits show as human_hits 3 and bot_hits 2 for the UTC day', async () => {
    const { v, r } = await setup();
    await seed();
    for (let i = 0; i < 3; i++) expect((await hit(v)).json()).toEqual({ counted: true, capped: false });
    for (let i = 0; i < 2; i++) await hit(v, { ua_class: 'bot' });
    const res = await get('/visits?from=2026-10-20&to=2026-10-20', r);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().rows).toEqual([expect.objectContaining({ domain: LISTED, date: '2026-10-20', source: 'dom_redirect', human_hits: 3, bot_hits: 2, capped: 0 })]);
    expect(res.json().enabled).toBe(true);
  });

  it('V518-3: AT-4: an unlisted name, a delisted name and a name on Afternic nameservers are 422 DOMAIN_NOT_LISTED; an extra key (ip) is 422 VALIDATION_ERROR', async () => {
    const { v } = await setup();
    await seed('delistedname.com', { status: 'delisted' });
    await seed('promptinjectionaudit.com', { lander: 'afternic', lander_ns: AFNS });
    for (const domain of ['nothere.com', 'delistedname.com', 'promptinjectionaudit.com', 'not a domain']) {
      const res = await hit(v, { domain });
      expect(res.statusCode, domain).toBe(422);
      expect(res.json().error.code).toBe('DOMAIN_NOT_LISTED');
    }
    const extra = await hit(v, { ip: '203.0.113.9' });
    expect(extra.statusCode).toBe(422);
    expect(extra.json().error.code).toBe('VALIDATION_ERROR');
    expect(await db.selectFrom('visit_daily').selectAll().execute()).toEqual([]);
  });

  it('V518-4: AT-5: a referrer URL is stored as its host only; no path, query, port or user agent reaches any table or the audit log', async () => {
    const { v } = await setup();
    await seed();
    await seed('second-listed.com');
    await hit(v, { referrer_host: 'https://X.com:8443/abc?utm=1#frag' });
    await hit(v, { referrer_host: 'x.com' });
    await hit(v, { referrer_host: 'a'.repeat(300) + '.com' });
    await hit(v, { referrer_host: null });
    const row = await db.selectFrom('visit_daily').select('referrer_hosts').where('domain', '=', LISTED).executeTakeFirstOrThrow();
    expect(row.referrer_hosts).toEqual({ 'x.com': 2, other: 1 });
    const dump = JSON.stringify((await sql`select to_jsonb(t) as j from visit_daily t`.execute(db)).rows) + JSON.stringify((await sql`select to_jsonb(t) as j from audit_log t`.execute(db)).rows);
    for (const leak of ['utm=1', '/abc', '8443', 'frag', 'Googlebot']) expect(dump).not.toContain(leak);
  });

  it('V518-5: AT-8: the 1,001st hit of a name in a UTC day adds to capped; human and bot counts stay', async () => {
    const { v } = await setup();
    await seed();
    await db.insertInto('visit_daily').values({ domain: LISTED, date_utc: '2026-10-20', source: 'dom_redirect', human_hits: 990, bot_hits: 9, capped: 0, referrer_hosts: '{}' }).execute();
    expect((await hit(v)).json()).toEqual({ counted: true, capped: false }); // the 1,000th
    for (let i = 0; i < 2; i++) expect((await hit(v, { ua_class: i ? 'bot' : 'human', referrer_host: 'late.example' })).json()).toEqual({ counted: false, capped: true });
    const row = await db.selectFrom('visit_daily').selectAll().where('domain', '=', LISTED).executeTakeFirstOrThrow();
    expect([row.human_hits, row.bot_hits, row.capped, row.referrer_hosts]).toEqual([991, 9, 2, {}]);
  });

  it('V518-6: concurrent hits lose no count; the first ten referrer hosts of a day keep their own key, the rest go to "other"', async () => {
    const { v } = await setup();
    await seed();
    const res = await Promise.all(Array.from({ length: 12 }, (_, i) => hit(v, { referrer_host: `site${i}.example` })));
    expect(res.every((x) => x.statusCode === 202)).toBe(true);
    const row = await db.selectFrom('visit_daily').selectAll().where('domain', '=', LISTED).executeTakeFirstOrThrow();
    expect(row.human_hits).toBe(12);
    const keys = Object.keys(row.referrer_hosts);
    expect(keys.filter((k) => k !== 'other')).toHaveLength(10);
    expect(Object.values(row.referrer_hosts).reduce((a, b) => a + b, 0)).toBe(12);
    expect(row.referrer_hosts.other).toBe(2);
  });

  it('V518-7: AT-9: a visits token can call only POST /visits/hit; READ, WRITE and data tokens cannot call it; the data token cannot GET /visits', async () => {
    const { v, w, r, d } = await setup();
    await seed();
    for (const h of [r, w, d]) {
      const res = await hit(h);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('SCOPE_FORBIDDEN');
    }
    expect((await get('/visits', d)).statusCode).toBe(403);
    expect((await get('/visits', v)).statusCode).toBe(403);
    expect((await get('/visits/weekly?week_ending=2026-10-17', v)).statusCode).toBe(403);
    expect((await post('/visits/import', v, { domain: LISTED, date: '2026-10-19', views_30d: 1, leads_30d: 0 })).statusCode).toBe(403);
    expect((await post('/visits/settings', v, { enabled: true, approval_ref: approval('visits') })).statusCode).toBe(403);
    expect((await get('/visits', r)).statusCode).toBe(200);
  });

  it('V518-8: a hit needs an Idempotency-Key, a replay of the same key counts once, and no audit_log row is written per hit', async () => {
    const { v } = await setup();
    await seed();
    const noKey = await app.inject({ method: 'POST', url: '/visits/hit', headers: v, payload: { domain: LISTED, ua_class: 'human' } });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const key = randomUUID();
    const a = await post('/visits/hit', v, { domain: LISTED, ua_class: 'human' }, key);
    const b = await post('/visits/hit', v, { domain: LISTED, ua_class: 'human' }, key);
    expect([a.statusCode, b.statusCode, b.headers['idempotent-replayed']]).toEqual([202, 202, 'true']);
    expect((await db.selectFrom('visit_daily').select('human_hits').executeTakeFirstOrThrow()).human_hits).toBe(1);
    expect(await db.selectFrom('audit_log').select('id').where('path', '=', '/visits/hit').execute()).toEqual([]);
  });
});

describe('visits: import, read, weekly, retention', () => {
  it('V518-9: POST /visits/import (WRITE or data) stores an afternic row, a re-import of the same (domain, date) replaces it, an unknown name is 422', async () => {
    const { w, d, r } = await setup();
    await seed('promptinjectionaudit.com', { lander: 'afternic', lander_ns: AFNS });
    const body = { domain: 'promptinjectionaudit.com', date: '2026-10-13', views_30d: 7, leads_30d: 0 };
    expect((await post('/visits/import', d, body)).statusCode).toBe(200);
    expect((await post('/visits/import', w, { ...body, views_30d: 9 })).statusCode).toBe(200);
    expect((await post('/visits/import', r, body)).statusCode).toBe(403);
    const rows = await db.selectFrom('visit_daily').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'afternic', views_30d: 9, leads_30d: 0, date_utc: '2026-10-13' });
    const unknown = await post('/visits/import', w, { ...body, domain: 'nobody.com' });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json().error.code).toBe('DOMAIN_NOT_LISTED');
    expect((await post('/visits/import', w, { ...body, ip: '1.2.3.4' })).statusCode).toBe(422);
  });

  it('V518-10: AT-7: GET /visits/weekly lists the counted names and puts Afternic-NS names and names without a forward under not_countable', async () => {
    const { w, d, r, v } = await setup();
    await seed(LISTED);
    await seed('mineunited.com', { lander: 'afternic', lander_ns: AFNS });
    await seed('promptinjectionaudit.com', { lander: 'afternic', lander_ns: AFNS });
    await seed('roofingvoiceagent.com'); // listed, Porkbun NS, no forward yet
    await db.insertInto('visit_forwards').values({ domain: LISTED, target: `${PROXY}/r/${LISTED}`, set_at: new Date(NOW) }).execute();
    await post('/visits/import', d, { domain: 'promptinjectionaudit.com', date: '2026-10-13', views_30d: 7, leads_30d: 1 });
    await post('/visits/import', w, { domain: 'promptinjectionaudit.com', date: '2026-10-19', views_30d: 8, leads_30d: 1 });
    // the week 2026-10-11 (Sun) .. 2026-10-17 (Sat): hits on 10-20 are outside it; put rows inside
    for (const [date, h, b, refs] of [['2026-10-12', 3, 1, { 'x.com': 2, 'y.com': 1 }], ['2026-10-16', 2, 0, { 'x.com': 1 }], ['2026-10-18', 50, 5, {}]] as const) {
      await db.insertInto('visit_daily').values({ domain: LISTED, date_utc: date, source: 'dom_redirect', human_hits: h, bot_hits: b, referrer_hosts: JSON.stringify(refs) }).execute();
    }
    void v;
    const res = await get('/visits/weekly?week_ending=2026-10-17', r);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ week_ending: '2026-10-17', week_start: '2026-10-11' });
    expect(body.rows).toEqual([{ domain: LISTED, source: 'dom_redirect', human_hits: 5, bot_hits: 1, capped: 0, top_referrers: [{ host: 'x.com', n: 3 }, { host: 'y.com', n: 1 }] }]);
    expect(body.not_countable).toEqual([
      { domain: 'mineunited.com', reason: 'afternic_ns', afternic_views_30d: null, afternic_leads_30d: null, afternic_read_date: null },
      { domain: 'promptinjectionaudit.com', reason: 'afternic_ns', afternic_views_30d: 8, afternic_leads_30d: 1, afternic_read_date: '2026-10-19' },
      { domain: 'roofingvoiceagent.com', reason: 'not_forwarded', afternic_views_30d: null, afternic_leads_30d: null, afternic_read_date: null },
    ]);
  });

  it('V518-11: weekly needs a Saturday (422 VALIDATION_ERROR); GET /visits is limited to 400 days and a valid range', async () => {
    const { r } = await setup();
    for (const q of ['week_ending=2026-10-18', 'week_ending=2026-10-16', '', 'week_ending=nope']) {
      const res = await get(`/visits/weekly?${q}`, r);
      expect(res.statusCode, q).toBe(422);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    }
    expect((await get('/visits/weekly?week_ending=2026-10-17', r)).statusCode).toBe(200);
    expect((await get('/visits?from=2025-09-01&to=2026-10-20', r)).statusCode).toBe(422);
    expect((await get('/visits?from=2025-09-17&to=2026-10-20', r)).statusCode).toBe(200); // 400 days exactly
    expect((await get('/visits?from=2026-10-20&to=2026-10-01', r)).statusCode).toBe(422);
    expect((await get('/visits?bogus=1', r)).statusCode).toBe(422);
  });

  it('V518-12: the retention job deletes visit_daily rows older than 400 days and keeps newer ones', async () => {
    await setup();
    for (const date of ['2025-09-01', '2025-09-30', '2026-10-19']) {
      await db.insertInto('visit_daily').values({ domain: LISTED, date_utc: date, source: 'dom_redirect', human_hits: 1 }).execute();
    }
    const out = await new RetentionJob({ db, now: () => NOW, dbBytes: async () => 1000 }).runOnce();
    expect('skipped' in out).toBe(false);
    expect((await db.selectFrom('visit_daily').select('date_utc').orderBy('date_utc').execute()).map((x) => x.date_utc)).toEqual(['2025-09-30', '2026-10-19']);
  });
});

describe('visits: forward', () => {
  const FWD = (id: string, sub: string, loc: string) => ({ id, subdomain: sub, location: loc, type: 'temporary', includePath: 'no', wildcard: 'yes' });
  const mockPorkbun = (forwards: unknown[]) => {
    mswServer.use(
      http.post(`${PORKBUN_BASE}/domain/getUrlForwarding/:d`, async ({ request }) => { await record(request); return HttpResponse.json({ status: 'SUCCESS', forwards }); }),
      http.post(`${PORKBUN_BASE}/domain/deleteUrlForward/:d/:id`, async ({ request }) => { await record(request); return HttpResponse.json({ status: 'SUCCESS' }); }),
      http.post(`${PORKBUN_BASE}/domain/addUrlForward/:d`, async ({ request }) => { await record(request); return HttpResponse.json({ status: 'SUCCESS' }); }),
    );
  };
  const old = [FWD('11', '', 'https://www.afternic.com/domain/ukcbamcompliance.com'), FWD('12', 'www', 'https://www.afternic.com/domain/ukcbamcompliance.com'), FWD('13', 'blog', 'https://elsewhere.example')];
  const line = (extra = '') => approval(`Dvir: yes ${LISTED} for visits ${extra}`);

  it('V518-13: dry_run returns before/after and calls no registrar; the real call deletes root and www, adds 302 forwards to <base>/r/<domain>, and records it', async () => {
    recorded.length = 0;
    mockPorkbun(old);
    const { w } = await setup({ adapters: [new PorkbunAdapter({ ...FAKE_KEYS, timeoutMs: 500 })] });
    await seed();
    const dry = await post(`/visits/forward/${LISTED}`, w, { approval_ref: line(), dry_run: true });
    expect(dry.statusCode, dry.body).toBe(200);
    expect(recorded.map((x) => x.path)).toEqual(['/domain/getUrlForwarding/ukcbamcompliance.com']); // the read; no write
    expect(dry.json()).toMatchObject({ domain: LISTED, dry_run: true });
    expect(dry.json().before.map((f: { subdomain: string }) => f.subdomain)).toEqual(['', 'www']);
    expect(dry.json().after).toEqual([
      { subdomain: '', location: `${PROXY}/r/${LISTED}`, type: 'temporary', include_path: false, wildcard: true },
      { subdomain: 'www', location: `${PROXY}/r/${LISTED}`, type: 'temporary', include_path: false, wildcard: true },
    ]);
    expect(await db.selectFrom('visit_forwards').selectAll().execute()).toEqual([]);

    recorded.length = 0;
    const real = await post(`/visits/forward/${LISTED}`, w, { approval_ref: line() });
    expect(real.statusCode, real.body).toBe(200);
    expect(recorded.map((x) => `${x.method} ${x.path}`)).toEqual([
      'POST /domain/getUrlForwarding/ukcbamcompliance.com', 'POST /domain/deleteUrlForward/ukcbamcompliance.com/11', 'POST /domain/deleteUrlForward/ukcbamcompliance.com/12',
      'POST /domain/addUrlForward/ukcbamcompliance.com', 'POST /domain/addUrlForward/ukcbamcompliance.com',
    ]);
    expect(recorded[3]!.body).toEqual({ location: `${PROXY}/r/${LISTED}`, type: 'temporary', redirectType: '302', includePath: 'no', wildcard: 'yes' });
    expect(recorded[4]!.body).toMatchObject({ subdomain: 'www' });
    const st = await db.selectFrom('visit_forwards').selectAll().executeTakeFirstOrThrow();
    expect([st.domain, st.target, st.reverted_at]).toEqual([LISTED, `${PROXY}/r/${LISTED}`, null]);
    expect((await db.selectFrom('audit_log').select('result_summary').where('path', '=', `/visits/forward/${LISTED}`).execute()).length).toBe(2);
  });

  it('V518-14: revert:true points the forward back at the Afternic page and marks the row reverted', async () => {
    recorded.length = 0;
    mockPorkbun([FWD('21', '', `${PROXY}/r/${LISTED}`)]);
    const { w, r } = await setup({ adapters: [new PorkbunAdapter({ ...FAKE_KEYS, timeoutMs: 500 })] });
    await seed();
    await db.insertInto('visit_forwards').values({ domain: LISTED, target: `${PROXY}/r/${LISTED}`, set_at: new Date(NOW) }).execute();
    const res = await post(`/visits/forward/${LISTED}`, w, { approval_ref: line(), revert: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().after).toEqual([expect.objectContaining({ subdomain: '', location: `https://www.afternic.com/domain/${LISTED}` })]);
    expect((await db.selectFrom('visit_forwards').select('reverted_at').executeTakeFirstOrThrow()).reverted_at).not.toBeNull();
    const week = (await get('/visits/weekly?week_ending=2026-10-17', r)).json();
    expect(week.not_countable.map((n: { reason: string }) => n.reason)).toEqual(['not_forwarded']);
  });

  it('V519-2: BUG-045: lander "afternic" with Porkbun nameservers is forwardable (live NS decides); live Afternic NS refuses even when the stored NS are empty; weekly follows the live NS', async () => {
    recorded.length = 0;
    mockPorkbun(old);
    const live: Record<string, string[] | null> = { [LISTED]: PBNS, 'pia.com': AFNS, 'nolookup.com': null };
    app = await makeApp({ adapters: [new PorkbunAdapter({ ...FAKE_KEYS, timeoutMs: 500 })], now: () => NOW, env: { PUBLIC_BASE_URL: PROXY }, nsLookup: async (d: string) => live[d] ?? null });
    const w = (await issueToken('write', 'gavriel')).auth;
    const r = (await issueToken('read')).auth;
    await seed(LISTED, { lander: 'afternic', lander_ns: null });
    await seed('pia.com', { lander: 'afternic', lander_ns: null });
    await seed('nolookup.com', { lander: 'afternic', lander_ns: null });
    const ok = await post(`/visits/forward/${LISTED}`, w, { dry_run: true });
    expect(ok.statusCode, ok.body).toBe(200);
    const no = await post('/visits/forward/pia.com', w, { dry_run: true });
    expect(no.json().error).toMatchObject({ code: 'FORWARD_NOT_ALLOWED', details: { reason: 'afternic_ns' } });
    const week = (await get('/visits/weekly?week_ending=2026-10-17', r)).json();
    const reasons = Object.fromEntries(week.not_countable.map((n: { domain: string; reason: string }) => [n.domain, n.reason]));
    expect(reasons).toEqual({ [LISTED]: 'not_forwarded', 'pia.com': 'afternic_ns', 'nolookup.com': 'not_forwarded' });
  });

  it('V518-15: the forward needs no approval line (5.19.0); it is refused for a name not listed, not at Porkbun, on Afternic nameservers, or when PUBLIC_BASE_URL is the default; a READ token is 403', async () => {
    const { w, r } = await setup({ adapters: [new FakeAdapter('porkbun')] });
    await seed();
    const url = `/visits/forward/${LISTED}`;
    expect((await post(url, r, { approval_ref: line() })).statusCode).toBe(403);
    expect((await post(url, w, { dry_run: true })).json().error?.code).not.toBe('APPROVAL_INVALID');
    const cases: [string, Parameters<typeof listedDomain>[0], string][] = [
      ['delisted-one.com', { status: 'delisted' }, 'not_listed'], ['at-godaddy.com', { registrar: 'godaddy', registrar_api: 'manage' }, 'registrar'], ['on-afternic.com', { lander: 'afternic', lander_ns: AFNS }, 'afternic_ns'],
    ];
    for (const [domain, over, reason] of cases) {
      await seed(domain, over);
      const res = await post(`/visits/forward/${domain}`, w, { approval_ref: approval(`Dvir: yes ${domain} for visits`), dry_run: true });
      expect(res.statusCode, domain).toBe(422);
      expect(res.json().error).toMatchObject({ code: 'FORWARD_NOT_ALLOWED', details: { reason } });
    }
    expect((await post('/visits/forward/unknown.com', w, { approval_ref: approval('Dvir: unknown.com visits'), dry_run: true })).statusCode).toBe(404);
    await app.close();
    app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => NOW });
    const dflt = await post(url, w, { approval_ref: line(), dry_run: true });
    expect(dflt.statusCode).toBe(422);
    expect(dflt.json().error.code).toBe('PUBLIC_BASE_URL_UNSET');
  });
});
