// v5.61.0: the Afternic seller API (client, daily read step afternicSync, drift warnings, POST /export/afternic/push). MSW only; fake keys; no real Afternic call.
import { randomUUID } from 'node:crypto';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AfternicApiError, AfternicClient, centsOfMicro, microOfCents, patchBody } from '../../../src/modules/listing/afternic-api.js';
import { AfternicSyncJob } from '../../../src/modules/ops/jobs/afternic-sync.js';
import { PriceScheduleJob } from '../../../src/modules/ops/jobs/price-schedule.js';
import { importAfternic } from '../../../src/modules/visits/index.js';
import { makeApp, runJobToEnd } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { listedDomain } from '../../helpers/listing.js';
import { issueToken } from '../../helpers/tokens.js';
import { mswServer } from '../../setup/network.js';

const BASE = 'https://api.afternic.com';
const P = `${BASE}/v3/aftermarket/customers/my`;
const KEY = 'fake-afternic-key-0001';
const SECRET = 'fake-afternic-secret-0001';
const NOW = Date.parse('2027-03-10T09:00:00Z');
const A = 'examplecityroofing.com';
const B = 'exampletowncafe.com';
let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

/** What Afternic shows for a name that matches the plan of listedDomain({bin 148800, floor 96700, min 10000}) with the lease on at 12 months. */
const raw = (name: string, over: Record<string, unknown> = {}) => ({
  name, displayName: name, tld: 'com', buynowPrice: 1488000000, floorPrice: 967000000, minbidPrice: 100000000, leasingEnabled: true, maxLeasePeriod: 12,
  intakeStyle: 'CUSTOM_LANDER', landingPage: 'SALES_TYPE', showLanderBuynowOption: true, showLanderLeaseToOwnOption: true, showLanderMakeOfferOption: true,
  hidden: false, listStatus: 'ACTIVE', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z', intakeViews: 3, ...over,
});
const listA = (over: Record<string, unknown> = {}) => listedDomain({ domain: A, bin_cents: 148800, floor_cents: 96700, walkaway_cents: 71400, min_offer_cents: 10000, ...over });

interface Call { method: string; url: string; body: any; auth: string | null } // eslint-disable-line @typescript-eslint/no-explicit-any
function afternic(state: { domains?: unknown[]; patchStatus?: Record<string, number>; stats?: Record<string, { views: number; leads: number }[]>; listStatus?: number } = {}) {
  const calls: Call[] = [];
  const rec = async (request: Request) => {
    const text = await request.text();
    calls.push({ method: request.method, url: request.url, body: text ? JSON.parse(text) : null, auth: request.headers.get('authorization') });
  };
  mswServer.use(
    http.get(`${P}/domains`, async ({ request }) => {
      await rec(request);
      if (state.listStatus) return HttpResponse.json({ code: 'RATE_LIMIT_EXCEEDED' }, { status: state.listStatus });
      const u = new URL(request.url);
      const off = Number(u.searchParams.get('offset') ?? 0);
      const lim = Number(u.searchParams.get('limit') ?? 100);
      return HttpResponse.json({ domains: (state.domains ?? []).slice(off, off + lim), pagination: {} });
    }),
    http.patch(`${P}/domains/:name`, async ({ request, params }) => {
      await rec(request);
      const code = state.patchStatus?.[String(params.name)];
      return code ? HttpResponse.json({ code: 'DEPENDENCY_ISSUE', message: `secret ${SECRET}` }, { status: code }) : new HttpResponse(null, { status: 204 });
    }),
    http.get(`${P}/stats/:name`, async ({ request, params }) => {
      await rec(request);
      return HttpResponse.json({ stats: state.stats?.[String(params.name)] ?? [{ date: '2027-03-01T00:00:00Z', views: 4, leads: 1 }, { date: '2027-03-02T00:00:00Z', views: 6, leads: 0 }] });
    }),
  );
  return calls;
}
const client = (o: Partial<ConstructorParameters<typeof AfternicClient>[0]> = {}) => new AfternicClient({ fetch: globalThis.fetch, baseUrl: BASE, apiKey: KEY, apiSecret: SECRET, sleep: async () => {}, ...o });
const syncJob = (c: AfternicClient | null = client()) => new AfternicSyncJob({ db, client: c, now: () => NOW, recordViews: (o) => importAfternic(db, o) });
const env = { AFTERNIC_API_KEY: KEY, AFTERNIC_API_SECRET: SECRET };
const post = (a: FastifyInstance, auth: Record<string, string>, payload: unknown, key: string = randomUUID()) =>
  a.inject({ method: 'POST', url: '/export/afternic/push', headers: { ...auth, 'idempotency-key': key }, payload: payload as Record<string, unknown> });
