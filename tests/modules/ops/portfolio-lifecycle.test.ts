// v4.0.0: the daily portfolioLifecycle step: expired unrenewed names (G-85), the renewal-window lookalike re-check (CR-045 item 1), the monthly holdout and its re-check (CR-044 item 6).
// The screened-name pool and the lookalike check are injected (the real check is covered by tests/modules/selection/screening-lookalikes).
import { describe, expect, it } from 'vitest';
import { PortfolioLifecycleJob } from '../../../src/modules/ops/jobs/portfolio-lifecycle.js';
import type { LookalikeCounts, ScreenedName } from '../../../src/modules/selection/index.js';
import { insertOwnedDomain, testDb as db } from '../../helpers/db.js';

const clock = { t: Date.parse('2027-10-10T09:00:00Z') };
const screening = {} as never;
const names = (n: number, prefix: string, passed: boolean): ScreenedName[] => Array.from({ length: n }, (_, i) => ({ domain: `${prefix}${String(i).padStart(2, '0')}.com`, run_id: 'run_000000000001', passed }));
function job(o: { pool?: ScreenedName[]; counts?: (d: string) => LookalikeCounts | null } = {}) {
  const calls: string[] = [];
  const j = new PortfolioLifecycleJob({
    db, screening, now: () => clock.t,
    screened: async () => o.pool ?? [],
    lookalikes: async (_db, _s, domain) => { calls.push(domain); return o.counts ? o.counts(domain) : { registered_n: 2, in_use_n: 1, unknown_n: 0 }; },
  });
  return { j, calls };
}
const dom = (d: string) => db.selectFrom('domains').selectAll().where('domain', '=', d).executeTakeFirstOrThrow();

describe('expireUnrenewed (G-85)', () => {
  it('PL-1: a live name past its first expiry, not renewed, with a later drop_date is marked delisted (no registrar call); DropJob territory and renewed names are left alone', async () => {
    await insertOwnedDomain(db, { domain: 'lapsed.com', status: 'listed', expiry_date: '2027-10-04', drop_date: '2028-10-04', category: 'trend', price_grade: null });
    await insertOwnedDomain(db, { domain: 'renewed.com', status: 'listed', expiry_date: '2027-10-04', drop_date: '2028-10-04', renewals_used: 1, category: 'trend', price_grade: null });
    await insertOwnedDomain(db, { domain: 'firstexpiry.com', status: 'listed', expiry_date: '2027-10-04', drop_date: '2027-10-04', category: 'trend', price_grade: null });
    await insertOwnedDomain(db, { domain: 'notyet.com', status: 'listed', expiry_date: '2027-11-04', drop_date: '2028-11-04', category: 'trend', price_grade: null });
    const r = await job().j.runOnce();
    expect(r.expired).toEqual(['lapsed.com']);
    expect(await dom('lapsed.com')).toMatchObject({ status: 'delisted' });
    expect((await dom('lapsed.com')).delisted_at).not.toBeNull();
    expect((await dom('lapsed.com')).listing_changed_at).not.toBeNull();
    for (const d of ['renewed.com', 'firstexpiry.com', 'notyet.com']) expect((await dom(d)).status).toBe('listed');
    expect(await db.selectFrom('audit_log').select('result_summary').where('path', '=', 'expire-unrenewed').execute()).toEqual([{ result_summary: 'expired 2027-10-04 not renewed; listed -> delisted' }]);
    expect((await job().j.runOnce()).expired).toEqual([]); // a second run changes nothing
  });
});

describe('lookalike re-check in the renewal window', () => {
  it('PL-2: a name within renewal.drop_check_days of expiry is re-checked once a month and the row is stored; a failure is stored as unknown', async () => {
    clock.t = Date.parse('2027-08-10T09:00:00Z');
    await insertOwnedDomain(db, { domain: 'inwindow.com', status: 'listed', expiry_date: '2027-10-04', drop_date: '2028-10-04', category: 'trend', price_grade: null });
    await insertOwnedDomain(db, { domain: 'faraway.com', status: 'listed', expiry_date: '2028-03-04', drop_date: '2029-03-04', category: 'trend', price_grade: null });
    await insertOwnedDomain(db, { domain: 'broken.com', status: 'listed', expiry_date: '2027-10-05', drop_date: '2028-10-05', category: 'trend', price_grade: null });
    const a = job({ counts: (d) => (d === 'broken.com' ? null : { registered_n: 3, in_use_n: 2, unknown_n: 0 }) });
    const r = await a.j.runOnce();
    expect(r.lookalikes).toEqual([{ domain: 'inwindow.com', ok: true }, { domain: 'broken.com', ok: false }]);
    const rows = await db.selectFrom('portfolio_checks').select(['status', 'details', 'domain_id']).where('kind', '=', 'lookalikes').orderBy('id').execute();
    expect(rows.map((x) => x.status)).toEqual(['ok', 'unknown']);
    expect(rows[0]!.details).toMatchObject({ registered_n: 3, in_use_n: 2 });
    expect(a.calls).toEqual(['inwindow.com', 'broken.com']);
    const b = job();
    expect((await b.j.runOnce()).lookalikes).toEqual([]); // checked within 30 days
    clock.t = Date.parse('2027-09-20T09:00:00Z');
    expect((await job().j.runOnce()).lookalikes.map((x) => x.domain)).toEqual(['inwindow.com', 'broken.com']);
  });
});

