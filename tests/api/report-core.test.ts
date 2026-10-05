import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { addOneYear } from '../../src/dates.js';
import { offersByStrategy, perDomainOffers } from '../../src/services/offer-stats.js';
import { makeApp } from '../helpers/app.js';
import { insertOwnedDomain, testDb as db } from '../helpers/db.js';
import { FakeAdapter } from '../helpers/fake-adapter.js';
import { listedDomain } from '../helpers/listing.js';
import { issueToken } from '../helpers/tokens.js';

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((a) => a.close())); });

const NOW = Date.parse('2026-10-20T09:00:00Z'); // 12:00 IDT, 20 Oct 2026
async function boot(now = NOW) {
  const app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => now });
  apps.push(app);
  const read = (await issueToken('read')).auth;
  const get = async (auth: Record<string, string> = read) => app.inject({ method: 'GET', url: '/report', headers: auth });
  const report = async () => { const r = await get(); expect(r.statusCode, r.body).toBe(200); return r.json(); };
  return { app, get, report, read };
}
const ledger = (domain_id: number | null, type: 'registration' | 'renewal' | 'fee' | 'commission' | 'sale' | 'payout_fee', amount_cents: number, extra: { audit_id?: string; occurred_on?: string } = {}) =>
  db.insertInto('ledger_entries').values({ occurred_on: extra.occurred_on ?? '2026-10-04', domain_id, type, amount_cents, audit_id: extra.audit_id ?? null }).returning('id').executeTakeFirstOrThrow();
const cents = (m: { cents: number }) => m.cents;

async function sale(domainId: number, gross: number, commission: number, o: { confirmed?: boolean; other?: number; payoutFee?: number; ref: string; soldAt?: string }) {
  const audit = randomUUID();
  await db.insertInto('audit_log').values({ id: audit, token_name: 't', scope: 'write', method: 'POST', path: '/sold', status: 200 } as never).execute().catch(() => undefined);
  const s = await ledger(domainId, 'sale', gross, { audit_id: audit, occurred_on: '2026-10-12' });
  if (commission) await ledger(domainId, 'commission', -commission, { audit_id: audit, occurred_on: '2026-10-12' });
  if (o.other) await ledger(domainId, 'fee', -o.other, { audit_id: audit, occurred_on: '2026-10-12' });
  if (o.payoutFee) await ledger(domainId, 'payout_fee', -o.payoutFee, { audit_id: audit, occurred_on: '2026-10-12' });
  await db.insertInto('sales').values({
    domain_id: domainId, sale_ledger_id: s.id, venue: 'afternic', transaction_ref: o.ref, sale_price_cents: gross, commission_cents: commission,
    other_fees_cents: o.other ?? 0, sold_at: new Date(o.soldAt ?? '2026-10-12T09:00:00Z'), recorded_by: 'gavriel', confirmed: o.confirmed ?? true, audit_id: audit,
    evidence_source: 'other', evidence_ref: 'test-evidence',
    ...((o.confirmed ?? true) ? { approval_text: `yes ${domainId}`, approval_at: new Date('2026-10-11T09:00:00Z') } : {}),
  }).execute();
  await db.updateTable('domains').set({ status: 'sold', sold_at: new Date(o.soldAt ?? '2026-10-12T09:00:00Z') }).where('id', '=', domainId).execute();
  return s.id;
}

async function r1Fixture() {
  const a = await insertOwnedDomain(db, { domain: 'alpha-one.com' });
  const b = await insertOwnedDomain(db, { domain: 'beta-two.com', renewal_price_cents: null });
  await ledger(a, 'registration', -1108);
  await ledger(b, 'registration', -999);
  await sale(a, 199500, 29925, { ref: 'T1' });
}