const warnings = async (a: FastifyInstance) => {
  const read = (await issueToken('read')).auth;
  await db.insertInto('job_runs').values({ job: 'daily', trigger: 'scheduled', started_at: new Date(NOW - 3_660_000), finished_at: new Date(NOW - 3_600_000), skipped: false, ok: true, steps: '{}' }).execute();
  return (await a.inject({ method: 'GET', url: '/report', headers: read })).json().warnings as { code: string; level: string; domain?: string; details: Record<string, any> }[]; // eslint-disable-line @typescript-eslint/no-explicit-any
};

describe('Afternic client', () => {
  it('AFN-1: micro-USD and cents convert both ways; the update body uses the documented field names and only the given fields', () => {
    expect(microOfCents(148800)).toBe(1488000000);
    expect(centsOfMicro(1488000000)).toBe(148800);
    expect(centsOfMicro(undefined)).toBeNull();
    expect(patchBody({ bin_cents: 148800, floor_cents: 96700, min_offer_cents: 10000, leasing_enabled: true, max_lease_months: 12, show_buynow: true, show_lto: true, show_offer: true, intake_style: 'CUSTOM_LANDER', hidden: false }))
      .toEqual({ buynowPrice: 1488000000, floorPrice: 967000000, minbidPrice: 100000000, leasingEnabled: true, maxLeasePeriod: 12, showLanderBuynowOption: true, showLanderLeaseToOwnOption: true, showLanderMakeOfferOption: true, landingPage: 'SALES_TYPE', intakeStyle: 'CUSTOM_LANDER', hidden: false });
    expect(patchBody({ bin_cents: 99900 })).toEqual({ buynowPrice: 999000000 });
  });

  it('AFN-2: list reads every page (100 a page), sends the sso-key header and converts prices to cents', async () => {
    const domains = Array.from({ length: 130 }, (_, i) => raw(`name${String(i).padStart(3, '0')}.com`));
    const calls = afternic({ domains });
    const all = await client().list();
    expect(all).toHaveLength(130);
    expect(all[0]).toMatchObject({ name: 'name000.com', bin_cents: 148800, floor_cents: 96700, min_offer_cents: 10000, leasing_enabled: true, max_lease_months: 12, intake_style: 'CUSTOM_LANDER', hidden: false, list_status: 'ACTIVE', intake_views: 3 });
    expect(calls.map((c) => new URL(c.url).searchParams.get('offset'))).toEqual(['0', '100']);
    expect(calls[0]!.auth).toBe(`sso-key ${KEY}:${SECRET}`);
  });

  it('AFN-3: a 429 is retried after Retry-After / backoff; after three retries it is AFTERNIC_RATE_LIMITED', async () => {
    const sleeps: number[] = [];
    let n = 0;
    mswServer.use(http.get(`${P}/domains`, () => (++n <= 2 ? new HttpResponse('slow down', { status: 429, headers: { 'retry-after': '3' } }) : HttpResponse.json({ domains: [raw(A)] }))));
    expect(await client({ sleep: async (ms) => { sleeps.push(ms); } }).list()).toHaveLength(1);
    expect(sleeps).toEqual([3000, 3000]);
    mswServer.use(http.get(`${P}/domains`, () => new HttpResponse('slow down', { status: 429 })));
    const s2: number[] = [];
    await expect(client({ sleep: async (ms) => { s2.push(ms); } }).list()).rejects.toMatchObject({ code: 'AFTERNIC_RATE_LIMITED', status: 429 });
    expect(s2).toEqual([1000, 2000, 4000]);
  });

  it('AFN-4: a 401 is AFTERNIC_AUTH; no key or secret is ever in the error text, even when Afternic echoes it', async () => {
    mswServer.use(http.get(`${P}/domains`, () => HttpResponse.json({ code: 'AUTH_CODE_INVALID', message: `bad ${KEY}:${SECRET}` }, { status: 401 })));
    const e = await client().list().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AfternicApiError);
    expect(e).toMatchObject({ code: 'AFTERNIC_AUTH', status: 401 });
    expect((e as Error).message).not.toContain(KEY);
    expect((e as Error).message).not.toContain(SECRET);
    mswServer.use(http.patch(`${P}/domains/:n`, () => HttpResponse.json({ code: 'VALIDATION_ERROR' }, { status: 422 })));
    await expect(client().update(A, { bin_cents: 100 })).rejects.toMatchObject({ code: 'AFTERNIC_REJECTED' });
    mswServer.use(http.patch(`${P}/domains/:n`, () => HttpResponse.json({ code: 'RESOURCE_NOT_FOUND' }, { status: 404 })));
    await expect(client().update(A, { bin_cents: 100 })).rejects.toMatchObject({ code: 'AFTERNIC_NOT_FOUND', status: 404 });
    mswServer.use(http.get(`${P}/domains/:n`, () => HttpResponse.json({}, { status: 404 })));
    expect(await client().get(A)).toBeNull();
  });

  it('AFN-4b: a 500 is AFTERNIC_UNAVAILABLE and a non-JSON 200 is AFTERNIC_BAD_RESPONSE', async () => {
    mswServer.use(http.get(`${P}/domains`, () => new HttpResponse('oops', { status: 503 })));
    await expect(client().list()).rejects.toMatchObject({ code: 'AFTERNIC_UNAVAILABLE', status: 503 });
    mswServer.use(http.get(`${P}/domains`, () => new HttpResponse('<html>', { status: 200 })));
    await expect(client().list()).rejects.toMatchObject({ code: 'AFTERNIC_BAD_RESPONSE' });
  });

  it('AFN-5: the limiter keeps to 150 requests in any minute (it waits, with the clock injected)', async () => {
    mswServer.use(http.get(`${P}/domains/:n`, () => HttpResponse.json(raw(A))));
    let t = 0;
    const waits: number[] = [];
    const c = client({ now: () => t, sleep: async (ms) => { waits.push(ms); t += ms; } });
    for (let i = 0; i < 150; i++) await c.get(A);
    expect(waits).toEqual([]);
    await c.get(A);
    expect(waits).toEqual([60_000]);
  });
});

