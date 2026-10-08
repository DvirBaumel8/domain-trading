import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { dropAtFirstExpiry } from '../../src/modules/ops/admin/drop-date.js';
import { PriceScheduleJob } from '../../src/modules/ops/jobs/price-schedule.js';
import { makeApp } from '../helpers/app.js';
import { insertOwnedDomain, testDb as db } from '../helpers/db.js';
import { testEnv } from '../helpers/env.js';
import { FakeAdapter } from '../helpers/fake-adapter.js';
import { issueToken } from '../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const D = 'examplecityroofing.com';
const LIST_AT = Date.parse('2026-10-12T09:00:00Z');
const NOW = new Date('2026-10-20T09:00:00Z');
const APPROVAL = { domain: D, approvalText: 'yes drop examplecityroofing.com at first expiry', approvalAt: '2026-10-20T08:00:00Z', now: NOW };
const dom = () => db.selectFrom('domains').selectAll().where('domain', '=', D).executeTakeFirstOrThrow();
const rows = () => db.selectFrom('price_schedule').selectAll().orderBy('id').execute();
const view = (r: Awaited<ReturnType<typeof rows>>) => r.map((e) => [e.event, e.due_on, e.bin_cents, e.floor_cents, e.walkaway_cents, e.status]);

async function d001() {
  app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => LIST_AT });
  const { auth } = await issueToken('write');
  await insertOwnedDomain(db, { domain: D, category: 'trend', price_grade: null });
  const res = await app.inject({
    method: 'POST', url: `/list/${D}`, headers: { ...auth, 'idempotency-key': randomUUID() },
    payload: {
      mode: 'hybrid', bin: 1995, floor: 1295, walkaway: 950, pricing_exception: true, pricing_exception_reason: 'D-001 approved plan',
      approval_ref: { text: `yes list ${D}`, approved_at: new Date(LIST_AT - 3_600_000).toISOString() },
    },
  });
  expect(res.statusCode).toBe(200);
}

