import { describe, expect, it } from 'vitest';
import { DropJob } from '../../src/modules/ops/jobs/drop.js';
import { manualDelist } from '../../src/modules/listing/export-state.js';
import { insertOwnedDomain, testDb as db } from '../helpers/db.js';

const D = 'examplecityroofing.com';
const NOW = Date.parse('2028-10-05T09:00:00Z');
const job = () => new DropJob({ db, now: () => NOW });
const dom = (d = D) => db.selectFrom('domains').selectAll().where('domain', '=', d).executeTakeFirstOrThrow();
const audits = () => db.selectFrom('audit_log').selectAll().where('scope', '=', 'job').where('path', '=', 'drop').execute();

async function listed(over: Record<string, unknown> = {}) {
  const id = await insertOwnedDomain(db, { domain: D, status: 'listed', category: 'trend', price_grade: null, drop_date: '2028-10-04', ...over });
  await db.updateTable('domains').set({ plan_id: 'pl_x', first_listed_at: new Date('2026-10-12T09:00:00Z') }).where('id', '=', id).execute();
  for (const [event, due] of [['drop2_m18', '2028-04-12'], ['final_push', '2028-07-06'], ['delist', '2028-09-27']] as const) {
    await db.insertInto('price_schedule').values({ domain_id: id, plan_id: 'pl_x', event, due_on: due, ...(event === 'delist' ? { bin_cents: null, floor_cents: null, walkaway_cents: null } : { bin_cents: 129500, floor_cents: 83000, walkaway_cents: 61000 }), settings_version: 2, status: 'planned' }).execute();
  }
  await db.insertInto('price_schedule').values({ domain_id: id, plan_id: 'pl_x', event: 'drop1_m6', due_on: '2027-04-12', bin_cents: 1, floor_cents: 1, walkaway_cents: 1, settings_version: 2, status: 'applied' }).execute();
  return id;
}

describe('drop job', () => {
  it('PR-25 drop: listed past drop_date -> dropped, delisted_at set, planned rows cancelled, audit row', async () => {
    const id = await listed();
    const r = await job().runOnce({ today: '2028-10-05' });
    expect(r).toMatchObject({ today: '2028-10-05', dryRun: false, dropped: [D], failed: [] });
    const d = await dom();
    expect(d.status).toBe('dropped');
    expect(d.delisted_at?.getTime()).toBe(NOW);
    expect(d.listing_changed_at?.getTime()).toBe(NOW);
    expect(d.export_pending_since).toBeNull();
    const rows = await db.selectFrom('price_schedule').select(['event', 'status', 'note']).where('domain_id', '=', id).orderBy('id').execute();
    expect(rows.filter((x) => x.event !== 'drop1_m6').every((x) => x.status === 'cancelled' && x.note === 'dropped')).toBe(true);
    expect(rows.find((x) => x.event === 'drop1_m6')!.status).toBe('applied');
    expect(await audits()).toHaveLength(1);
  });

  it('keeps an existing delisted_at', async () => {
    const t = new Date('2028-09-27T00:30:00Z');
    await listed({ status: 'delisted', delisted_at: t });
    await job().runOnce({ today: '2028-10-05' });
    expect((await dom()).delisted_at?.getTime()).toBe(t.getTime());
  });

  it('the drop date itself is not yet dropped (strictly after)', async () => {
    await listed();
    const r = await job().runOnce({ today: '2028-10-04' });
    expect(r.dropped).toEqual([]);
    expect((await dom()).status).toBe('listed');
  });

  it('an owned domain past drop_date is dropped', async () => {
    await insertOwnedDomain(db, { domain: D, drop_date: '2028-10-04' });
    expect((await job().runOnce({ today: '2028-10-05' })).dropped).toEqual([D]);
    expect((await dom()).status).toBe('dropped');
  });

  it('a sold domain is untouched', async () => {
    await insertOwnedDomain(db, { domain: D, status: 'sold', sold_at: new Date('2027-01-01T00:00:00Z') });
    expect((await job().runOnce({ today: '2028-10-05' })).dropped).toEqual([]);
    expect((await dom()).status).toBe('sold');
  });

  it('a dry run changes nothing', async () => {
    const id = await listed();
    const before = await dom();
    const r = await job().runOnce({ today: '2028-10-05', dryRun: true });
    expect(r).toMatchObject({ dryRun: true, dropped: [D] });
    expect(await dom()).toEqual(before);
    expect(await db.selectFrom('price_schedule').select('id').where('domain_id', '=', id).where('status', '=', 'planned').execute()).toHaveLength(3);
    expect(await audits()).toHaveLength(0);
  });

  it('two concurrent runs on two instances make one transition', async () => {
    await listed();
    const rs = await Promise.all([job().runOnce({ today: '2028-10-05' }), job().runOnce({ today: '2028-10-05' })]);
    expect(rs.flatMap((r) => r.dropped)).toEqual([D]);
    expect(await audits()).toHaveLength(1);
  });

  it('re-entry on the same instance returns skipped', async () => {
    await listed();
    const j = job();
    const [a, b] = await Promise.all([j.runOnce({ today: '2028-10-05' }), j.runOnce({ today: '2028-10-05' })]);
    expect([a.skipped, b.skipped].sort()).toEqual([false, true]);
  });

  it('a delisted name keeps its listing_changed_at when dropped, so a confirmed file after the delist clears the removal task for good', async () => {
    const delistedAt = new Date('2028-09-27T09:00:00Z');
    const id = await listed({ status: 'delisted', delisted_at: delistedAt, listing_changed_at: delistedAt });
    await db.insertInto('export_runs').values({ marketplace: 'afternic', at: new Date('2028-10-01T09:00:00Z'), domains: [], export_id: 'e_after' }).execute();
    await db.insertInto('export_uploads').values({ venue: 'afternic', export_id: 'e_after', domains: [], uploaded_at: new Date('2028-10-01T09:05:00Z'), approval_text: 'uploaded' }).execute();
    expect(await manualDelist(db, 'afternic')).toEqual([]);
    await job().runOnce({ today: '2028-10-05' });
    expect((await dom()).status).toBe('dropped');
    expect((await dom()).listing_changed_at?.getTime()).toBe(delistedAt.getTime());
    expect(await manualDelist(db, 'afternic')).toEqual([]);
    expect(id).toBeGreaterThan(0);
  });
});
