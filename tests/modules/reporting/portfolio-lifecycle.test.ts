// v4.0.0: CR-045 items 1-3 (renewal drop check, SELL_BEFORE_DROP, horizon route and HORIZON_DUE), CR-044 item 2 and CR-046 item 4 (stats, outcomes), CR-049 items 4-5
// (DELIST_NEEDED, per-venue report), G-85 (the quarterly renewal cost).
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../../helpers/app.js';
import { readyToBuy } from '../../helpers/buy.js';
import { insertOwnedDomain, testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { issueToken } from '../../helpers/tokens.js';
import { recordRenewal } from '../../../src/modules/ops/admin/record-renewal.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const D = 'examplecityroofing.com';
const clock = { t: Date.parse('2027-08-10T09:00:00Z') };
const approval = (domain = D) => ({ text: `yes, set ${domain}`, approved_at: new Date(clock.t - 3_600_000).toISOString() });

async function setup(over: Parameters<typeof insertOwnedDomain>[1] = {}) {
  clock.t = Date.parse('2027-08-10T09:00:00Z');
  app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => clock.t });
  await insertOwnedDomain(db, { domain: D, status: 'listed', category: 'trend', price_grade: null, ...over });
  await db.insertInto('job_runs').values({ job: 'daily', trigger: 'scheduled', started_at: new Date(clock.t - 3_660_000), finished_at: new Date(clock.t - 3_600_000), skipped: false, ok: true, steps: '{}' }).execute();
  return { w: (await issueToken('write', 'gavriel')).auth, r: (await issueToken('read')).auth };
}
const post = (url: string, auth: Record<string, string>, payload: object, key: string = randomUUID()) =>
  app.inject({ method: 'POST', url, headers: { ...auth, 'idempotency-key': key }, payload });
const get = (url: string, auth: Record<string, string>) => app.inject({ method: 'GET', url, headers: auth });
const warns = async (r: Record<string, string>, code?: string) => {
  const w = (await get('/report', r)).json().warnings as { code: string; level: string; domain?: string; details: Record<string, any> }[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  return code ? w.filter((x) => x.code === code) : w;
};
const dom = () => db.selectFrom('domains').selectAll().where('domain', '=', D).executeTakeFirstOrThrow();

describe('POST /portfolio/{domain}/horizon (CR-045 item 2, CR-046 item 1)', () => {
  it('HR-1: approval_ref is required and must name the domain', async () => {
    const { w } = await setup();
    expect((await post(`/portfolio/${D}/horizon`, w, { horizon: 'trend' })).json().error.code).toBe('APPROVAL_INVALID');
    expect((await post(`/portfolio/${D}/horizon`, w, { horizon: 'trend', approval_ref: { text: 'yes, set other.com', approved_at: approval().approved_at } })).json().error.code).toBe('APPROVAL_INVALID');
    expect((await dom()).horizon).toBe('evergreen');
  });

  it('HR-2: trend sets sell_or_drop_by = buy + 12 months and drop_date = the first expiry; a repeat changes nothing', async () => {
    const { w } = await setup();
    const res = await post(`/portfolio/${D}/horizon`, w, { horizon: 'trend', approval_ref: approval() });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ domain: D, horizon: 'trend', sell_or_drop_by: '2027-10-04', drop_date: '2027-10-04', expiry_date: '2027-10-04' });
    expect(await dom()).toMatchObject({ horizon: 'trend', sell_or_drop_by: '2027-10-04', drop_date: '2027-10-04' });
    const again = await post(`/portfolio/${D}/horizon`, w, { horizon: 'regulation', approval_ref: approval() });
    expect(again.statusCode, again.body).toBe(200);
    expect(await dom()).toMatchObject({ horizon: 'regulation', drop_date: '2027-10-04' });
    expect(await db.selectFrom('audit_log').select('id').where('path', 'like', '%/horizon').execute()).toHaveLength(2);
  });

  it('HR-3: evergreen clears sell_or_drop_by; a renewed name cannot become trend (MAX_ONE_RENEWAL_USED); unknown name 404; READ token 403', async () => {
    const { w, r } = await setup();
    await post(`/portfolio/${D}/horizon`, w, { horizon: 'trend', approval_ref: approval() });
    await post(`/portfolio/${D}/horizon`, w, { horizon: 'evergreen', approval_ref: approval() });
    expect(await dom()).toMatchObject({ horizon: 'evergreen', sell_or_drop_by: null });
    expect((await post(`/portfolio/nothere.com/horizon`, w, { horizon: 'trend', approval_ref: approval('nothere.com') })).statusCode).toBe(404);
    expect((await post(`/portfolio/${D}/horizon`, r, { horizon: 'trend', approval_ref: approval() })).statusCode).toBe(403);
    await db.updateTable('domains').set({ renewals_used: 1 }).where('domain', '=', D).execute();
    expect((await post(`/portfolio/${D}/horizon`, w, { horizon: 'trend', approval_ref: approval() })).json().error.code).toBe('MAX_ONE_RENEWAL_USED');
  });

  it('HR-4: HORIZON_DUE is a warning 30 days before sell_or_drop_by and an error once past', async () => {
    const { w, r } = await setup({ horizon: 'trend', sell_or_drop_by: '2027-10-04', drop_date: '2027-10-04' });
    expect(await warns(r, 'HORIZON_DUE')).toHaveLength(0); // 55 days left
    clock.t = Date.parse('2027-09-20T09:00:00Z');
    expect(await warns(r, 'HORIZON_DUE')).toMatchObject([{ level: 'warn', domain: D, details: { horizon: 'trend', sell_or_drop_by: '2027-10-04', days_left: 14 } }]);
    clock.t = Date.parse('2027-10-06T09:00:00Z');
    expect((await warns(r, 'HORIZON_DUE'))[0]!.level).toBe('error');
    void w;
  });
});

