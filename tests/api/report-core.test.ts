import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type { LedgerType } from '../../src/db/types.js';
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
const ledger = (domain_id: number | null, type: LedgerType, amount_cents: number, extra: { audit_id?: string; occurred_on?: string } = {}) =>
  db.insertInto('ledger_entries').values({ occurred_on: extra.occurred_on ?? '2026-10-04', domain_id, type, amount_cents, audit_id: extra.audit_id ?? null }).returning('id').executeTakeFirstOrThrow();
const AUDIT_ROW = { scope: 'write', method: 'POST', path: '/sold', status_code: 200 } as const;

async function sale(domainId: number, gross: number, commission: number, o: { confirmed?: boolean; other?: number; payoutFee?: number; linkedAdjustment?: number; ref: string; soldAt?: string }) {
  const audit = `aud_${randomUUID().replaceAll('-', '')}`;
  await db.insertInto('audit_log').values({ id: audit, ...AUDIT_ROW }).execute();
  const s = await ledger(domainId, 'sale', gross, { audit_id: audit, occurred_on: '2026-10-12' });
  if (commission) await ledger(domainId, 'commission', -commission, { audit_id: audit, occurred_on: '2026-10-12' });
  if (o.other) await ledger(domainId, 'fee', -o.other, { audit_id: audit, occurred_on: '2026-10-12' });
  if (o.linkedAdjustment) await ledger(domainId, 'adjustment', -o.linkedAdjustment, { audit_id: audit, occurred_on: '2026-10-12' });
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
    expect(r.budget).toMatchObject({ spent_cents: 2107, spent: '$21.07', remaining_cents: 147893, remaining: '$1,478.93', poc_cap_cents: 150000, poc_cap: '$1,500.00' });
    expect(r.budget.domains).toEqual({ count: 1, max: 50 });
    expect(r.sales).toMatchObject({ count: 1, net_cents: 169575, net: '$1,695.75', gross_cents: 199500, gross: '$1,995.00', commission_cents: 29925, fees_cents: 0, fees: '$0.00' });
    expect(r).toMatchObject({ profit_cents: 167468, profit: '$1,674.68', roi: 79.48, roi_pct: 7948 });
    expect(r.warnings).toEqual([]);
    expect(JSON.stringify(r.budget)).not.toContain('"cents"'); // flat pairs only
  });

  it('roi is null when there are no costs', async () => {
    const t = await boot();
    const r = await t.report();
    expect(r.roi).toBeNull();
    expect(r.roi_pct).toBeNull();
    expect(r.profit_cents).toBe(0);
  });

  it('R-2 / S-7 / SL-5 / Q12: every ledger type; money equals independent SQL sums; confirmed and unconfirmed count; payouts add nothing', async () => {
    const a = await insertOwnedDomain(db, { domain: 'alpha-one.com' });
    const b = await insertOwnedDomain(db, { domain: 'beta-two.com' });
    const c = await insertOwnedDomain(db, { domain: 'gamma-three.com' });
    await ledger(a, 'registration', -1108);
    await ledger(b, 'registration', -999);
    await ledger(b, 'renewal', -1250);
    await ledger(c, 'fee', -300); // non-sale fee: a cost
    await ledger(c, 'refund', 400); // lowers costs
    await ledger(c, 'tool', -200);
    await ledger(c, 'ai', -150);
    await ledger(c, 'adjustment', -75); // non-sale adjustment: a cost
    const s1 = await sale(a, 199500, 29925, { ref: 'T1', other: 500, payoutFee: 1500, linkedAdjustment: 100 });
    await sale(b, 50000, 7500, { ref: 'T2', confirmed: false });
    await db.insertInto('payouts').values({ domain_id: a, sale_ledger_id: s1, venue: 'afternic', amount_cents: 167075, fee_cents: 1500, method: 'wire' }).execute();
    const t = await boot();
    const before = await t.report();
    const sum = async (q: string) => Number((await sql.raw<{ v: string }>(q).execute(db)).rows[0]!.v);
    const linked = `exists (select 1 from sales s where s.audit_id = l.audit_id)`;
    const gross = await sum(`select coalesce(sum(amount_cents),0) v from ledger_entries where type='sale'`);
    const commission = await sum(`select coalesce(-sum(amount_cents),0) v from ledger_entries where type='commission'`);
    const saleFees = await sum(`select coalesce(-sum(amount_cents),0) v from ledger_entries l where type='payout_fee' or (type in ('fee','adjustment') and ${linked})`);
    const costs = await sum(`select coalesce(-sum(amount_cents),0) v from ledger_entries l where type in ('registration','renewal','refund','tool','ai') or (type in ('fee','adjustment') and not ${linked})`);
    const spent = await sum(`select coalesce(-sum(amount_cents),0) v from ledger_entries where type in ('registration','renewal','fee')`);
    expect(costs).toBe(1108 + 999 + 1250 + 300 - 400 + 200 + 150 + 75);
    expect(saleFees).toBe(500 + 1500 + 100);
    expect(before.sales).toMatchObject({ count: 2, gross_cents: gross, commission_cents: commission, fees_cents: saleFees, net_cents: gross - commission - saleFees });
    expect(before.profit_cents).toBe(gross - commission - saleFees - costs);
    expect(before.roi_pct).toBe(Math.round(((gross - commission - saleFees - costs) * 100) / costs));
    expect(before.budget.spent_cents).toBe(spent); // the cap figure: registration + renewal + fee rows
    expect(before.budget.remaining_cents).toBe(150000 - spent);
    expect(before.per_domain.find((d: { domain: string }) => d.domain === 'beta-two.com').cost_cents).toBe(
      await sum(`select -sum(amount_cents) v from ledger_entries where type in ('registration','renewal') and domain_id = ${b}`));
    // a payout row (and marking it received) changes nothing
    await db.updateTable('payouts').set({ received_on: '2026-10-15' }).execute();
    const after = await t.report();
    expect(after.sales).toEqual(before.sales);
    expect(after.profit_cents).toEqual(before.profit_cents);
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
    expect(r.budget.committed_forward).toEqual({ total_cents: 1250, total: '$12.50', complete: true, missing: [] });
    await insertOwnedDomain(db, { domain: 'unknown-price.com', renewals_used: 0, renewal_price_cents: null });
    r = await t.report();
    expect(r.budget.committed_forward.complete).toBe(false);
    expect(r.budget.committed_forward.missing).toEqual(['unknown-price.com']);
    expect(r.budget.committed_forward.total_cents).toBe(1250);
  });

  it('R-4 / R-5 / R-6: first renewal stage 60, final expiry stage 30 with no renew option, fast transfer buy_date+60', async () => {
    // today (IDT) = 2026-10-20
    await insertOwnedDomain(db, { domain: 'first.com', expiry_date: '2026-12-04', renewals_used: 0, buy_date: '2026-08-26', drop_date: addOneYear('2026-12-04') }); // 45 days; FT 2026-10-25
    await insertOwnedDomain(db, { domain: 'final.com', expiry_date: '2026-11-14', renewals_used: 1, buy_date: '2025-01-01', drop_date: addOneYear('2026-11-14') }); // 25 days
    const t = await boot();
    const u = (await t.report()).upcoming_90d as { domain: string; kind: string; date: string; stage?: number; note: string }[];
    expect(u.find((e) => e.domain === 'first.com' && e.kind === 'first_renewal')).toMatchObject({ date: '2026-12-04', stage: 60 });
    const fin = u.find((e) => e.domain === 'final.com' && e.kind === 'final_expiry')!;
    expect(fin).toMatchObject({ date: '2026-11-14', stage: 30 });
    expect(fin.note).toBe("Final expiry: won't be renewed again; the final push price is already scheduled at 2027-08-16; consider an outreach push (Gate C).");
    // no renew option or action: no first_renewal entry for it, and no action key
    expect(u.find((e) => e.domain === 'final.com' && e.kind === 'first_renewal')).toBeUndefined();
    expect(Object.keys(fin).filter((k) => /renew|action/i.test(k))).toEqual([]);
    expect(u.find((e) => e.domain === 'first.com' && e.kind === 'fast_transfer')).toMatchObject({ date: '2026-10-25' });
    expect(u.map((e) => e.date)).toEqual([...u.map((e) => e.date)].sort());
  });

  it('Gate F (drop_date = expiry_date, renewals_used 0): final_expiry, no first_renewal, no duplicate drop_date entry', async () => {
    await insertOwnedDomain(db, { domain: 'gatef.com', expiry_date: '2026-11-14', renewals_used: 0, buy_date: '2025-01-01', drop_date: '2026-11-14' });
    const t = await boot();
    const u = (await t.report()).upcoming_90d as { domain: string; kind: string }[];
    expect(u.filter((e) => e.domain === 'gatef.com' && e.kind !== 'fast_transfer').map((e) => e.kind)).toEqual(['final_expiry']);
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

  it('IDT day boundary: 21:30Z is already the next IDT day for day counts', async () => {
    await insertOwnedDomain(db, { domain: 'edge.com', expiry_date: '2026-11-19', buy_date: '2025-01-01', drop_date: addOneYear('2026-11-19') });
    // 2026-10-20T21:30Z = 2026-10-21 00:30 IDT: 29 days left -> stage 30 (still 30); the day before it is 30 days
    const t = await boot(Date.parse('2026-10-20T21:30:00Z'));
    const r = await t.report();
    expect(r.generated_at).toBe('2026-10-21T00:30:00+03:00');
    expect(r.per_domain[0].days_held).toBe(Math.floor((Date.parse('2026-10-21') - Date.parse('2025-01-01')) / 86_400_000));
    const t2 = await boot(Date.parse('2026-10-20T20:30:00Z')); // 23:30 IDT on the 20th
    expect((await t2.report()).per_domain[0].days_held).toBe(Math.floor((Date.parse('2026-10-20') - Date.parse('2025-01-01')) / 86_400_000));
  });

  const sched = (domain_id: number, plan_id: string, event: 'drop1_m6' | 'drop2_m18' | 'geo_drop_m12', due_on: string, bin: number, extra: Record<string, unknown> = {}) =>
    db.insertInto('price_schedule').values({ domain_id, plan_id, event, due_on, bin_cents: bin, floor_cents: 129500, walkaway_cents: 96000, settings_version: 2, status: 'planned', ...extra } as never).execute();

  it('PR-38: event due in 5 days is in upcoming with exact values and headsup; one applied 2 days ago is in applied_7d with old -> new', async () => {
    const id = await listedDomain({ domain: 'plan-one.com', plan_id: 'plan-A' });
    await sched(id, 'plan-A', 'drop1_m6', '2026-10-25', 159500);
    await sched(id, 'plan-A', 'drop2_m18', '2026-12-30', 129500);
    await db.insertInto('listing_history').values({ domain_id: id, at: new Date('2026-10-12T09:00:00Z'), source: 'list', bin_cents: 199500, floor_cents: 129500, walkaway_cents: 96000 }).execute();
    const h2 = await db.insertInto('listing_history').values({ domain_id: id, at: new Date('2026-10-18T05:00:00Z'), source: 'schedule', bin_cents: 159500, floor_cents: 129500, walkaway_cents: 96000 }).returning('id').executeTakeFirstOrThrow();
    // a different event name than the planned drop1_m6 row, so the unique (domain, event) key is never hit
    await sched(id, 'plan-A', 'geo_drop_m12', '2026-10-18', 159500, { status: 'applied', applied_at: new Date('2026-10-18T05:00:00Z'), listing_history_id: h2.id });
    const t = await boot();
    const r = await t.report();
    const events = r.upcoming_90d.filter((e: { kind: string }) => e.kind === 'price_event');
    expect(events.find((e: { event: string }) => e.event === 'drop1_m6')).toMatchObject({
      domain: 'plan-one.com', date: '2026-10-25', headsup: true,
      values: { bin_cents: 159500, bin: '$1,595.00', floor_cents: 129500, floor: '$1,295.00', walkaway_cents: 96000, walkaway: '$960 (private)' },
    });
    expect(events.find((e: { date: string }) => e.date === '2026-12-30').headsup).toBe(false);
    expect(events).toHaveLength(2); // the applied row is not upcoming
    expect(r.per_domain[0].next_price_event).toMatchObject({ event: 'drop1_m6', due_on: '2026-10-25', bin_cents: 159500, bin: '$1,595.00', walkaway: '$960 (private)' });
    expect(r.applied_7d).toHaveLength(1);
    expect(r.applied_7d[0]).toMatchObject({
      domain: 'plan-one.com', event: 'geo_drop_m12', applied_at: '2026-10-18T08:00:00+03:00', export_pending: false,
      old: { bin_cents: 199500, bin: '$1,995.00' }, new: { bin_cents: 159500, bin: '$1,595.00', floor_cents: 129500, walkaway_cents: 96000 },
    });
  });

  it('upcoming excludes overdue price events (due_on before today)', async () => {
    const id = await listedDomain({ domain: 'overdue.com', plan_id: 'plan-O' });
    await sched(id, 'plan-O', 'drop1_m6', '2026-10-19', 159500);
    await sched(id, 'plan-O', 'drop2_m18', '2026-10-20', 129500); // due today: still shown
    const t = await boot();
    const ev = (await t.report()).upcoming_90d.filter((e: { kind: string }) => e.kind === 'price_event');
    expect(ev.map((e: { event: string }) => e.event)).toEqual(['drop2_m18']);
  });

  it('applied_7d: export_pending true for a domain whose change no confirmed upload recorded', async () => {
    const id = await listedDomain({ domain: 'pending-exp.com', plan_id: 'plan-P', listing_changed_at: new Date('2026-10-18T05:00:00Z'), export_pending_since: new Date('2026-10-18T05:00:00Z') });
    const h = await db.insertInto('listing_history').values({ domain_id: id, at: new Date('2026-10-18T05:00:00Z'), source: 'schedule', bin_cents: 159500, floor_cents: 129500, walkaway_cents: 96000 }).returning('id').executeTakeFirstOrThrow();
    await sched(id, 'plan-P', 'drop1_m6', '2026-10-18', 159500, { status: 'applied', applied_at: new Date('2026-10-18T05:00:00Z'), listing_history_id: h.id });
    const t = await boot();
    const r = await t.report();
    expect(r.applied_7d).toHaveLength(1);
    expect(r.applied_7d[0].export_pending).toBe(true);
    expect(r.per_domain[0].export_pending_since).toBe('2026-10-18T08:00:00+03:00');
  });

  it('applied_7d: an applied event with no listing_history_id uses the schedule values and a null old', async () => {
    const id = await listedDomain({ domain: 'nohist.com', plan_id: 'plan-N' });
    await sched(id, 'plan-N', 'drop1_m6', '2026-10-18', 159500, { status: 'applied', applied_at: new Date('2026-10-18T05:00:00Z') });
    const t = await boot();
    const a = (await t.report()).applied_7d[0];
    expect(a.old).toEqual({ bin_cents: null, bin: null, floor_cents: null, floor: null, walkaway_cents: null, walkaway: null });
    expect(a.new).toMatchObject({ bin_cents: 159500, floor_cents: 129500, walkaway_cents: 96000 });
  });

  it('applied_7d excludes events older than 7 days', async () => {
    const id = await listedDomain({ domain: 'old-event.com', plan_id: 'plan-B' });
    await sched(id, 'plan-B', 'drop1_m6', '2026-10-10', 159500, { status: 'applied', applied_at: new Date('2026-10-10T05:00:00Z') });
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
      cost_cents: 1373, cost: '$13.73', bin_cents: 199500, bin: '$1,995.00', min_offer_cents: 10000, min_offer: '$100.00', pricing_settings_version: 2,
      walkaway_cents: 96000, walkaway: '$960 (private)',
    });
    expect(r.budget.domains.count).toBe(3); // activeDomainCount includes pending_purchase
  });

  it('days_held stops at sold_at for a sold domain and at drop_date for a dropped one', async () => {
    await insertOwnedDomain(db, { domain: 'sold-held.com', buy_date: '2026-09-01' });
    await db.updateTable('domains').set({ status: 'sold', sold_at: new Date('2026-09-11T09:00:00Z') }).where('domain', '=', 'sold-held.com').execute();
    await insertOwnedDomain(db, { domain: 'dropped-held.com', buy_date: '2025-01-01', expiry_date: '2026-01-01', drop_date: '2027-01-01', status: 'dropped' });
    const t = await boot();
    const by = (r: { per_domain: { domain: string; days_held: number }[] }, d: string) => r.per_domain.find((x) => x.domain === d)!.days_held;
    const r = await t.report();
    expect(by(r, 'sold-held.com')).toBe(10);
    expect(by(r, 'dropped-held.com')).toBe(Math.floor((Date.parse('2027-01-01') - Date.parse('2025-01-01')) / 86_400_000));
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
    expect(after.payouts_pending[0]).toMatchObject({ venue: 'afternic', amount_cents: 100000, amount: '$1,000.00', fee_cents: 1500, fee: '$15.00', method: 'paypal', sold_at: '2026-09-19T12:00:00+03:00' });
    expect(after.profit_cents).toEqual(before.profit_cents);
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
