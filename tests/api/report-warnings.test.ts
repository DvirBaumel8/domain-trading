import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../helpers/app.js';
import { insertOwnedDomain, testDb as db } from '../helpers/db.js';
import { FakeAdapter } from '../helpers/fake-adapter.js';
import { listedDomain } from '../helpers/listing.js';
import { issueToken } from '../helpers/tokens.js';

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((a) => a.close())); });

const NOW = Date.parse('2026-10-20T09:00:00Z'); // 12:00 IDT, 20 Oct 2026
const DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW - ms);
async function boot() {
  const app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => NOW });
  apps.push(app);
  const read = (await issueToken('read')).auth;
  const warnings = async () => {
    const r = await app.inject({ method: 'GET', url: '/report', headers: read });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().warnings as { code: string; level: string; domain?: string; message: string; details: Record<string, any> }[];
  };
  const get = (url: string) => app.inject({ method: 'GET', url, headers: read });
  return { warnings, get };
}
const codes = (w: { code: string }[]) => w.map((x) => x.code);

async function saleFor(domainId: number, o: { confirmed?: boolean; ref: string; soldAt: Date }) {
  const s = await db.insertInto('ledger_entries').values({ occurred_on: '2026-10-12', domain_id: domainId, type: 'sale', amount_cents: 199500 }).returning('id').executeTakeFirstOrThrow();
  await db.insertInto('sales').values({
    domain_id: domainId, sale_ledger_id: s.id, venue: 'afternic', transaction_ref: o.ref, sale_price_cents: 199500, commission_cents: 0,
    sold_at: o.soldAt, recorded_by: 'gavriel', confirmed: o.confirmed ?? true, evidence_source: 'afternic_email', evidence_ref: `ev-${o.ref}`,
  }).execute();
  await db.updateTable('domains').set({ status: 'sold', sold_at: o.soldAt }).where('id', '=', domainId).execute();
  return s.id;
}
const payout = (domainId: number, saleLedgerId: number) =>
  db.insertInto('payouts').values({ domain_id: domainId, sale_ledger_id: saleLedgerId, venue: 'afternic', amount_cents: 169575, method: 'wire' }).execute();