describe('POST /portfolio/{domain}/stats (CR-044 item 2)', () => {
  it('ST-1: stores views, leads, inquiries, offers per month and venue; defaults venue afternic and month of as_of; append-only', async () => {
    const { w } = await setup();
    const res = await post(`/portfolio/${D}/stats`, w, { as_of: '2027-08-09', views: 120, leads: 3, offers: 1, source: 'afternic dashboard' });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ domain: D, month: '2027-08', venue: 'afternic', views: 120, leads: 3, inquiries: null, offers: 1 });
    await post(`/portfolio/${D}/stats`, w, { as_of: '2027-08-09', venue: 'sellerhub', views: 10, month: '2027-08', source: 'sellerhub' });
    const rows = await db.selectFrom('portfolio_stats').selectAll().orderBy('id').execute();
    expect(rows.map((x) => x.venue)).toEqual(['afternic', 'sellerhub']);
    await expect(db.updateTable('portfolio_stats').set({ views: 1 }).execute()).rejects.toThrow();
  });

  it('ST-2: validation: no metric, a future date, an unknown venue, an unknown name, a negative count', async () => {
    const { w } = await setup();
    expect((await post(`/portfolio/${D}/stats`, w, { as_of: '2027-08-09', source: 'x' })).statusCode).toBe(422);
    expect((await post(`/portfolio/${D}/stats`, w, { as_of: '2027-09-09', views: 1, source: 'x' })).statusCode).toBe(422);
    expect((await post(`/portfolio/${D}/stats`, w, { as_of: '2027-08-09', views: 1, venue: 'flippa', source: 'x' })).statusCode).toBe(422);
    expect((await post(`/portfolio/${D}/stats`, w, { as_of: '2027-08-09', views: -1, source: 'x' })).statusCode).toBe(422);
    expect((await post(`/portfolio/nothere.com/stats`, w, { as_of: '2027-08-09', views: 1, source: 'x' })).statusCode).toBe(404);
    // CR-051 B-2: an '@' in source is NO_PII and the message names the field
    const pii = await post(`/portfolio/${D}/stats`, w, { as_of: '2027-08-09', views: 1, source: 'a@b.com' });
    expect(pii.statusCode).toBe(422);
    expect(pii.json().error).toMatchObject({ code: 'NO_PII', details: { field: 'source' } });
    expect(pii.json().error.message).toMatch(/^source /);
    expect(await db.selectFrom('portfolio_stats').select('id').execute()).toHaveLength(0);
  });

  it('ST-3: the same Idempotency-Key replays the stored answer and stores one row', async () => {
    const { w } = await setup();
    const k = randomUUID();
    const a = await post(`/portfolio/${D}/stats`, w, { as_of: '2027-08-09', views: 5, source: 'x' }, k);
    const b = await post(`/portfolio/${D}/stats`, w, { as_of: '2027-08-09', views: 5, source: 'x' }, k);
    expect(b.json()).toEqual(a.json());
    expect(await db.selectFrom('portfolio_stats').select('id').execute()).toHaveLength(1);
  });
});