describe('afternicSync (daily step)', () => {
  it('AFN-6: without the key pair the step is skipped as not_configured and calls nothing', async () => {
    const calls = afternic();
    await listA();
    expect(await syncJob(null).runOnce()).toMatchObject({ status: 'not_configured', skipped: true, listings_n: 0 });
    expect(calls).toEqual([]);
  });

  it('AFN-7: it stores one row per name per UTC day (a second run replaces it), records the 30-day views as source afternic, counts drift, and only reads', async () => {
    const calls = afternic({ domains: [raw(A), raw(B, { buynowPrice: 999000000 }), raw('notours.com')] });
    await listA();
    await listedDomain({ domain: B, bin_cents: 148800, floor_cents: 96700, walkaway_cents: 71400, min_offer_cents: 10000 });
    const r = await syncJob().runOnce();
    expect(r).toEqual({ status: 'ok', listings_n: 3, drift_n: 1, views_stored_n: 2 });
    await syncJob().runOnce();
    const rows = await db.selectFrom('afternic_listings_daily').selectAll().orderBy('domain').execute();
    expect(rows).toHaveLength(3);
    expect(rows.find((x) => x.domain === A)).toMatchObject({ day: '2027-03-10', list_status: 'ACTIVE', bin_cents: 148800, floor_cents: 96700, min_offer_cents: 10000, leasing_enabled: true, max_lease_months: 12, show_buynow: true, show_lto: true, show_offer: true, intake_style: 'CUSTOM_LANDER', hidden: false, views: 10, leads: 1 });
    expect(rows.find((x) => x.domain === B)!.bin_cents).toBe(99900);
    const visits = await db.selectFrom('visit_daily').select(['domain', 'source', 'views_30d', 'leads_30d']).where('source', '=', 'afternic').orderBy('domain').execute();
    expect(visits).toEqual([{ domain: A, source: 'afternic', views_30d: 10, leads_30d: 1 }, { domain: B, source: 'afternic', views_30d: 10, leads_30d: 1 }]);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('AFN-8: the daily run has the step after listingSync; without keys it is skipped and the run is ok', async () => {
    app = await makeApp({ testRoutes: false, env: { JOB_TRIGGER_TOKEN: 'job_token_fake_0123456789abcdef0123456789' }, adapters: [new FakeAdapter('porkbun')], now: () => NOW });
    const res = await runJobToEnd(app, 'daily', { key: 'afn-1' });
    const steps = Object.keys(res.json().steps);
    expect(steps.indexOf('afternicSync')).toBe(steps.indexOf('listingSync') + 1);
    expect(res.json().steps.afternicSync).toMatchObject({ ok: true, skipped: true, summary: { status: 'not_configured' } });
  });
});

describe('/report drift warnings', () => {
  it('AFN-9: AFTERNIC_DRIFT lists plan vs Afternic per field; AFTERNIC_NOT_LISTED for a missing name; a matching name raises nothing; no read, no warning', async () => {
    app = await makeApp({ now: () => NOW, adapters: [new FakeAdapter('porkbun')], env });
    await listA();
    await listedDomain({ domain: B, bin_cents: 148800, floor_cents: 96700, walkaway_cents: 71400, min_offer_cents: 10000 });
    expect((await warnings(app)).filter((w) => w.code.startsWith('AFTERNIC_'))).toEqual([]);
    afternic({ domains: [raw(A, { buynowPrice: 1088000000, maxLeasePeriod: 16, showLanderMakeOfferOption: false })] });
    await syncJob().runOnce();
    const w = (await warnings(app)).filter((x) => x.code.startsWith('AFTERNIC_'));
    expect(w.map((x) => [x.code, x.level, x.domain])).toEqual([['AFTERNIC_DRIFT', 'warn', A], ['AFTERNIC_NOT_LISTED', 'warn', B]]);
    expect(w[0]!.details).toMatchObject({ domain: A, fields: [
      { field: 'bin_cents', plan: 148800, afternic: 108800 }, { field: 'max_lease_months', plan: 12, afternic: 16 }, { field: 'show_offer', plan: true, afternic: false },
    ] });
  });
});

describe('POST /export/afternic/push', () => {
  const setup = async () => {
    app = await makeApp({ now: () => NOW, adapters: [new FakeAdapter('porkbun')], env });
    return (await issueToken('write')).auth;
  };

  it('AFN-10: without the key pair it answers 503 AFTERNIC_NOT_CONFIGURED; READ and bots tokens are refused', async () => {
    app = await makeApp({ now: () => NOW, adapters: [new FakeAdapter('porkbun')] });
    const w = (await issueToken('write')).auth;
    expect((await post(app, w, {})).json().error.code).toBe('AFTERNIC_NOT_CONFIGURED');
    expect((await post(app, (await issueToken('read')).auth, {})).statusCode).toBe(403);
    expect((await post(app, (await issueToken('bots')).auth, { dry_run: true })).statusCode).toBe(403);
  });

  it('AFN-11: dry_run returns the diff and changes nothing (no PATCH, no upload record, the name stays pending)', async () => {
    const auth = await setup();
    const calls = afternic({ domains: [raw(A, { buynowPrice: 1088000000, leasingEnabled: false, showLanderLeaseToOwnOption: false }), raw(B)] });
    await listA();
    await listedDomain({ domain: B, bin_cents: 148800, floor_cents: 96700, walkaway_cents: 71400, min_offer_cents: 10000 });
    const res = await post(app!, auth, { dry_run: true });
    expect(res.statusCode, res.body).toBe(200);
    const j = res.json();
    expect(j).toMatchObject({ dry_run: true, unchanged: [B], failed: [], upload: { recorded: false, reason: 'DRY_RUN' } });
    expect(j.pushed).toEqual([{ domain: A, fields: [
      { field: 'bin_cents', plan: 148800, afternic: 108800 }, { field: 'leasing_enabled', plan: true, afternic: false }, { field: 'show_lto', plan: true, afternic: false },
    ] }]);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(await db.selectFrom('export_runs').select('id').execute()).toEqual([]);
  });

  it('AFN-12: a real push PATCHes only the differing fields, never sends the walk-away or floor-as-walkaway, records the upload and clears EXPORT_PENDING', async () => {
    const auth = await setup();
    const calls = afternic({ domains: [raw(A, { buynowPrice: 1088000000, leasingEnabled: false, showLanderLeaseToOwnOption: false }), raw(B)] });
    await listA({ listing_changed_at: new Date(NOW - 3_600_000), export_pending_since: new Date(NOW - 3_600_000) });
    await listedDomain({ domain: B, bin_cents: 148800, floor_cents: 96700, walkaway_cents: 71400, min_offer_cents: 10000, listing_changed_at: new Date(NOW - 3_600_000), export_pending_since: new Date(NOW - 3_600_000) });
    expect((await warnings(app!)).filter((w) => w.code === 'EXPORT_PENDING')).toHaveLength(2);
    const res = await post(app!, auth, {});
    expect(res.statusCode, res.body).toBe(200);
    const j = res.json();
    expect(j).toMatchObject({ dry_run: false, unchanged: [B], failed: [], upload: { recorded: true } });
    expect(j.pushed.map((x: { domain: string }) => x.domain)).toEqual([A]);
    const patches = calls.filter((c) => c.method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0]!.url).toBe(`${P}/domains/${A}`);
    expect(patches[0]!.body).toEqual({ buynowPrice: 1488000000, leasingEnabled: true, maxLeasePeriod: 12, showLanderLeaseToOwnOption: true });
    expect(JSON.stringify(calls.map((c) => c.body))).not.toMatch(/714|71400|714000000|walkaway/i);
    const up = await db.selectFrom('export_uploads').selectAll().execute();
    expect(up).toHaveLength(1);
    expect(up[0]!.domains).toEqual([A, B]);
    expect(up[0]!.venue).toBe('afternic');
    expect((await db.selectFrom('domains').select(['domain', 'export_pending_since']).where('domain', 'in', [A, B]).execute()).every((d) => d.export_pending_since === null)).toBe(true);
    expect((await warnings(app!)).filter((w) => w.code === 'EXPORT_PENDING')).toEqual([]);
    const audit = await db.selectFrom('audit_log').selectAll().execute();
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain(SECRET);
    expect(JSON.stringify(audit)).toContain('afternic push');
  });

  it('AFN-13: a failed name or a name missing at Afternic is reported with its code; the upload is then not recorded; a partial domain list never records', async () => {
    const auth = await setup();
    afternic({ domains: [raw(A, { buynowPrice: 1 })], patchStatus: { [A]: 422 } });
    await listA();
    await listedDomain({ domain: B, bin_cents: 148800, floor_cents: 96700, walkaway_cents: 71400, min_offer_cents: 10000 });
    const j = (await post(app!, auth, {})).json();
    expect(j.failed).toEqual([{ domain: A, code: 'AFTERNIC_REJECTED' }, { domain: B, code: 'AFTERNIC_NOT_LISTED' }]);
    expect(j.upload).toEqual({ recorded: false, export_id: null, reason: 'SOME_FAILED' });
    expect(JSON.stringify(j)).not.toContain(SECRET);
    afternic({ domains: [raw(A), raw(B)] });
    const part = (await post(app!, auth, { domains: [A] })).json();
    expect(part).toMatchObject({ unchanged: [A], upload: { recorded: false, reason: 'PARTIAL_DOMAIN_LIST' } });
    const unknown = (await post(app!, auth, { domains: ['nolist.com'] })).json();
    expect(unknown.failed).toEqual([{ domain: 'nolist.com', code: 'DOMAIN_NOT_LISTED' }]);
    expect(await db.selectFrom('export_uploads').select('id').execute()).toEqual([]);
  });

  it('AFN-14: a failing listing read is 502 AFTERNIC_API_ERROR with the reason; the same Idempotency-Key replays the first answer without a second call', async () => {
    const auth = await setup();
    afternic({ listStatus: 401 });
    await listA();
    const key = randomUUID();
    const r1 = await post(app!, auth, {}, key);
    expect(r1.statusCode).toBe(502);
    expect(r1.json().error).toMatchObject({ code: 'AFTERNIC_API_ERROR', details: { reason: 'AFTERNIC_AUTH', status: 401 } });
    afternic({ domains: [raw(A)] });
    const ok1 = await post(app!, auth, { dry_run: true }, 'same-key-1');
    const calls = afternic({ domains: [raw(A)] });
    const ok2 = await post(app!, auth, { dry_run: true }, 'same-key-1');
    expect(ok2.json()).toEqual(ok1.json());
    expect(calls).toEqual([]);
  });
});

describe('founder rule 4 and the lease setting', () => {
  it('AFN-15: the scheduled price job and the drop job never call Afternic', async () => {
    const calls = afternic({ domains: [raw(A)] });
    await listA();
    await new PriceScheduleJob({ db, now: () => NOW }).runOnce();
    expect(calls).toEqual([]);
  });

  it('AFN-16: the migration set the global lease-to-own maximum to 12 months (was 16)', async () => {
    const s = await db.selectFrom('settings').select(['afternic_lease_to_own', 'afternic_lease_months']).executeTakeFirstOrThrow();
    expect(s).toEqual({ afternic_lease_to_own: true, afternic_lease_months: 12 });
  });
});