describe('GET /report core: money', () => {
  it('R-1: fixture ledger gives the spec figures', async () => {
    await r1Fixture();
    const t = await boot();
    const r = await t.report();
    expect(r.budget.spent).toEqual({ cents: 2107, display: '$21.07' });
    expect(r.budget.remaining).toEqual({ cents: 147893, display: '$1,478.93' });
    expect(r.budget.poc_cap.display).toBe('$1,500.00');
    expect(r.budget.domains).toEqual({ count: 1, max: 50 });
    expect(r.sales.net).toEqual({ cents: 169575, display: '$1,695.75' });
    expect(r.sales.count).toBe(1);
    expect(r.profit).toEqual({ cents: 167468, display: '$1,674.68' });
    expect(r.roi).toBe(79.48);
    expect(r.roi_pct).toBe(7948);
    expect(r.warnings).toEqual([]);
  });

  it('roi is null when there are no costs', async () => {
    const t = await boot();
    const r = await t.report();
    expect(r.roi).toBeNull();
    expect(r.roi_pct).toBeNull();
    expect(r.profit.cents).toBe(0);
  });

  it('R-2 / S-7 / SL-5: mixed rows equal independent SQL sums; confirmed and unconfirmed both count; payouts add nothing', async () => {
    const a = await insertOwnedDomain(db, { domain: 'alpha-one.com' });
    const b = await insertOwnedDomain(db, { domain: 'beta-two.com' });
    const c = await insertOwnedDomain(db, { domain: 'gamma-three.com' });
    await ledger(a, 'registration', -1108);
    await ledger(b, 'registration', -999);
    await ledger(b, 'renewal', -1250);
    await ledger(c, 'fee', -300); // non-sale fee: a cost
    const s1 = await sale(a, 199500, 29925, { ref: 'T1', other: 500, payoutFee: 1500 });
    await sale(b, 50000, 7500, { ref: 'T2', confirmed: false });
    await db.insertInto('payouts').values({ domain_id: a, sale_ledger_id: s1, venue: 'afternic', amount_cents: 167075, fee_cents: 1500, method: 'wire' }).execute();
    const t = await boot();
    const before = await t.report();
    const sum = async (q: string) => Number((await sql.raw<{ v: string }>(q).execute(db)).rows[0]!.v);
    const gross = await sum(`select coalesce(sum(amount_cents),0) v from ledger_entries where type='sale'`);
    const commission = await sum(`select coalesce(-sum(amount_cents),0) v from ledger_entries where type='commission'`);
    const saleFees = await sum(`select coalesce(-sum(amount_cents),0) v from ledger_entries l where type='payout_fee' or (type='fee' and exists (select 1 from sales s where s.audit_id = l.audit_id))`);
    const costs = await sum(`select coalesce(-sum(amount_cents),0) v from ledger_entries l where type in ('registration','renewal') or (type='fee' and not exists (select 1 from sales s where s.audit_id = l.audit_id))`);
    const spent = await sum(`select coalesce(-sum(amount_cents),0) v from ledger_entries where type in ('registration','renewal','fee')`);
    expect(costs).toBe(1108 + 999 + 1250 + 300);
    expect(saleFees).toBe(2000);
    expect(cents(before.sales.gross)).toBe(gross);
    expect(cents(before.sales.commission)).toBe(commission);
    expect(cents(before.sales.fees)).toBe(saleFees);
    expect(cents(before.sales.net)).toBe(gross - commission - saleFees);
    expect(before.sales.count).toBe(2);
    expect(cents(before.profit)).toBe(gross - commission - saleFees - costs);
    expect(before.roi_pct).toBe(Math.round(((gross - commission - saleFees - costs) * 100) / costs));
    expect(cents(before.budget.spent)).toBe(spent);
    expect(cents(before.budget.remaining)).toBe(150000 - spent);
    // a payout row (and marking it received) changes nothing
    await db.updateTable('payouts').set({ received_on: '2026-10-15' }).execute();
    const after = await t.report();
    expect(after.sales).toEqual(before.sales);
    expect(after.profit).toEqual(before.profit);
    expect(after.roi).toEqual(before.roi);
  });
});

