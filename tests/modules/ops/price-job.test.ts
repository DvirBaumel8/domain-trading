import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { withDomainLock } from '../../../src/core/locks.js';
import { PriceScheduleJob } from '../../../src/modules/ops/jobs/price-schedule.js';
import { makeApp } from '../../helpers/app.js';
import { insertOwnedDomain, testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { issueToken } from '../../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const D = 'examplecityroofing.com';
const NOW = Date.parse('2026-10-12T09:00:00Z');
const approval = () => ({ text: `yes list ${D}`, approved_at: new Date(NOW - 3_600_000).toISOString() });
const job = () => new PriceScheduleJob({ db, now: () => NOW });
const dom = () => db.selectFrom('domains').selectAll().where('domain', '=', D).executeTakeFirstOrThrow();
const sched = () => db.selectFrom('price_schedule').selectAll().orderBy('id').execute();
const hist = () => db.selectFrom('listing_history').selectAll().where('source', '=', 'schedule').orderBy('id').execute();
const jobAudits = () => db.selectFrom('audit_log').selectAll().where('scope', '=', 'job').execute();
const triple = (d: Awaited<ReturnType<typeof dom>>) => [d.bin_cents, d.floor_cents, d.walkaway_cents];

async function setup(body: object = { mode: 'hybrid', bin: 1995, approval_ref: approval() }, dom0: Record<string, unknown> = { category: 'trend', price_grade: null }) {
  const pb = new FakeAdapter('porkbun');
  app = await makeApp({ adapters: [pb], now: () => NOW });
  const { auth } = await issueToken('write');
  await insertOwnedDomain(db, { domain: D, ...dom0 });
  const list = (b: object) => app.inject({ method: 'POST', url: `/list/${D}`, headers: { ...auth, 'idempotency-key': randomUUID() }, payload: b });
  expect((await list(body)).statusCode).toBe(200);
  return { pb, list };
}
const empty = (r: Awaited<ReturnType<PriceScheduleJob['runOnce']>>) =>
  expect([r.applied, r.superseded, r.failed, r.held, r.delisted, r.cancelled]).toEqual([[], [], [], [], [], []]);

describe('daily price job', () => {
  it('PR-20 / LH-5: due M6 applies; history, audit, export flags; no outbound call', async () => {
    const { pb } = await setup();
    const callsBefore = [...pb.calls];
    const m6 = (await sched()).find((r) => r.event === 'drop1_m6')!;
    const r = await job().runOnce({ today: '2027-04-12' });
    expect(r.applied).toHaveLength(1);
    const d = await dom();
    expect(triple(d)).toEqual([159500, 103500, 77000]);
    expect(d.min_offer_cents).toBe(10000);
    expect(d.listing_changed_at).not.toBeNull();
    expect(d.export_pending_since).not.toBeNull();
    const h = await hist();
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ source: 'schedule', schedule_event_id: m6.id, plan_audit_id: d.plan_audit_id, pricing_settings_version: 2, approval_text: null, approval_at: null });
    const row = (await sched()).find((x) => x.id === m6.id)!;
    expect(row).toMatchObject({ status: 'applied', listing_history_id: h[0]!.id });
    expect(await jobAudits()).toHaveLength(1);
    expect(pb.calls).toEqual(callsBefore);
  });

  it('history `at` is the job clock', async () => {
    await setup();
    const t = Date.parse('2027-04-12T00:30:00Z');
    await new PriceScheduleJob({ db, now: () => t }).runOnce({ today: '2027-04-12' });
    const h = await hist();
    expect(h).toHaveLength(1);
    expect(h[0]!.at.getTime()).toBe(t);
  });

  it('PR-21: before the due date nothing changes', async () => {
    await setup();
    const before = await dom();
    empty(await job().runOnce({ today: '2027-04-11' }));
    expect(await dom()).toEqual(before);
    expect(await hist()).toHaveLength(0);
  });

  it('PR-22: idempotent re-run, and two concurrent job instances apply once', async () => {
    await setup();
    await job().runOnce({ today: '2027-04-12' });
    empty(await job().runOnce({ today: '2027-04-12' }));
    expect(await hist()).toHaveLength(1);
  });

  it('PR-22b: concurrent runs on two instances', async () => {
    await setup();
    const rs = await Promise.all([job().runOnce({ today: '2027-04-12' }), job().runOnce({ today: '2027-04-12' })]);
    expect(rs.flatMap((r) => r.applied)).toHaveLength(1);
    expect(await hist()).toHaveLength(1);
  });

  it('re-entry on the same instance returns skipped', async () => {
    await setup();
    const j = job();
    const [a, b] = await Promise.all([j.runOnce({ today: '2027-04-12' }), j.runOnce({ today: '2027-04-12' })]);
    expect([a.skipped, b.skipped].sort()).toEqual([false, true]);
  });

  it('PR-23: hold keeps rows planned; after unhold only the latest due event applies', async () => {
    const { list } = await setup();
    expect((await list({ pricing_hold: true, pricing_hold_reason: 'buyer in talks', approval_ref: approval() })).statusCode).toBe(200);
    const r1 = await job().runOnce({ today: '2027-04-12' });
    expect(r1.applied).toEqual([]);
    expect(r1.held).toEqual([D]);
    expect((await sched()).every((r) => r.status === 'planned')).toBe(true);
    const r3 = await job().runOnce({ today: '2028-04-20' });
    expect(r3.applied).toEqual([]);
    expect(r3.held).toEqual([D]);
    expect((await sched()).every((r) => r.status === 'planned')).toBe(true);
    expect((await list({ pricing_hold: false, approval_ref: approval() })).statusCode).toBe(200);
    const r2 = await job().runOnce({ today: '2028-04-20' });
    expect(r2.applied.map((a) => a.event)).toEqual(['drop2_m18']);
    expect(triple(await dom())).toEqual([129500, 83000, 61500]);
    const rows = await sched();
    expect(rows.find((r) => r.event === 'drop1_m6')!.status).toBe('superseded');
    expect(await hist()).toHaveLength(1);
  });

  async function walkToDelist(hold: boolean, list: (b: object) => Promise<unknown>) {
    for (const t of ['2027-04-12', '2028-04-12', '2028-07-06']) await job().runOnce({ today: t });
    if (hold) await list({ pricing_hold: true, pricing_hold_reason: 'negotiating', approval_ref: approval() });
    return job().runOnce({ today: '2028-09-27' });
  }

  it('PR-27: delist applies on its date', async () => {
    const { list } = await setup();
    const r = await walkToDelist(false, list);
    expect(r.delisted).toEqual([D]);
    const d = await dom();
    expect(d.status).toBe('delisted');
    expect(d.delisted_at).not.toBeNull();
    const rows = await sched();
    expect(rows.find((x) => x.event === 'delist')!.status).toBe('applied');
    expect(rows.some((x) => x.status === 'planned')).toBe(false);
    expect(await hist()).toHaveLength(4);
  });

  it('PR-27: delist is not held', async () => {
    const { list } = await setup();
    const r = await walkToDelist(true, list);
    expect(r.delisted).toEqual([D]);
    expect((await dom()).status).toBe('delisted');
  });

  it('R6: a sold domain cancels its planned rows and keeps its price', async () => {
    await setup();
    await db.updateTable('domains').set({ status: 'sold', sold_at: new Date(NOW) }).where('domain', '=', D).execute();
    const r = await job().runOnce({ today: '2027-04-12' });
    expect(r.cancelled).toHaveLength(4);
    expect((await sched()).every((x) => x.status === 'cancelled')).toBe(true);
    expect(triple(await dom())).toEqual([199500, 129500, 96000]);
  });

  it('PR-28: a row that violates floor_min fails; domain unchanged; audit 422', async () => {
    await setup();
    await db.updateTable('price_schedule').set({ floor_cents: 70000, walkaway_cents: 60000 }).where('event', '=', 'drop1_m6').execute();
    const before = await dom();
    const r = await job().runOnce({ today: '2027-04-12' });
    expect(r.failed).toHaveLength(1);
    const row = (await sched()).find((x) => x.event === 'drop1_m6')!;
    expect(row.status).toBe('failed');
    expect(row.note).toBeTruthy();
    expect(triple(await dom())).toEqual(triple(before));
    expect(await hist()).toHaveLength(0);
    expect((await jobAudits()).map((a) => a.status_code)).toEqual([422]);
  });

  it('PR-29: scheduled change carries no approval; a manual /list change within the rules needs none either', async () => {
    const { list } = await setup();
    await job().runOnce({ today: '2027-04-12' });
    expect((await hist())[0]!.approval_text).toBeNull();
    const res = await list({ mode: 'hybrid', bin: 2495 });
    expect(res.statusCode).toBe(200);
  });

  it('dry run reports but writes nothing', async () => {
    await setup();
    const before = await dom();
    const rowsBefore = await sched();
    const r = await job().runOnce({ today: '2027-04-12', dryRun: true });
    expect(r.applied).toHaveLength(1);
    expect(await dom()).toEqual(before);
    expect(await sched()).toEqual(rowsBefore);
    expect(await jobAudits()).toHaveLength(0);
    expect(await hist()).toHaveLength(0);
  });

  it('geo strong: M12 drops 499 to 399 across bin, floor, min offer and walk-away', async () => {
    await setup({ mode: 'bin', bin: 499, price_grade: 'strong', approval_ref: approval() }, { category: 'geo', price_grade: 'weaker' });
    const r = await job().runOnce({ today: '2027-10-12' });
    expect(r.applied.map((a) => a.event)).toEqual(['geo_drop_m12']);
    expect(await dom()).toMatchObject({ bin_cents: 39900, floor_cents: 39900, walkaway_cents: 39900, min_offer_cents: 39900 });
  });

  it('fallback: invalid newest due row fails, the newest valid row applies', async () => {
    const { list } = await setup();
    await list({ pricing_hold: true, pricing_hold_reason: 'talks', approval_ref: approval() });
    await job().runOnce({ today: '2028-04-20' });
    await list({ pricing_hold: false, approval_ref: approval() });
    await db.updateTable('price_schedule').set({ floor_cents: 70000, walkaway_cents: 60000 }).where('event', '=', 'drop2_m18').execute();
    const r = await job().runOnce({ today: '2028-04-20' });
    expect(r.failed).toHaveLength(1);
    expect(r.applied.map((a) => a.event)).toEqual(['drop1_m6']);
    expect(triple(await dom())).toEqual([159500, 103500, 77000]);
    const rows = await sched();
    expect(rows.find((x) => x.event === 'drop2_m18')!.status).toBe('failed');
    expect(rows.find((x) => x.event === 'drop1_m6')!.status).toBe('applied');
    expect(await hist()).toHaveLength(1);
    expect((await jobAudits()).map((a) => a.status_code).sort()).toEqual([200, 422]);
  });

  it('no valid due row: every due row fails and nothing applies', async () => {
    await setup();
    await db.updateTable('price_schedule').set({ floor_cents: 70000, walkaway_cents: 60000 }).where('event', '=', 'drop1_m6').execute();
    const r = await job().runOnce({ today: '2027-04-12' });
    expect(r.applied).toEqual([]);
    expect(r.failed).toHaveLength(1);
  });

  it('per-domain isolation: a locked domain errors with a 500 audit row; the other domain applies', async () => {
    const { list } = await setup();
    const E = 'examplecityplumbing.com';
    await insertOwnedDomain(db, { domain: E, category: 'trend', price_grade: null });
    const { auth } = await issueToken('write');
    const r0 = await app.inject({ method: 'POST', url: `/list/${E}`, headers: { ...auth, 'idempotency-key': randomUUID() },
      payload: { mode: 'hybrid', bin: 1995, approval_ref: { text: `yes list ${E}`, approved_at: new Date(NOW - 3_600_000).toISOString() } } });
    expect(r0.statusCode).toBe(200);
    void list;
    const j = new PriceScheduleJob({ db, now: () => NOW, lockTimeoutMs: 100 });
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => { locked = r; });
    const holder = withDomainLock(db, D, async () => { locked(); await held; });
    await lockedP;
    const r = await j.runOnce({ today: '2027-04-12' });
    release();
    await holder;
    expect(r.applied.map((a) => a.domain)).toEqual([E]);
    expect(r.failed).toEqual([{ domain: D, rowId: 0, reason: 'error' }]);
    const a = (await jobAudits()).filter((x) => x.status_code === 500);
    expect(a).toHaveLength(1);
    expect(a[0]!.result_summary).toMatch(/^error: /);
    expect(triple(await dom())).toEqual([199500, 129500, 96000]);
  });

  it('stray other-plan planned row is superseded and reported once', async () => {
    await setup();
    const d = await dom();
    await db.insertInto('price_schedule').values({ domain_id: d.id, plan_id: 'pl_stray', event: 'drop1_m6', due_on: '2027-04-01', bin_cents: 100000, floor_cents: 80000, walkaway_cents: 60000, settings_version: 2, status: 'planned' }).execute();
    const r = await job().runOnce({ today: '2027-04-12' });
    const stray = (await sched()).find((x) => x.plan_id === 'pl_stray')!;
    expect(stray.status).toBe('superseded');
    expect(r.superseded.filter((id) => id === stray.id)).toHaveLength(1);
    expect(r.applied).toHaveLength(1);
  });

  it('dropped domain: planned rows cancelled', async () => {
    await setup();
    await db.updateTable('domains').set({ status: 'dropped' }).where('domain', '=', D).execute();
    const r = await job().runOnce({ today: '2027-04-12' });
    expect(r.cancelled).toHaveLength(4);
    expect((await sched()).every((x) => x.status === 'cancelled')).toBe(true);
  });

  it('dry run on a due delist reports it and writes nothing', async () => {
    await setup();
    const rowsBefore = await sched();
    const before = await dom();
    const r = await job().runOnce({ today: '2028-09-27', dryRun: true });
    expect(r.delisted).toEqual([D]);
    expect(await dom()).toEqual(before);
    expect(await sched()).toEqual(rowsBefore);
    expect(await jobAudits()).toHaveLength(0);
  });

  it('default today uses the Jerusalem date of now', async () => {
    await setup();
    const j = new PriceScheduleJob({ db, now: () => Date.parse('2027-04-11T22:30:00Z') });
    const r = await j.runOnce();
    expect(r.today).toBe('2027-04-12');
    expect(r.applied.map((a) => a.event)).toEqual(['drop1_m6']);
  });
});
