import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { buildSchedule } from '../../src/pricing/schedule.js';
import { currentSettings } from '../../src/pricing/settings.js';
import { validateListing, type ListingPlan, type ListingRequest } from '../../src/services/listing-v2.js';
import { domainPlanColumns, historyRow, newPlanId, withDomainLock, writePlan } from '../../src/services/plan-store.js';
import { planView } from '../../src/services/plan-view.js';
import { insertOwnedDomain, testDb as db } from '../helpers/db.js';

const NOW = new Date('2026-10-12T09:00:00Z');
async function mk(req: ListingRequest, over: { override?: boolean } = {}): Promise<{ plan: ListingPlan; settings: Awaited<ReturnType<typeof currentSettings>> }> {
  const settings = await currentSettings(db, NOW);
  const r = validateListing(req, {
    category: 'trend', grade: null, phase: 'change', settings, highValueMinBinCents: 250000,
    override: over.override ?? false, overrideReason: over.override ? 'Dvir asked' : null, approvalValid: true, today: '2026-10-12', dropDate: '2028-10-04',
  });
  if (!r.ok) throw new Error(r.code);
  return { plan: r.plan, settings };
}
const rows = (id: number) => db.selectFrom('price_schedule').selectAll().where('domain_id', '=', id).orderBy('id').execute();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('writePlan', () => {
  it('writes the schedule, sets plan_id, supersedes on rewrite and leaves non-planned rows alone', async () => {
    const id = await insertOwnedDomain(db, { category: 'trend', price_grade: null });
    const { plan, settings } = await mk({ mode: 'hybrid', bin: 1995 });
    const a = await db.transaction().execute((trx) => writePlan(trx, { domainId: id, plan, anchor: '2026-10-12', dropDate: '2028-10-04', settings, planAuditId: 'aud_1', now: NOW }));
    expect(a.planId.startsWith('pl_')).toBe(true);
    const first = await rows(id);
    expect(first.map((r) => [r.event, r.due_on, r.bin_cents, r.floor_cents, r.walkaway_cents, r.status, r.settings_version])).toEqual([
      ['drop1_m6', '2027-04-12', 159500, 103500, 77000, 'planned', 2],
      ['drop2_m18', '2028-04-12', 129500, 83000, 61500, 'planned', 2],
      ['final_push', '2028-07-06', 89500, 83000, 61500, 'planned', 2],
      ['delist', '2028-09-27', null, null, null, 'planned', 2],
    ]);
    let d = await db.selectFrom('domains').select(['plan_id', 'plan_audit_id']).where('id', '=', id).executeTakeFirstOrThrow();
    expect(d).toEqual({ plan_id: a.planId, plan_audit_id: 'aud_1' });

    await db.updateTable('price_schedule').set({ status: 'applied' }).where('id', '=', first[0]!.id).execute();
    const n = await mk({ mode: 'hybrid', bin: 1795 });
    const b = await db.transaction().execute((trx) => writePlan(trx, { domainId: id, plan: n.plan, anchor: '2026-10-12', dropDate: '2028-10-04', settings: n.settings, planAuditId: 'aud_2', startAfter: '2027-05-01', now: NOW }));
    const all = await rows(id);
    const old = all.filter((r) => r.plan_id === a.planId);
    expect(old.map((r) => r.status)).toEqual(['applied', 'superseded', 'superseded', 'superseded']);
    expect(all.filter((r) => r.plan_id === b.planId).map((r) => [r.event, r.due_on, r.bin_cents, r.floor_cents, r.walkaway_cents, r.status])).toEqual([
      ['drop2_m18', '2028-04-12', 139500, 93000, 69000, 'planned'],
      ['final_push', '2028-07-06', 99500, 93000, 69000, 'planned'],
      ['delist', '2028-09-27', null, null, null, 'planned'],
    ]);
    d = await db.selectFrom('domains').select(['plan_id', 'plan_audit_id']).where('id', '=', id).executeTakeFirstOrThrow();
    expect(d.plan_id).toBe(b.planId);
    expect(b.planId).not.toBe(a.planId);
    expect(newPlanId()).toMatch(/^pl_/);
  });
});