describe('renewal-time drop check (CR-045 item 1 and sell-before-drop follow-up)', () => {
  it('RD-1: 55 days before expiry and no signal: RENEWAL_DROP_SUGGESTED and SELL_BEFORE_DROP with expiry, list_by (expiry - 30 days) and the venues', async () => {
    const { r } = await setup();
    const drop = await warns(r, 'RENEWAL_DROP_SUGGESTED');
    expect(drop).toMatchObject([{ level: 'warn', domain: D, details: { expiry: '2027-10-04', days_to_expiry: 55, signals: { offers: 0, inquiries: 0, lookalike_rise: false } } }]);
    const sell = await warns(r, 'SELL_BEFORE_DROP');
    expect(sell).toMatchObject([{ domain: D, details: { expiry: '2027-10-04', list_by: '2027-09-04' } }]);
    expect(sell[0]!.details.venues.map((v: string) => v.split(':')[0])).toEqual(['afternic', 'sellerhub', 'namepros']);
  });

  it('RD-2: outside the window (more than renewal.drop_check_days = 60 days) nothing is raised; after a renewal nothing is raised', async () => {
    const { r } = await setup();
    clock.t = Date.parse('2027-07-01T09:00:00Z');
    expect(await warns(r, 'RENEWAL_DROP_SUGGESTED')).toHaveLength(0);
    expect(await warns(r, 'SELL_BEFORE_DROP')).toHaveLength(0);
    clock.t = Date.parse('2027-08-10T09:00:00Z');
    await db.updateTable('domains').set({ renewals_used: 1 }).where('domain', '=', D).execute();
    expect(await warns(r, 'RENEWAL_DROP_SUGGESTED')).toHaveLength(0);
  });

  it('RD-3: an inquiry (stats) is a signal: nothing is suggested', async () => {
    const { w, r } = await setup();
    await post(`/portfolio/${D}/stats`, w, { as_of: '2027-08-01', inquiries: 1, source: 'x' });
    expect(await warns(r, 'RENEWAL_DROP_SUGGESTED')).toHaveLength(0);
    expect(await warns(r, 'SELL_BEFORE_DROP')).toHaveLength(0);
  });

  it('RD-4: a logged offer is a signal', async () => {
    const { r } = await setup();
    const id = (await dom()).id;
    await db.insertInto('offers').values({ domain_id: id, amount_cents: 15000, source: 'afternic', received_at: new Date(clock.t - 86_400_000), band: 'mid_range', routing: 'dvir', outcome: 'open', recorded_by: 'gavriel' }).execute();
    expect(await warns(r, 'RENEWAL_DROP_SUGGESTED')).toHaveLength(0);
  });

  it('RD-5: a rise in lookalikes in use since the screening before the buy is a signal; no rise is not', async () => {
    const { r } = await setup();
    const ready = await readyToBuy(D);
    await db.insertInto('screening_results').values({
      run_id: ready.runId, item_idx: 0, domain: D, lane: 'S3', check_id: 'lookalikes', gate: 'G8', rule_ids: ['X'], status: 'PASS', reason_code: null, reason: null,
      fields: JSON.stringify({ lookalikes: { registered_n: 2, in_use_n: 1, unknown_n: 0, items: [] } }), checked_at: new Date('2027-01-01T00:00:00Z'), settings_label: 'v1', list_versions: '{}', duration_ms: 0, upstream_calls: 0, source: 'auto',
    }).execute();
    const id = (await dom()).id;
    await db.insertInto('portfolio_checks').values({ domain_id: id, kind: 'lookalikes', status: 'ok', details: JSON.stringify({ registered_n: 3, in_use_n: 1, unknown_n: 0 }) }).execute();
    expect(await warns(r, 'RENEWAL_DROP_SUGGESTED')).toHaveLength(1); // 1 -> 1: no rise
    await db.insertInto('portfolio_checks').values({ domain_id: id, kind: 'lookalikes', status: 'ok', details: JSON.stringify({ registered_n: 3, in_use_n: 2, unknown_n: 0 }) }).execute();
    expect(await warns(r, 'RENEWAL_DROP_SUGGESTED')).toHaveLength(0); // 1 -> 2: a rise
  });

  it('RD-6: a failing renewal maths ratio at renewal time suggests the drop even with a signal', async () => {
    const { w, r } = await setup({ bin_cents: 148800, renewal_price_cents: 5000, buy_card: JSON.stringify({ stre_bp: 100, stre_reason: 'x', renewal_math: { commission_bp: 2000 } }) as never });
    await post(`/portfolio/${D}/stats`, w, { as_of: '2027-08-01', inquiries: 1, source: 'x' });
    const d = await warns(r, 'RENEWAL_DROP_SUGGESTED');
    expect(d).toHaveLength(1);
    expect(d[0]!.details.renewal_math).toMatchObject({ pass: false, min: 1 });
  });

  it('RD-7: a name that drops at its first expiry gets SELL_BEFORE_DROP only', async () => {
    const { r } = await setup({ drop_date: '2027-10-04' });
    expect(await warns(r, 'RENEWAL_DROP_SUGGESTED')).toHaveLength(0);
    expect(await warns(r, 'SELL_BEFORE_DROP')).toHaveLength(1);
  });
});