describe('GET /report core: committed_forward, upcoming', () => {
  it('R-3: only renewals_used=0 and not sold count; null price makes it incomplete', async () => {
    await insertOwnedDomain(db, { domain: 'zero-used.com', renewals_used: 0, renewal_price_cents: 1250 });
    await insertOwnedDomain(db, { domain: 'one-used.com', renewals_used: 1, renewal_price_cents: 1300 });
    const s = await insertOwnedDomain(db, { domain: 'sold-one.com', renewals_used: 0, renewal_price_cents: 1400 });
    await db.updateTable('domains').set({ status: 'sold' }).where('id', '=', s).execute();
    const t = await boot();
    let r = await t.report();
    expect(r.budget.committed_forward).toEqual({ total: { cents: 1250, display: '$12.50' }, complete: true, missing: [] });
    await insertOwnedDomain(db, { domain: 'unknown-price.com', renewals_used: 0, renewal_price_cents: null });
    r = await t.report();
    expect(r.budget.committed_forward.complete).toBe(false);
    expect(r.budget.committed_forward.missing).toEqual(['unknown-price.com']);
    expect(r.budget.committed_forward.total.cents).toBe(1250);
  });

  it('R-4 / R-5 / R-6: first renewal stage 60, final expiry stage 30 with no renew option, fast transfer buy_date+60', async () => {
    // today (IDT) = 2026-10-20
    await insertOwnedDomain(db, { domain: 'first.com', expiry_date: '2026-12-04', renewals_used: 0, buy_date: '2026-08-26', drop_date: addOneYear('2026-12-04') }); // 45 days; FT 2026-10-25
    await insertOwnedDomain(db, { domain: 'final.com', expiry_date: '2026-11-14', renewals_used: 1, buy_date: '2025-01-01', drop_date: addOneYear('2026-11-14') }); // 25 days
    const t = await boot();
    const u = (await t.report()).upcoming_90d as { domain: string; kind: string; date: string; stage?: number; note: string }[];
    const first = u.find((e) => e.domain === 'first.com' && e.kind === 'first_renewal')!;
    expect(first).toMatchObject({ date: '2026-12-04', stage: 60 });
    const fin = u.find((e) => e.domain === 'final.com' && e.kind === 'final_expiry')!;
    expect(fin).toMatchObject({ date: '2026-11-14', stage: 30 });
    expect(fin.note).not.toMatch(/renew/i);
    expect(fin.note).toMatch(/outreach/);
    expect(u.find((e) => e.domain === 'final.com' && e.kind === 'first_renewal')).toBeUndefined();
    expect(u.find((e) => e.domain === 'first.com' && e.kind === 'fast_transfer')).toMatchObject({ date: '2026-10-25' });
    expect(u.map((e) => e.date)).toEqual([...u.map((e) => e.date)].sort());
  });

  it('stage boundaries: 7 days -> 7, 30 -> 30, 31 -> 60, 61 days -> none', async () => {
    await insertOwnedDomain(db, { domain: 'd07.com', expiry_date: '2026-10-27', buy_date: '2025-01-01', drop_date: addOneYear('2026-10-27') });
    await insertOwnedDomain(db, { domain: 'd30.com', expiry_date: '2026-11-19', buy_date: '2025-01-01', drop_date: addOneYear('2026-11-19') });
    await insertOwnedDomain(db, { domain: 'd31.com', expiry_date: '2026-11-20', buy_date: '2025-01-01', drop_date: addOneYear('2026-11-20') });
    await insertOwnedDomain(db, { domain: 'd61.com', expiry_date: '2026-12-20', buy_date: '2025-01-01', drop_date: addOneYear('2026-12-20') });
    const t = await boot();
    const u = (await t.report()).upcoming_90d as { domain: string; kind: string; stage?: number }[];
    const st = (d: string) => u.find((e) => e.domain === d && e.kind === 'first_renewal')?.stage;
    expect([st('d07.com'), st('d30.com'), st('d31.com'), st('d61.com')]).toEqual([7, 30, 60, undefined]);
  });

  it('PR-38: event due in 5 days is in upcoming with exact values and headsup; one applied 2 days ago is in applied_7d with old -> new', async () => {
    const id = await listedDomain({ domain: 'plan-one.com', plan_id: 'plan-A' });
    await db.insertInto('price_schedule').values({
      domain_id: id, plan_id: 'plan-A', event: 'drop1_m6', due_on: '2026-10-25', bin_cents: 159500, floor_cents: 129500, walkaway_cents: 96000, settings_version: 2, status: 'planned',
    }).execute();
    await db.insertInto('price_schedule').values({
      domain_id: id, plan_id: 'plan-A', event: 'drop2_m18', due_on: '2026-12-30', bin_cents: 129500, floor_cents: 129500, walkaway_cents: 96000, settings_version: 2, status: 'planned',
    }).execute();
    const h1 = await db.insertInto('listing_history').values({ domain_id: id, at: new Date('2026-10-12T09:00:00Z'), source: 'list', bin_cents: 199500, floor_cents: 129500, walkaway_cents: 96000 }).returning('id').executeTakeFirstOrThrow();
    void h1;
    const h2 = await db.insertInto('listing_history').values({ domain_id: id, at: new Date('2026-10-18T05:00:00Z'), source: 'schedule', bin_cents: 159500, floor_cents: 129500, walkaway_cents: 96000 }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('price_schedule').values({
      domain_id: id, plan_id: 'plan-A', event: 'drop1_m6', due_on: '2026-10-18', bin_cents: 159500, floor_cents: 129500, walkaway_cents: 96000, settings_version: 2,
      status: 'applied', applied_at: new Date('2026-10-18T05:00:00Z'), listing_history_id: h2.id,
    }).execute().catch(async () => {
      // one live row per (domain, event) may be enforced: use a different event for the applied row
      await db.insertInto('price_schedule').values({
        domain_id: id, plan_id: 'plan-A', event: 'geo_drop_m12', due_on: '2026-10-18', bin_cents: 159500, floor_cents: 129500, walkaway_cents: 96000, settings_version: 2,
        status: 'applied', applied_at: new Date('2026-10-18T05:00:00Z'), listing_history_id: h2.id,
      }).execute();
    });
    const t = await boot();
    const r = await t.report();
    const ev = r.upcoming_90d.find((e: { kind: string }) => e.kind === 'price_event');
    expect(ev).toMatchObject({ domain: 'plan-one.com', date: '2026-10-25', headsup: true });
    expect(ev.values).toEqual({
      bin: { cents: 159500, display: '$1,595.00' }, floor: { cents: 129500, display: '$1,295.00' }, walkaway: { cents: 96000, display: '$960.00' },
    });
    const later = r.upcoming_90d.filter((e: { kind: string }) => e.kind === 'price_event');
    expect(later.find((e: { date: string }) => e.date === '2026-12-30').headsup).toBe(false);
    expect(r.per_domain[0].next_price_event).toMatchObject({ event: 'drop1_m6', due_on: '2026-10-25', bin: { cents: 159500, display: '$1,595.00' } });
    expect(r.applied_7d).toHaveLength(1);
    expect(r.applied_7d[0]).toMatchObject({
      domain: 'plan-one.com', applied_at: '2026-10-18T08:00:00+03:00', export_pending: false,
      old: { bin: { cents: 199500 } }, new: { bin: { cents: 159500 } },
    });
  });

  it('applied_7d excludes events older than 7 days', async () => {
    const id = await listedDomain({ domain: 'old-event.com', plan_id: 'plan-B' });
    await db.insertInto('price_schedule').values({
      domain_id: id, plan_id: 'plan-B', event: 'drop1_m6', due_on: '2026-10-10', bin_cents: 159500, floor_cents: 129500, walkaway_cents: 96000, settings_version: 2,
      status: 'applied', applied_at: new Date('2026-10-10T05:00:00Z'),
    }).execute();
    const t = await boot();
    expect((await t.report()).applied_7d).toEqual([]);
  });
});

describe('GET /report core: per-domain, payouts, timezone, offers, auth', () => {
  it('per_domain: excludes pending_purchase, sorted, cost/days_held/ns_verified/walk-away marked private', async () => {
    const id = await listedDomain({ domain: 'zeta.com', ns_verified_at: new Date('2026-10-05T00:00:00Z'), lander: 'afternic', buy_date: '2026-10-04' });
    await insertOwnedDomain(db, { domain: 'alpha.com', status: 'pending_purchase' });
    await insertOwnedDomain(db, { domain: 'beta.com' });
    await ledger(id, 'registration', -1373);
    const t = await boot();
    const r = await t.report();
    expect(r.per_domain.map((d: { domain: string }) => d.domain)).toEqual(['beta.com', 'zeta.com']);
    const z = r.per_domain[1];
    expect(z).toMatchObject({
      status: 'listed', category: 'trend', listing_mode: 'hybrid', ns_verified: true, lander: 'afternic', days_held: 16, renewals_used: 0,
      cost: { cents: 1373, display: '$13.73' }, bin: { cents: 199500 }, min_offer: { cents: 10000 }, pricing_settings_version: 2,
    });
    expect(z.walkaway).toEqual({ cents: 96000, display: '$960.00 (private)' });
    expect(r.budget.domains.count).toBe(3); // activeDomainCount includes pending_purchase
  });

  it('PO-5 (list): pending payouts 10 and 31 days old are listed; profit unchanged', async () => {
    const a = await insertOwnedDomain(db, { domain: 'pay-a.com' });
    const b = await insertOwnedDomain(db, { domain: 'pay-b.com' });
    await ledger(a, 'registration', -1000);
    const sa = await sale(a, 100000, 0, { ref: 'A', soldAt: '2026-10-10T09:00:00Z' });
    const sb = await sale(b, 100000, 0, { ref: 'B', soldAt: '2026-09-19T09:00:00Z' });
    const t = await boot();
    const before = await t.report();
    expect(before.payouts_pending).toEqual([]);
    await db.insertInto('payouts').values({ domain_id: a, sale_ledger_id: sa, venue: 'afternic', amount_cents: 100000, method: 'wire' }).execute();
    await db.insertInto('payouts').values({ domain_id: b, sale_ledger_id: sb, venue: 'afternic', amount_cents: 100000, fee_cents: 1500, method: 'paypal' }).execute();
    const after = await t.report();
    expect(after.payouts_pending.map((p: { domain: string; days_pending: number }) => [p.domain, p.days_pending])).toEqual([['pay-b.com', 31], ['pay-a.com', 10]]);
    expect(after.payouts_pending[0]).toMatchObject({ venue: 'afternic', amount: { cents: 100000 }, fee: { cents: 1500, display: '$15.00' }, method: 'paypal', sold_at: '2026-09-19T12:00:00+03:00' });
    expect(after.profit).toEqual(before.profit);
    expect(after.sales).toEqual(before.sales);
  });

  it('R-10: sold_at is +03:00 in summer and +02:00 in winter', async () => {
    const a = await insertOwnedDomain(db, { domain: 'summer.com' });
    const b = await insertOwnedDomain(db, { domain: 'winter.com' });
    await sale(a, 100000, 0, { ref: 'S', soldAt: '2026-07-01T09:00:00Z' });
    await sale(b, 100000, 0, { ref: 'W', soldAt: '2026-12-01T09:00:00Z' });
    const t = await boot();
    const r = await t.report();
    const by = (d: string) => r.per_domain.find((x: { domain: string }) => x.domain === d);
    expect(by('summer.com').sold_at).toBe('2026-07-01T12:00:00+03:00');
    expect(by('winter.com').sold_at).toBe('2026-12-01T11:00:00+02:00');
    expect(r.generated_at).toBe('2026-10-20T12:00:00+03:00');
  });

  it('OF-18 / OF-19 wiring: per_domain.offers and offers_by_strategy equal the service outputs', async () => {
    const id = await listedDomain({ domain: 'offered.com' });
    await listedDomain({ domain: 'quiet.com' });
    for (const [amt, at] of [[45000, '2026-10-15T09:00:00Z'], [100000, '2026-08-01T09:00:00Z']] as const) {
      await db.insertInto('offers').values({
        domain_id: id, amount_cents: amt, source: 'afternic', received_at: new Date(at), recorded_by: 'gavriel', band: 'mid_range', routing: 'dvir', outcome: 'open', bin_cents_at: 199500,
      } as never).execute();
    }
    const t = await boot();
    const r = await t.report();
    const m = await perDomainOffers(db, new Date(NOW));
    const idq = (await db.selectFrom('domains').select('id').where('domain', '=', 'quiet.com').executeTakeFirstOrThrow()).id;
    expect(r.per_domain.find((d: { domain: string }) => d.domain === 'offered.com').offers).toEqual(m.get(id));
    expect(r.per_domain.find((d: { domain: string }) => d.domain === 'quiet.com').offers).toEqual(m.get(idq));
    expect(r.per_domain.find((d: { domain: string }) => d.domain === 'offered.com').offers.count_all).toBe(2);
    expect(r.offers_by_strategy).toEqual(await offersByStrategy(db, new Date(NOW)));
  });

  it('auth: READ token 200, no token 401', async () => {
    const t = await boot();
    expect((await t.get()).statusCode).toBe(200);
    expect((await t.get({})).statusCode).toBe(401);
  });
});