const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };

describe('withDomainLock', () => {
  it('serialises the same domain', async () => {
    const t: Record<string, number> = {};
    const held = gate();
    const p1 = withDomainLock(db, 'x.com', async () => { t.start1 = Date.now(); held.open(); await sleep(200); t.end1 = Date.now(); });
    await held.p;
    const p2 = withDomainLock(db, 'x.com', async () => { t.start2 = Date.now(); });
    await Promise.all([p1, p2]);
    expect(t.start2).toBeGreaterThanOrEqual(t.end1!);
  });
  it('does not block a different domain', async () => {
    const t: Record<string, number> = {};
    const held = gate();
    const p1 = withDomainLock(db, 'x.com', async () => { held.open(); await sleep(200); t.end1 = Date.now(); });
    await held.p;
    await withDomainLock(db, 'y.com', async () => { t.start2 = Date.now(); });
    await p1;
    expect(t.start2).toBeLessThan(t.end1!);
  });
  it('supports a transaction on the connection and commits', async () => {
    const id = await insertOwnedDomain(db, { category: 'trend', price_grade: null });
    await withDomainLock(db, 'x.com', async (conn) => {
      await conn.transaction().execute(async (trx) => { await trx.updateTable('domains').set({ display_name: 'Tx' }).where('id', '=', id).execute(); });
    });
    const r = await db.selectFrom('domains').select('display_name').where('id', '=', id).executeTakeFirstOrThrow();
    expect(r.display_name).toBe('Tx');
  });
  it('blocks /buy-style pg_advisory_xact_lock(hashtext(domain)) until released', async () => {
    const t: Record<string, number> = {};
    const held = gate();
    const p1 = withDomainLock(db, 'x.com', async () => { held.open(); await sleep(200); t.end1 = Date.now(); });
    await held.p;
    const p2 = db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtext(${'x.com'}))`.execute(trx);
      t.got = Date.now();
    });
    await Promise.all([p1, p2]);
    expect(t.got).toBeGreaterThanOrEqual(t.end1!);
  });
  it('times out with DOMAIN_BUSY while another holder has the lock', async () => {
    const held = gate();
    const p1 = withDomainLock(db, 'x.com', async () => { held.open(); await sleep(500); });
    await held.p;
    await expect(withDomainLock(db, 'x.com', async () => 1, { timeoutMs: 200 })).rejects.toMatchObject({ status: 503, code: 'DOMAIN_BUSY' });
    await p1;
  });
  it('fn error propagates and the lock is released at once', async () => {
    await expect(withDomainLock(db, 'x.com', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    const got = await withDomainLock(db, 'x.com', async () => 'ok', { timeoutMs: 100 });
    expect(got).toBe('ok');
  });
  it('releases the lock when fn leaves an open (aborted) transaction', async () => {
    await withDomainLock(db, 'x.com', async (conn) => {
      await sql`begin`.execute(conn);
      await sql`select 1/0`.execute(conn).catch(() => undefined);
    });
    const got = await withDomainLock(db, 'x.com', async () => 'ok', { timeoutMs: 100 });
    expect(got).toBe('ok');
    await withDomainLock(db, 'x.com', async (conn) => { await sql`begin`.execute(conn); });
    expect(await withDomainLock(db, 'x.com', async () => 'ok2', { timeoutMs: 100 })).toBe('ok2');
  });
});

describe('historyRow and domainPlanColumns', () => {
  it('inserts a v2 history row and updates domain columns', async () => {
    const id = await insertOwnedDomain(db, { category: 'trend', price_grade: null });
    const { plan } = await mk({ mode: 'hybrid', bin: 1995 });
    await db.insertInto('listing_history').values(historyRow({
      domainId: id, source: 'list', plan, category: 'trend', grade: null, lander: null, override: false, overrideReason: null,
      approvalText: null, approvalAt: null, auditId: 'aud_h', planAuditId: 'aud_p', at: new Date('2026-10-12T09:00:00Z'),
    })).execute();
    const h = await db.selectFrom('listing_history').selectAll().where('domain_id', '=', id).executeTakeFirstOrThrow();
    expect(h).toMatchObject({ mode: 'hybrid', bin_cents: 199500, walkaway_cents: 96000, pricing_source: 'formula', pricing_settings_version: 2, price_grade: null, plan_audit_id: 'aud_p' });
    await db.updateTable('domains').set(domainPlanColumns(plan)).where('id', '=', id).execute();
    const d = await db.selectFrom('domains').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(d).toMatchObject({ listing_mode: 'hybrid', bin_cents: 199500, floor_cents: 129500, walkaway_cents: 96000, min_offer_cents: 10000, pricing_settings_version: 2 });
  });
});

describe('planView', () => {
  it('hybrid 1995 full shape', async () => {
    const { plan, settings } = await mk({ mode: 'hybrid', bin: 1995 });
    const events = buildSchedule({ plan, anchor: '2026-10-12', dropDate: '2028-10-04', settings });
    expect(planView(plan, events)).toEqual({
      mode: 'hybrid', category: 'trend', price_grade: null,
      bin_cents: 199500, bin: '$1,995', floor_cents: 129500, floor: '$1,295',
      walkaway_cents: 96000, walkaway: '$960 (private)', min_offer_cents: 10000, min_offer: '$100',
      lto_max_months: null, pricing_source: 'formula', settings_version: 2, override: false,
      schedule: [
        { event: 'drop1_m6', due_on: '2027-04-12', bin: '$1,595', floor: '$1,035', walkaway: '$770', status: 'planned' },
        { event: 'drop2_m18', due_on: '2028-04-12', bin: '$1,295', floor: '$830', walkaway: '$615', status: 'planned' },
        { event: 'final_push', due_on: '2028-07-06', bin: '$895', floor: '$830', walkaway: '$615', status: 'planned' },
        { event: 'delist', due_on: '2028-09-27', status: 'planned' },
      ],
      sell_plan_line: 'hybrid · BIN $1,995 · floor (auto-accept) $1,295 · walk-away (private) $960 · min offer $100 · LTO off · M6 2027-04-12 $1,595/$1,035/$770 · M18 2028-04-12 $1,295/$830/$615 · final push 2028-07-06 $895/$830/$615 · delist 2028-09-27 · settings v2',
    });
  });
  it('geo strong 499 shows price_grade strong', async () => {
    const settings = await currentSettings(db, NOW);
    const r = validateListing({ mode: 'bin', bin: 499 }, {
      category: 'geo', grade: 'strong', phase: 'buy', settings, highValueMinBinCents: 250000,
      override: false, overrideReason: null, approvalValid: true, today: '2026-10-12', dropDate: '2028-10-04',
    });
    if (!r.ok) throw new Error(r.code);
    expect(planView(r.plan, [])).toMatchObject({ mode: 'bin', category: 'geo', price_grade: 'strong', bin_cents: 49900, bin: '$499' });
  });
  it('offer mode has null bin and no sell_plan_line', async () => {
    const { plan } = await mk({ mode: 'offer', min_offer: 500 }, { override: true });
    expect(planView(plan, [])).toMatchObject({ bin_cents: null, bin: null, floor: null, walkaway: null, min_offer_cents: 50000, sell_plan_line: null });
  });
});

describe('writePlan guards', () => {
  it('rejects settings of another version than the plan', async () => {
    const id = await insertOwnedDomain(db, { category: 'trend', price_grade: null });
    const { plan, settings } = await mk({ mode: 'hybrid', bin: 1995 });
    await expect(db.transaction().execute((trx) => writePlan(trx, {
      domainId: id, plan, anchor: '2026-10-12', dropDate: '2028-10-04', settings: { ...settings, version: 3 }, planAuditId: 'a', now: NOW,
    }))).rejects.toThrow(/settings/);
  });
});