describe('record-renewal (G-85)', () => {
  const NOW = new Date('2027-09-20T09:00:00Z');
  const ok = { domain: D, chargedCents: 1208, approvalText: `yes renew ${D}`, approvalAt: '2027-09-20T08:00:00Z', now: NOW };

  it('RN-1: books a renewal ledger row, renewals_used 1, the expiry one year on; the cap counts it', async () => {
    await setup();
    const r = await recordRenewal(db, ok);
    expect(r).toMatchObject({ expiryFrom: '2027-10-04', expiryTo: '2028-10-04', dropDate: '2028-10-04' });
    expect(await dom()).toMatchObject({ renewals_used: 1, expiry_date: '2028-10-04', drop_date: '2028-10-04' });
    expect(await db.selectFrom('ledger_entries').select(['type', 'amount_cents']).where('type', '=', 'renewal').execute()).toEqual([{ type: 'renewal', amount_cents: -1208 }]);
    expect(await db.selectFrom('audit_log').select('approval_text').where('path', '=', 'record-renewal').execute()).toEqual([{ approval_text: ok.approvalText }]);
  });

  it('RN-2: a second renewal is MAX_ONE_RENEWAL_USED; an approval that does not name the domain is APPROVAL_INVALID; a stale one APPROVAL_EXPIRED', async () => {
    await setup();
    await expect(recordRenewal(db, { ...ok, approvalText: 'yes renew it' })).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
    await expect(recordRenewal(db, { ...ok, approvalAt: '2027-09-10T08:00:00Z' })).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' });
    await recordRenewal(db, ok);
    await expect(recordRenewal(db, ok)).rejects.toMatchObject({ code: 'MAX_ONE_RENEWAL_USED' });
    expect(await db.selectFrom('ledger_entries').select('id').where('type', '=', 'renewal').execute()).toHaveLength(1);
  });

  it('RN-3: refused over the $1,500 POC cap (POC_CAP_EXCEEDED) and nothing is written', async () => {
    await setup();
    await db.insertInto('ledger_entries').values({ occurred_on: '2027-01-01', type: 'registration', amount_cents: -149900, domain_id: null }).execute();
    await expect(recordRenewal(db, ok)).rejects.toMatchObject({ code: 'POC_CAP_EXCEEDED' });
    expect(await dom()).toMatchObject({ renewals_used: 0, expiry_date: '2027-10-04' });
  });

  it('RN-4: a name whose drop_date is its first expiry is RENEWAL_NOT_PLANNED; a sold name is INVALID_STATE; an unknown one DOMAIN_NOT_FOUND', async () => {
    await setup({ drop_date: '2027-10-04' });
    await expect(recordRenewal(db, ok)).rejects.toMatchObject({ code: 'RENEWAL_NOT_PLANNED' });
    await db.updateTable('domains').set({ status: 'sold' }).where('domain', '=', D).execute();
    await expect(recordRenewal(db, ok)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(recordRenewal(db, { ...ok, domain: 'nothere.com', approvalText: 'yes renew nothere.com' })).rejects.toMatchObject({ code: 'DOMAIN_NOT_FOUND' });
  });

  it('RN-5: the quarterly report shows the renewal cost against sales', async () => {
    const { r } = await setup();
    await recordRenewal(db, { ...ok, now: new Date('2027-09-20T09:00:00Z') });
    const id = (await dom()).id;
    await db.insertInto('ledger_entries').values({ occurred_on: '2027-09-25', type: 'sale', amount_cents: 148800, domain_id: id }).execute();
    await db.insertInto('sales').values({ domain_id: id, sale_ledger_id: (await db.selectFrom('ledger_entries').select('id').where('type', '=', 'sale').executeTakeFirstOrThrow()).id, venue: 'afternic', sale_price_cents: 148800, commission_cents: 29760, sold_at: new Date('2027-09-25T10:00:00Z'), recorded_by: 'x', confirmed: true }).execute();
    const q = (await get('/portfolio/outcomes/quarterly', r)).json();
    expect(q.quarters).toContainEqual(expect.objectContaining({ quarter: '2027-Q3', renewals: 1, renewal_cost_cents: 1208, sales: 1, sales_total_cents: 148800, sales_minus_renewals_cents: 147592 }));
  });
});

describe('DELIST_NEEDED (CR-049 item 4)', () => {
  it('DL-1: a sold name is urgent until both hand venues are recorded as removed', async () => {
    const { w, r } = await setup({ status: 'sold', sold_at: new Date(clock.t - 3_600_000) });
    const a = await warns(r, 'DELIST_NEEDED');
    expect(a).toMatchObject([{ level: 'error', domain: D, details: { venues: ['afternic', 'sedo'], reason: 'sold' } }]);
    for (const venue of ['afternic', 'sedo']) {
      const res = await post(`/listings/${D}/venue`, w, { venue, listed_at: new Date(clock.t - 60_000).toISOString().replace('Z', '+00:00'), delisted: true });
      expect(res.statusCode, res.body).toBe(201);
      if (venue === 'afternic') expect((await warns(r, 'DELIST_NEEDED'))[0]!.details.venues).toEqual(['sedo']);
    }
    expect(await warns(r, 'DELIST_NEEDED')).toHaveLength(0);
  });

  it('DL-2: a listed name raises nothing', async () => {
    const { r } = await setup();
    expect(await warns(r, 'DELIST_NEEDED')).toHaveLength(0);
  });
});

describe('outcomes (CR-044 item 2, CR-045 item 3, CR-046 item 4, CR-049 item 5)', () => {
  async function seed() {
    const { w, r } = await setup({ buy_date: '2026-10-04', screening_group: 'passed', status: 'listed' });
    await insertOwnedDomain(db, { domain: 'secondname.com', status: 'listed', category: 'trend', price_grade: null, buy_date: '2026-10-04', screening_group: 'borderline' });
    await post(`/portfolio/${D}/stats`, w, { as_of: '2027-08-05', month: '2027-08', venue: 'afternic', views: 100, leads: 2, offers: 1, source: 'dash' });
    await post(`/portfolio/${D}/stats`, w, { as_of: '2027-08-05', month: '2027-08', venue: 'sellerhub', views: 40, source: 'dash' });
    await post(`/portfolio/secondname.com/stats`, w, { as_of: '2027-08-05', month: '2027-08', venue: 'afternic', views: 30, source: 'dash' });
    await post(`/portfolio/secondname.com/stats`, w, { as_of: '2027-02-05', month: '2027-02', venue: 'afternic', inquiries: 2, source: 'dash' });
    return { w, r };
  }

  it('OC-1: GET /portfolio/outcomes has one row per name with card, stats, days held and the group', async () => {
    const { r } = await seed();
    const res = await get('/portfolio/outcomes', r);
    expect(res.statusCode, res.body).toBe(200);
    const b = res.json();
    expect(b.judge_sales_after_months).toBe(24);
    const a = b.names.find((n: { domain: string }) => n.domain === D);
    expect(a).toMatchObject({ screening_group: 'passed', stats: { views: 140, leads: 2, offers: 1 }, stats_by_venue: { afternic: { views: 100 }, sellerhub: { views: 40 } }, interest: true, sale_judged: false });
    expect(a.days_held).toBeGreaterThan(300);
    const s = b.names.find((n: { domain: string }) => n.domain === 'secondname.com');
    expect(s).toMatchObject({ screening_group: 'borderline', inquiries_6m: 2, inquiries_12m: 2 });
  });

  it('OC-2: GET /portfolio/outcomes/monthly compares interest with none by feature, passed with borderline, and venue with venue', async () => {
    const { r } = await seed();
    clock.t = Date.parse('2027-11-01T09:00:00Z');
    const res = await get('/portfolio/outcomes/monthly?month=2027-08', r);
    expect(res.statusCode, res.body).toBe(200);
    const b = res.json();
    expect(b.month).toBe('2027-08');
    expect(b.passed_vs_borderline).toMatchObject([{ group: 'passed', names: 1, with_interest: 1, views: 140 }, { group: 'borderline', names: 1, with_interest: 0, views: 30, inquiries_6m: 2 }]);
    expect(b.by_venue).toMatchObject([{ venue: 'afternic', month: { views: 130, leads: 2, offers: 1 } }, { venue: 'sedo' }, { venue: 'sellerhub', month: { views: 40 } }]);
    const cat = b.by_feature.category.find((g: { value: string }) => g.value === 'trend');
    expect(cat).toMatchObject({ names: 2, with_interest: 1, without_interest: 1 });
    expect(b.venue_comparison_after_12_months).not.toBeNull();
    expect(b.per_name_and_venue.find((n: { domain: string }) => n.domain === D).venues.sellerhub.views).toBe(40);
    expect(JSON.stringify(b)).not.toMatch(/walkaway|floor/);
    expect((await get('/portfolio/outcomes/monthly?month=2027-13', r)).statusCode).toBe(422);
  });
});