describe('monthly holdout (CR-044 item 6)', () => {
  const pool = [...names(30, 'pass', true), ...names(30, 'fail', false)];

  it('PL-3: stores 20 passed and 20 failed screened, not bought names once a month; the pick is seeded (the same pool gives the same names in any order)', async () => {
    clock.t = Date.parse('2027-10-10T09:00:00Z');
    await insertOwnedDomain(db, { domain: 'pass00.com', status: 'listed', category: 'trend', price_grade: null }); // bought: never in the holdout
    const r = await job({ pool }).j.runOnce();
    expect(r.holdout).toMatchObject({ month: '2027-10', picked: { passed: 20, failed: 20 } });
    const rows = await db.selectFrom('holdout').selectAll().orderBy('id').execute();
    expect(rows).toHaveLength(40);
    expect(rows.filter((x) => x.grp === 'passed')).toHaveLength(20);
    expect(rows.filter((x) => x.grp === 'failed')).toHaveLength(20);
    expect(rows.some((x) => x.domain === 'pass00.com')).toBe(false);
    expect(rows[0]).toMatchObject({ month: '2027-10', seed: '2027-10', lookalikes_at_pick: { registered_n: 2, in_use_n: 1 } });
    const first = rows.map((x) => x.domain).sort();
    await db.deleteFrom('holdout').execute();
    const again = await job({ pool: [...pool].reverse() }).j.runOnce();
    expect(again.holdout.picked).toEqual({ passed: 20, failed: 20 });
    expect((await db.selectFrom('holdout').select('domain').execute()).map((x) => x.domain).sort()).toEqual(first);
  });

  it('PL-4: a second run in the same month picks nothing; the next month picks others and never repeats a name', async () => {
    clock.t = Date.parse('2027-10-10T09:00:00Z');
    await job({ pool }).j.runOnce();
    expect((await job({ pool }).j.runOnce()).holdout.picked).toBeNull();
    clock.t = Date.parse('2027-11-10T09:00:00Z');
    const nov = await job({ pool }).j.runOnce();
    expect(nov.holdout.picked).toEqual({ passed: 10, failed: 10 }); // 30 - 20 left of each
    const all = await db.selectFrom('holdout').select(['domain']).execute();
    expect(new Set(all.map((x) => x.domain)).size).toBe(60);
  });

  it('PL-5: an empty pool stores nothing; a failing lookalike check stores the name with no count', async () => {
    clock.t = Date.parse('2027-10-10T09:00:00Z');
    expect((await job({ pool: [] }).j.runOnce()).holdout.picked).toEqual({ passed: 0, failed: 0 });
    await job({ pool: names(1, 'pass', true), counts: () => null }).j.runOnce();
    expect(await db.selectFrom('holdout').select(['domain', 'lookalikes_at_pick']).execute()).toEqual([{ domain: 'pass00.com', lookalikes_at_pick: null }]);
  });

  it('PL-6: after holdout_recheck_months (6) the lookalike check is re-run once and the change is stored; before that nothing', async () => {
    clock.t = Date.parse('2027-04-10T09:00:00Z');
    await job({ pool: names(2, 'pass', true).concat(names(1, 'fail', false)), counts: () => ({ registered_n: 2, in_use_n: 1, unknown_n: 0 }) }).j.runOnce();
    await db.updateTable('holdout').set({ picked_at: new Date(clock.t) }).execute();
    clock.t = Date.parse('2027-09-20T09:00:00Z');
    expect((await job({ pool: [] }).j.runOnce()).holdout.rechecked).toEqual([]);
    clock.t = Date.parse('2027-10-20T09:00:00Z');
    const r = await job({ pool: [], counts: (d) => (d === 'pass00.com' ? { registered_n: 4, in_use_n: 3, unknown_n: 0 } : { registered_n: 2, in_use_n: 1, unknown_n: 0 }) }).j.runOnce();
    expect(r.holdout.rechecked.sort()).toEqual(['fail00.com', 'pass00.com', 'pass01.com']);
    const p = await db.selectFrom('holdout').selectAll().where('domain', '=', 'pass00.com').executeTakeFirstOrThrow();
    expect(p.lookalikes_recheck).toMatchObject({ registered_n: 4, in_use_n: 3 });
    expect(p.delta).toEqual({ registered_n: 2, in_use_n: 2 });
    expect(p.recheck_at).not.toBeNull();
    expect((await job({ pool: [] }).j.runOnce()).holdout.rechecked).toEqual([]); // once only
  });
});