describe('GET /report warnings', () => {
  it('a clean fixture has none of the warnings', async () => {
    await insertOwnedDomain(db, { domain: 'clean-one.com' });
    await insertOwnedDomain(db, { domain: 'clean-geo.com', status: 'listed', category: 'geo', price_grade: 'weaker', listing_mode: 'bin', bin_cents: 39900, floor_cents: 39900, walkaway_cents: 39900, min_offer_cents: 39900, pricing_source: 'formula', pricing_settings_version: 2 });
    const t = await boot();
    expect(await t.warnings()).toEqual([]);
  });

  it('SL-5: SALE_UNCONFIRMED lists only the unconfirmed sale, as info, with its evidence', async () => {
    const a = await insertOwnedDomain(db, { domain: 'alpha-one.com' });
    const b = await insertOwnedDomain(db, { domain: 'beta-two.com' });
    await saleFor(a, { ref: 'A1', soldAt: ago(5 * DAY), confirmed: true });
    await saleFor(b, { ref: 'B1', soldAt: ago(4 * DAY), confirmed: false });
    const w = (await (await boot()).warnings()).filter((x) => x.code === 'SALE_UNCONFIRMED');
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ level: 'info', domain: 'beta-two.com', details: { venue: 'afternic', transaction_ref: 'B1', evidence_source: 'afternic_email', evidence_ref: 'ev-B1', recorded_by: 'gavriel' } });
    expect(w[0]!.details.sold_at).toContain('+03:00');
  });

  it('DOMAIN_LEFT_ACCOUNT: absent and no sale is an error; a sold domain is not reported', async () => {
    const a = await insertOwnedDomain(db, { domain: 'gone-one.com' });
    const b = await insertOwnedDomain(db, { domain: 'sold-two.com' });
    const c = await insertOwnedDomain(db, { domain: 'here-three.com' });
    await saleFor(b, { ref: 'S', soldAt: ago(3 * DAY) });
    for (const [id, status] of [[a, 'absent'], [b, 'absent'], [c, 'present']] as const) {
      await db.insertInto('registrar_presence').values({ domain_id: id, status, first_absent_at: status === 'absent' ? ago(DAY) : null, last_checked_at: new Date(NOW) }).execute();
    }
    const w = (await (await boot()).warnings()).filter((x) => x.code === 'DOMAIN_LEFT_ACCOUNT');
    expect(w.map((x) => [x.domain, x.level])).toEqual([['gone-one.com', 'error']]);
  });

  it('PO-5: PAYOUT_OVERDUE only for the payout pending more than 30 days (31 d, not 30 d)', async () => {
    const a = await insertOwnedDomain(db, { domain: 'old-one.com' });
    const b = await insertOwnedDomain(db, { domain: 'new-two.com' });
    await payout(a, await saleFor(a, { ref: 'P1', soldAt: ago(31 * DAY) }));
    await payout(b, await saleFor(b, { ref: 'P2', soldAt: ago(30 * DAY) }));
    const w = (await (await boot()).warnings()).filter((x) => x.code === 'PAYOUT_OVERDUE');
    expect(w.map((x) => [x.domain, x.level, x.details.days_pending])).toEqual([['old-one.com', 'warn', 31]]);
  });

  it('R-7 / NS_UNVERIFIED: lander NS set but not verified, on an owned domain', async () => {
    await insertOwnedDomain(db, { domain: 'ns-bad.com', lander: 'afternic', lander_ns: ['ns1.afternic.com', 'ns2.afternic.com'], ns_verified_at: null });
    await insertOwnedDomain(db, { domain: 'ns-ok.com', lander: 'afternic', lander_ns: ['ns1.afternic.com', 'ns2.afternic.com'], ns_verified_at: ago(DAY) });
    const w = (await (await boot()).warnings()).filter((x) => x.code === 'NS_UNVERIFIED');
    expect(w.map((x) => [x.domain, x.level])).toEqual([['ns-bad.com', 'warn']]);
  });

  it('BIN_MISSING and FLOOR_AUTO_ACCEPT on listed names', async () => {
    await insertOwnedDomain(db, { domain: 'nobin.com', status: 'listed', category: 'trend', price_grade: null, listing_mode: 'hybrid', bin_cents: null });
    await listedDomain({ domain: 'hyb.com' });
    const w = await (await boot()).warnings();
    expect(w.filter((x) => x.code === 'BIN_MISSING').map((x) => [x.domain, x.level])).toEqual([['nobin.com', 'warn']]);
    const f = w.filter((x) => x.code === 'FLOOR_AUTO_ACCEPT');
    expect(f.map((x) => [x.domain, x.level])).toEqual([['hyb.com', 'info']]);
    expect(f[0]!.details).toMatchObject({ floor_cents: 129500, bin_cents: 199500 });
  });

  it('RENEWAL_PRICE_UNKNOWN: renewals_used 0 and no price, not sold or dropped', async () => {
    await insertOwnedDomain(db, { domain: 'noprice.com', renewal_price_cents: null });
    await insertOwnedDomain(db, { domain: 'dropped-no.com', renewal_price_cents: null, status: 'dropped' });
    await insertOwnedDomain(db, { domain: 'renewed.com', renewal_price_cents: null, renewals_used: 1 });
    const w = (await (await boot()).warnings()).filter((x) => x.code === 'RENEWAL_PRICE_UNKNOWN');
    expect(w.map((x) => [x.domain, x.level])).toEqual([['noprice.com', 'warn']]);
  });

  it('EXPORT_STALE / EXPORT_PENDING: PR-37 pending 3 days warns, 8 days is an error; stale only without a recent upload', async () => {
    await listedDomain({ domain: 'p-three.com', listing_changed_at: ago(3 * DAY), export_pending_since: ago(3 * DAY) });
    const t = await boot();
    let w = await t.warnings();
    expect(w.filter((x) => x.code === 'EXPORT_PENDING').map((x) => [x.domain, x.level, x.details.days_pending])).toEqual([['p-three.com', 'warn', 3]]);
    expect(codes(w)).toContain('EXPORT_STALE');
    await db.updateTable('domains').set({ listing_changed_at: ago(8 * DAY), export_pending_since: ago(8 * DAY) }).where('domain', '=', 'p-three.com').execute();
    w = await t.warnings();
    expect(w.filter((x) => x.code === 'EXPORT_PENDING').map((x) => [x.level, x.details.days_pending])).toEqual([['error', 8]]);
    await db.insertInto('export_runs').values({ marketplace: 'afternic', domains: ['other.com'], export_id: 'exp_1' }).execute();
    await db.insertInto('export_uploads').values({ venue: 'afternic', export_id: 'exp_1', domains: ['other.com'], uploaded_at: ago(2 * DAY) }).execute();
    w = await t.warnings();
    expect(codes(w)).not.toContain('EXPORT_STALE');
    expect(codes(w)).toContain('EXPORT_PENDING');
  });

  it('PURCHASE_UNKNOWN, RECEIPT_MISSING and POST_BUY_INCOMPLETE', async () => {
    const base = { request_hash: 'h', max_price_cents: 2000, approval_text: 'ok', approval_at: ago(DAY) };
    await db.insertInto('purchases').values({ ...base, idempotency_key: 'k1', domain: 'unk.com', state: 'unknown' }).execute();
    await db.insertInto('purchases').values({ ...base, idempotency_key: 'k2', domain: 'bought.com', state: 'succeeded' }).execute();
    const ok = await db.insertInto('purchases').values({ ...base, idempotency_key: 'k3', domain: 'fine.com', state: 'succeeded' }).returning('id').executeTakeFirstOrThrow();
    await insertOwnedDomain(db, { domain: 'bought.com' });
    const fine = await insertOwnedDomain(db, { domain: 'fine.com' });
    await db.insertInto('receipts').values({ purchase_id: ok.id, registrar: 'porkbun', order_id: 'o1' }).execute();
    await db.insertInto('pricing_evidence').values({ domain_id: fine, comps: JSON.stringify([]), rationale: 'x' }).execute();
    const w = await (await boot()).warnings();
    expect(w.filter((x) => x.code === 'PURCHASE_UNKNOWN').map((x) => [x.domain, x.level])).toEqual([['unk.com', 'error']]);
    expect(w.filter((x) => x.code === 'RECEIPT_MISSING').map((x) => [x.domain, x.level])).toEqual([['bought.com', 'warn']]);
    expect(w.filter((x) => x.code === 'POST_BUY_INCOMPLETE').map((x) => [x.domain, x.level])).toEqual([['bought.com', 'warn']]);
  });

  it('PAST_DROP_DATE and EXPIRED_NOT_RENEWED', async () => {
    await insertOwnedDomain(db, { domain: 'late-drop.com', expiry_date: '2026-10-10', drop_date: '2026-10-10', renewals_used: 1 });
    await insertOwnedDomain(db, { domain: 'lapsed.com', expiry_date: '2026-10-10', drop_date: '2027-10-10' });
    await insertOwnedDomain(db, { domain: 'fine.com' });
    const w = await (await boot()).warnings();
    expect(w.filter((x) => x.code === 'PAST_DROP_DATE').map((x) => [x.domain, x.level])).toEqual([['late-drop.com', 'warn']]);
    expect(w.filter((x) => x.code === 'EXPIRED_NOT_RENEWED').map((x) => [x.domain, x.level])).toEqual([['lapsed.com', 'error']]);
  });

  it('PRICE_EVENT_FAILED: a failed event on a live domain is an error; not for sold domains', async () => {
    const a = await listedDomain({ domain: 'fail-one.com', plan_id: 'plan_a' });
    const b = await insertOwnedDomain(db, { domain: 'sold-fail.com', status: 'sold' });
    for (const id of [a, b]) await db.insertInto('price_schedule').values({ domain_id: id, plan_id: 'plan_a', event: 'drop1_m6', due_on: '2026-10-10', settings_version: 2, status: 'failed', note: 'boom' }).execute();
    const w = (await (await boot()).warnings()).filter((x) => x.code === 'PRICE_EVENT_FAILED');
    expect(w.map((x) => [x.domain, x.level])).toEqual([['fail-one.com', 'error']]);
  });

  it('HOLD_STALE: a hold whose latest history row is older than 30 days', async () => {
    const a = await listedDomain({ domain: 'hold-old.com', pricing_hold: true, pricing_hold_reason: 'waiting' });
    const b = await listedDomain({ domain: 'hold-new.com', pricing_hold: true, pricing_hold_reason: 'waiting' });
    await db.insertInto('listing_history').values({ domain_id: a, source: 'list', at: ago(31 * DAY) }).execute();
    await db.insertInto('listing_history').values({ domain_id: b, source: 'list', at: ago(29 * DAY) }).execute();
    const w = (await (await boot()).warnings()).filter((x) => x.code === 'HOLD_STALE');
    expect(w.map((x) => [x.domain, x.level])).toEqual([['hold-old.com', 'warn']]);
  });

  it('PRICING_EXCEPTION: info, with the formula values next to the stored ones', async () => {
    await listedDomain({ domain: 'exc.com', pricing_source: 'approved_exception', floor_cents: 129500, walkaway_cents: 95000 });
    const w = (await (await boot()).warnings()).filter((x) => x.code === 'PRICING_EXCEPTION');
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ level: 'info', domain: 'exc.com' });
    expect(w[0]!.details.stored).toMatchObject({ walkaway_cents: 95000, floor_cents: 129500 });
    expect(w[0]!.details.formula).toMatchObject({ floor_cents: 129500, walkaway_cents: 96000, walkaway: '$960 (private)' });
  });

  describe('OF-20 (warning half): OFFER_NEEDS_DVIR', () => {
    const offer = (domainId: number, createdAt: Date, extra: Record<string, unknown> = {}) => db.insertInto('offers').values({
      domain_id: domainId, amount_cents: 100000, source: 'afternic', received_at: createdAt, band: 'mid_range', routing: 'dvir', outcome: 'open', recorded_by: 'gavriel', created_at: createdAt, ...extra,
    }).execute();
    it('49 h fires; 47 h does not; an old imported offer created 1 h ago does not; a decided offer does not; sold and dropped domains are skipped', async () => {
      const a = await listedDomain({ domain: 'o-49.com' });
      const b = await listedDomain({ domain: 'o-47.com' });
      const c = await listedDomain({ domain: 'o-imp.com' });
      const d = await listedDomain({ domain: 'o-done.com' });
      const sold = await listedDomain({ domain: 'o-sold.com' });
      const dropped = await listedDomain({ domain: 'o-dropped.com' });
      await db.updateTable('domains').set({ status: 'sold' }).where('id', '=', sold).execute();
      await db.updateTable('domains').set({ status: 'dropped' }).where('id', '=', dropped).execute();
      await offer(sold, new Date(NOW - 60 * 3_600_000));
      await offer(dropped, new Date(NOW - 60 * 3_600_000));
      await offer(a, new Date(NOW - 49 * 3_600_000));
      await offer(b, new Date(NOW - 47 * 3_600_000));
      await offer(c, new Date(NOW - 1 * 3_600_000), { received_at: ago(60 * DAY) });
      await offer(d, new Date(NOW - 60 * 3_600_000), { outcome: 'declined' });
      const w = (await (await boot()).warnings()).filter((x) => x.code === 'OFFER_NEEDS_DVIR');
      expect(w.map((x) => [x.domain, x.level])).toEqual([['o-49.com', 'warn']]);
    });
  });

  it('warnings are ordered error, warn, info', async () => {
    await insertOwnedDomain(db, { domain: 'lapsed.com', expiry_date: '2026-10-10', drop_date: '2027-10-10', renewal_price_cents: null });
    await listedDomain({ domain: 'hyb.com' });
    const w = await (await boot()).warnings();
    const ranks = w.map((x) => ['error', 'warn', 'info'].indexOf(x.level));
    expect(ranks).toEqual([...ranks].sort((p, q) => p - q));
    expect(ranks.length).toBeGreaterThan(2);
  });
});