describe('admin drop-at-first-expiry', () => {
  it('a delisted domain only gets drop_date + audit: no schedule is regenerated (schedule null)', async () => {
    await insertOwnedDomain(db, { domain: D, status: 'delisted', category: 'trend', price_grade: null });
    const r = await dropAtFirstExpiry(db, APPROVAL);
    expect(r).toMatchObject({ dropDate: '2027-10-04', schedule: null });
    expect(await dom()).toMatchObject({ drop_date: '2027-10-04', plan_id: null });
    expect(await rows()).toHaveLength(0);
    expect(await db.selectFrom('audit_log').selectAll().where('path', '=', 'drop-at-first-expiry').execute()).toHaveLength(1);
  });

  it('PR-25 / ADM-1: D-001-like listing regenerates final push and delist', async () => {
    await d001();
    const oldIds = (await rows()).map((r) => r.id);
    const r = await dropAtFirstExpiry(db, APPROVAL);
    expect(r.dropDate).toBe('2027-10-04');
    const d = await dom();
    expect(d.drop_date).toBe('2027-10-04');
    const all = await rows();
    expect(view(all.filter((x) => x.status !== 'superseded'))).toEqual([
      ['drop1_m6', '2027-04-12', 159500, 103500, 76000, 'planned'],
      ['drop2_m18', '2028-04-12', null, null, null, 'superseded_by_final_push'],
      ['final_push', '2027-07-06', 109500, 103500, 76000, 'planned'],
      ['delist', '2027-09-27', null, null, null, 'planned'],
    ]);
    expect(all.filter((x) => oldIds.includes(x.id)).every((x) => x.status === 'superseded')).toBe(true);
    expect(r.schedule).toHaveLength(4);
    expect(d.plan_id).toBe(all.find((x) => !oldIds.includes(x.id))!.plan_id);
    const audit = await db.selectFrom('audit_log').selectAll().where('scope', '=', 'admin').where('path', '=', 'drop-at-first-expiry').executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ approval_text: APPROVAL.approvalText, approval_at: new Date(APPROVAL.approvalAt), method: 'ADMIN' });
    expect(d.plan_audit_id).toBe(audit.id);
    expect(JSON.parse(JSON.stringify(audit.request))).toEqual({ domain: D, from: '2028-10-04', to: '2027-10-04' });
  });

  it('an owned domain without a plan only moves drop_date', async () => {
    await insertOwnedDomain(db, { domain: D });
    const r = await dropAtFirstExpiry(db, APPROVAL);
    expect(r.schedule).toBeNull();
    expect((await dom()).drop_date).toBe('2027-10-04');
  });

  it('ADM-2: refusals change nothing', async () => {
    await insertOwnedDomain(db, { domain: D });
    await db.updateTable('domains').set({ renewals_used: 1, expiry_date: '2028-10-04', drop_date: '2029-10-04' }).execute();
    await expect(dropAtFirstExpiry(db, APPROVAL)).rejects.toMatchObject({ code: 'MAX_ONE_RENEWAL_USED' });
    expect((await dom()).drop_date).toBe('2029-10-04');
    await db.updateTable('domains').set({ renewals_used: 0, expiry_date: '2027-10-04', drop_date: '2028-10-04', status: 'sold', sold_at: new Date('2026-12-01T00:00:00Z') }).execute();
    await expect(dropAtFirstExpiry(db, APPROVAL)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect((await dom()).drop_date).toBe('2028-10-04');
    await db.updateTable('domains').set({ status: 'owned', sold_at: null }).execute();
    await dropAtFirstExpiry(db, APPROVAL);
    await expect(dropAtFirstExpiry(db, APPROVAL)).rejects.toMatchObject({ code: 'NO_CHANGE' });
    await expect(dropAtFirstExpiry(db, { ...APPROVAL, approvalAt: '2026-10-21T00:00:00Z' })).rejects.toThrow(/future/);
    await expect(dropAtFirstExpiry(db, { ...APPROVAL, approvalText: ' ' })).rejects.toThrow();
    expect(await db.selectFrom('audit_log').select('id').where('path', '=', 'drop-at-first-expiry').execute()).toHaveLength(1);
  });

  it('ADM-2 CLI: --approval-at in the future exits 2, nothing changed', async () => {
    await insertOwnedDomain(db, { domain: D });
    const run = promisify(execFile);
    await expect(run('npx', ['tsx', 'src/modules/ops/admin.ts', 'drop-at-first-expiry', '--domain', D, '--approval-text', 'yes', '--approval-at', '2999-01-01T00:00:00Z'],
      { env: { ...process.env, ...testEnv() } })).rejects.toMatchObject({ code: 2 });
    expect((await dom()).drop_date).toBe('2028-10-04');
  });

  it('ADM-3: the DB CHECK accepts drop_date = expiry_date and rejects expiry + 2 years', async () => {
    await insertOwnedDomain(db, { domain: D });
    await db.updateTable('domains').set({ drop_date: '2027-10-04' }).execute();
    await expect(db.updateTable('domains').set({ drop_date: '2029-10-04' }).execute()).rejects.toThrow(/domains_drop_date_rule/);
  });

  const LATE = new Date('2027-05-01T09:00:00Z');
  const FIN = [
    ['drop1_m6', '2027-04-12', 159500, 103500, 76000, 'planned'],
    ['drop2_m18', '2028-04-12', null, null, null, 'superseded_by_final_push'],
    ['final_push', '2027-07-06', 109500, 103500, 76000, 'planned'],
    ['delist', '2027-09-27', null, null, null, 'planned'],
  ];

  it('fix 1a: a due but unapplied M6 (hold) is regenerated as planned, not lost', async () => {
    await d001();
    await db.updateTable('domains').set({ pricing_hold: true, pricing_hold_reason: 'talks' }).execute();
    await dropAtFirstExpiry(db, { ...APPROVAL, now: LATE });
    expect(view((await rows()).filter((x) => x.status !== 'superseded'))).toEqual(FIN);
  });

  it('fix 1b: an applied M6 is not regenerated; the final push comes from the post-M6 values', async () => {
    await d001();
    await new PriceScheduleJob({ db, now: () => LATE.getTime() }).runOnce({ today: '2027-05-01' });
    await dropAtFirstExpiry(db, { ...APPROVAL, now: LATE });
    const live = (await rows()).filter((x) => x.status !== 'superseded');
    expect(view(live)).toEqual([
      ['drop1_m6', '2027-04-12', 159500, 103500, 76000, 'applied'],
      ['drop2_m18', '2028-04-12', null, null, null, 'superseded_by_final_push'],
      ['final_push', '2027-07-06', 109500, 103500, 76000, 'planned'],
      ['delist', '2027-09-27', null, null, null, 'planned'],
    ]);
  });

  it('fix 3: a first expiry already in the past warns DROP_DATE_IN_PAST', async () => {
    await insertOwnedDomain(db, { domain: D });
    const r = await dropAtFirstExpiry(db, { ...APPROVAL, now: new Date('2027-11-01T09:00:00Z'), approvalAt: '2027-11-01T08:00:00Z' });
    expect(r.warnings).toEqual(['DROP_DATE_IN_PAST: the next daily run will mark it dropped']);
    const ok = await dropAtFirstExpiry(db, APPROVAL).catch((e) => e);
    expect(ok.code).toBe('NO_CHANGE');
  });
});