describe('GET /report?format=md', () => {
  it('R-9: markdown with consistent tables, $ amounts, the BIN and no walk-away', async () => {
    await listedDomain({ domain: 'trendy-name.com' });
    await insertOwnedDomain(db, { domain: 'lapsed.com', expiry_date: '2026-10-10', drop_date: '2027-10-10' });
    const t = await boot();
    const r = await t.get('/report?format=md');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('text/markdown; charset=utf-8');
    const md = r.body;
    for (const h of ['## Budget', '## Sales & ROI', '## Domains', '## Upcoming (90 days)', '## Pending payouts', '## Warnings']) expect(md).toContain(h);
    expect(md).toContain('$1,995');
    expect(md).toContain('$1,500.00');
    expect(md).not.toMatch(/960|walk/i);
    const lines = md.split('\n');
    let tables = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.startsWith('|') && lines[i + 1]?.startsWith('|---') && !lines[i - 1]?.startsWith('|')) {
        tables++;
        const cols = (s: string) => s.replaceAll('\\|', '').split('|').length;
        const n = cols(lines[i]!);
        expect(cols(lines[i + 1]!)).toBe(n);
        for (let j = i + 2; lines[j]?.startsWith('|'); j++) expect(cols(lines[j]!), lines[j]).toBe(n);
      }
    }
    expect(tables).toBeGreaterThanOrEqual(2);
  });

  it('format=json is the JSON report; any other format is 400 VALIDATION_ERROR', async () => {
    const t = await boot();
    const j = await t.get('/report?format=json');
    expect(j.statusCode).toBe(200);
    expect(j.json()).toHaveProperty('warnings');
    const bad = await t.get('/report?format=csv');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('VALIDATION_ERROR');
  });
});
