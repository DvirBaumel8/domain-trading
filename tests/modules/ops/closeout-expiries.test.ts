// v5.46.0: the unsold feed for closeout names that stayed to their end date (closeout_expiries, step buildPanel, engineFeed). RDAP is a stub; nothing calls the network.
import { rm } from 'node:fs/promises';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RdapLookup, RdapLookupFn } from '../../../src/core/rdap.js';
import { loadConfig } from '../../../src/config.js';
import { loadRegimeTest } from '../../../src/modules/engine/index.js';
import { checkExpiries, expiryTagOf } from '../../../src/modules/ops/closeouts/expiries.js';
import { DatasaveJob } from '../../../src/modules/ops/jobs/datasave/datasave.js';
import { testDb as db } from '../../helpers/db.js';
import { testEnv } from '../../helpers/env.js';

const NOW = Date.parse('2026-10-20T15:30:00Z');
const DAY = 86_400_000;
const SNAP = loadConfig(testEnv()).snapshotDir;
beforeEach(async () => { await rm(SNAP, { recursive: true, force: true }); });

const base = { reasonCode: null, httpStatus: 200, url: '', retrievedAt: new Date(NOW), body: null };
const free: RdapLookup = { ...base, outcome: 'not_registered', httpStatus: 404, facts: null };
const err: RdapLookup = { ...base, outcome: 'unknown', reasonCode: 'TIMEOUT', httpStatus: null, facts: null };
const reg = (o: { statuses?: string[]; created?: string; expires?: string | null } = {}): RdapLookup => ({
  ...base, outcome: 'registered', facts: { registrar: 'GoDaddy.com, LLC', created_at: o.created ?? '2019-05-01T00:00:00Z', expires_at: o.expires === undefined ? '2026-10-01T00:00:00Z' : o.expires, updated_at: null, statuses: o.statuses ?? ['client transfer prohibited'], nameservers: [] },
});
const ENDS = Date.parse('2026-10-15T10:00:00Z');
const ROW = { source: 'godaddy_closeouts', price_cents: 1500 };
const pool = (domain: string, ends = '2026-10-15T10:00:00Z', date = '2026-10-19') => db.insertInto('datasave_pool').values({ ...ROW, data_date: date, domain, ends_at: new Date(ends) }).execute();
const mk = (answers: Record<string, RdapLookup>, now = NOW) => {
  const calls: string[] = [];
  const rdap: RdapLookupFn = async (d) => { calls.push(d); return answers[d] ?? err; };
  return { calls, rdap, now: () => now };
};
const run = async (answers: Record<string, RdapLookup>, o: { now?: number; capLeft?: number; all?: boolean } = {}) => {
  const m = mk(answers, o.now ?? NOW);
  const regime = o.all ? undefined : await loadRegimeTest(db);
  const s = await checkExpiries({ db, now: m.now, rdap: m.rdap, sleep: async () => {}, regime, capLeft: o.capLeft ?? 1500 });
  return { s, calls: m.calls };
};
const rows = () => db.selectFrom('closeout_expiries').selectAll().orderBy('domain').execute();

describe('FX546 closeout expiries', () => {
  it('FX546-1 the rule: 404, a redemption or pending-delete status, a registration created after the end = dropped (caught only for the new registration); a renewed expiry = held; else pending, unknown at the max day', () => {
    expect(expiryTagOf(free, ENDS, 5, 80)).toEqual({ tag: 'dropped', reason: 'NOT_REGISTERED', final: true, caught: false });
    expect(expiryTagOf(reg({ statuses: ['redemptionPeriod'] }), ENDS, 40, 80)).toMatchObject({ tag: 'dropped', reason: 'STATUS:redemptionPeriod', caught: null, final: true });
    expect(expiryTagOf(reg({ statuses: ['pending delete'] }), ENDS, 40, 80)).toMatchObject({ tag: 'dropped', caught: null });
    expect(expiryTagOf(reg({ created: '2026-10-18T00:00:00Z' }), ENDS, 3, 80)).toMatchObject({ tag: 'dropped', reason: 'RE_REGISTERED', caught: true });
    expect(expiryTagOf(reg({ expires: '2027-10-15T00:00:00Z' }), ENDS, 3, 80)).toMatchObject({ tag: 'held', reason: 'RENEWED', final: true });
    expect(expiryTagOf(reg({ expires: '2026-12-01T00:00:00Z' }), ENDS, 3, 80)).toMatchObject({ tag: 'pending', final: false }); // 47 days later: not a renewal
    expect(expiryTagOf(reg(), ENDS, 3, 80)).toMatchObject({ tag: 'pending', reason: 'STILL_REGISTERED', final: false });
    expect(expiryTagOf(reg(), ENDS, 80, 80)).toMatchObject({ tag: 'unknown', final: true });
    expect(expiryTagOf(err, ENDS, 3, 80)).toMatchObject({ tag: 'pending', reason: 'TIMEOUT', final: false });
    expect(expiryTagOf(err, ENDS, 90, 80)).toMatchObject({ tag: 'unknown', final: true });
  });

  it('FX546-2 collect: in-regime .com pool names that end inside the pool window or have ended get one row (IDT end day); out-of-regime, .net names, far-future ends and a second run add nothing', async () => {
    await pool('septicdrone.com');
    await pool('zzqqxx.com');
    await pool('septicdrone.net');
    await pool('farfuture.com', '2026-12-30T10:00:00Z');
    await pool('septicdrone.com', '2026-10-15T10:00:00Z', '2026-10-18'); // the same name on an earlier stored day
    const a = await run({});
    expect(a.s.collected_n).toBe(1);
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ domain: 'septicdrone.com', ends_on: '2026-10-15', tag: 'pending', final: false });
    expect((await run({})).s.collected_n).toBe(0);
    await pool('lateend.com', '2026-10-15T22:30:00Z'); // 01:30 IDT on the 16th (not in the regime word list: no row without one)
    expect((await run({}, { all: true })).s.collected_n).toBeGreaterThanOrEqual(1);
    expect((await rows()).find((x) => x.domain === 'lateend.com')?.ends_on).toBe('2026-10-16');
  });

  it('FX546-3 checks: not asked before the wait is over; a 404 closes the row as dropped; a renewed name is held; a pending name is asked again only after the recheck days; the max day closes it unknown', async () => {
    await pool('septicdrone.com');
    await pool('roofclean.com');
    await pool('plumbhero.com');
    const early = await run({}, { now: Date.parse('2026-10-17T15:00:00Z') }); // end day 15th + 3 = the 18th: not yet
    expect(early.calls).toEqual([]);
    const first = await run({ 'septicdrone.com': free, 'roofclean.com': reg({ expires: '2027-10-15T00:00:00Z' }), 'plumbhero.com': reg() });
    expect(first.calls.sort()).toEqual(['plumbhero.com', 'roofclean.com', 'septicdrone.com']);
    expect(first.s).toMatchObject({ lookups_n: 3, dropped_n: 1, held_n: 1, pending_n: 1, open_n: 1 });
    const r = Object.fromEntries((await rows()).map((x) => [x.domain, x]));
    expect(r['septicdrone.com']).toMatchObject({ tag: 'dropped', final: true, caught: false, attempts: 1 });
    expect(r['roofclean.com']).toMatchObject({ tag: 'held', final: true });
    expect(r['plumbhero.com']).toMatchObject({ tag: 'pending', final: false, attempts: 1 });
    expect((await run({ 'plumbhero.com': reg() }, { now: NOW + 3 * DAY })).calls).toEqual([]); // 3 days later: inside the 7-day recheck
    expect((await run({ 'plumbhero.com': reg({ statuses: ['redemptionPeriod'] }) }, { now: NOW + 8 * DAY })).s).toMatchObject({ dropped_n: 1, open_n: 0 });
    await pool('stuck.com'); // never leaves: closed unknown at the max day
    await run({ 'stuck.com': reg() }, { all: true });
    await db.updateTable('closeout_expiries').set({ rdap_checked_at: new Date(NOW - 10 * DAY) }).where('domain', '=', 'stuck.com').execute();
    await run({ 'stuck.com': reg() }, { all: true, now: ENDS + 81 * DAY });
    expect((await rows()).find((x) => x.domain === 'stuck.com')).toMatchObject({ tag: 'unknown', final: true, tag_reason: 'STILL_REGISTERED_AT_MAX_DAYS' });
  });

  it('FX546-4 a name that left the list before its end (a disappearances row) is not asked here; an error answer is asked again on the next run and does not move rdap_checked_at', async () => {
    await pool('septicdrone.com');
    await pool('roofclean.com');
    await db.insertInto('disappearances').values({ source: 'godaddy_closeouts', domain: 'septicdrone.com', gone_date: '2026-10-14', prev_date: '2026-10-13', tag: 'bought', tag_reason: 'x', final: true }).execute();
    const a = await run({ 'roofclean.com': err });
    expect(a.calls).toEqual(['roofclean.com']);
    expect((await rows()).find((x) => x.domain === 'roofclean.com')).toMatchObject({ tag: 'pending', rdap_checked_at: null, tag_reason: 'TIMEOUT' });
    const b = await run({ 'roofclean.com': free });
    expect(b.calls).toEqual(['roofclean.com']);
    expect(b.s.dropped_n).toBe(1);
  });

  it('FX546-5 the shared cap: only capLeft live lookups are made (regime names first), the rest wait for the next run', async () => {
    for (const n of ['septicdrone.com', 'roofclean.com', 'plumbhero.com']) await pool(n);
    const a = await run({ 'septicdrone.com': free, 'roofclean.com': free, 'plumbhero.com': free }, { capLeft: 2 });
    expect(a.calls).toHaveLength(2);
    expect(a.s).toMatchObject({ lookups_n: 2, stopped_reason: 'CAP', status: 'stopped', dropped_n: 2 });
    const b = await run({ 'septicdrone.com': free, 'roofclean.com': free, 'plumbhero.com': free }, { capLeft: 2 });
    expect(b.calls).toHaveLength(1);
    expect(b.s.dropped_n).toBe(1);
  });

  it('FX546-6 buildPanel runs the expiry check after the tags with what is left of the cap, and engineFeed turns the dropped rows into engine_unsold (observation_date = the end day, caught from RE_REGISTERED), once', async () => {
    await pool('septicdrone.com');
    await pool('roofclean.com', '2026-10-15T22:30:00Z');
    await pool('plumbhero.com');
    await pool('zzqqxx.com');
    const answers: Record<string, RdapLookup> = { 'septicdrone.com': free, 'roofclean.com': reg({ created: '2026-10-17T00:00:00Z' }), 'plumbhero.com': reg({ expires: '2027-10-01T00:00:00Z' }) };
    const m = mk(answers);
    const job = new DatasaveJob({ db, now: m.now, snapshotDir: SNAP, rdap: m.rdap, sleep: async () => {} });
    const panel = await job.buildPanel() as { expiries: { dropped_n: number; held_n: number; caught_n: number; lookups_n: number } };
    expect(panel.expiries).toMatchObject({ dropped_n: 2, held_n: 1, caught_n: 1, lookups_n: 3 });
    const feed = await job.engineFeed() as Record<string, unknown>;
    expect(feed).toMatchObject({ expired_unsold_candidates_n: 2, expired_unsold_inserted_n: 2, unsold_candidates_n: 0 });
    const u = await db.selectFrom('engine_unsold').select(['domain', 'type', 'observation_date', 'caught_by_catcher']).orderBy('domain').execute();
    expect(u).toEqual([
      { domain: 'roofclean.com', type: 'dropped_after_held', observation_date: '2026-10-16', caught_by_catcher: true },
      { domain: 'septicdrone.com', type: 'dropped_after_held', observation_date: '2026-10-15', caught_by_catcher: false },
    ]);
    expect((await rows()).filter((x) => x.fed_at !== null).map((x) => x.domain)).toEqual(['roofclean.com', 'septicdrone.com']);
    expect(await job.engineFeed()).toMatchObject({ expired_unsold_candidates_n: 0, expired_unsold_inserted_n: 0, unsold_upload_id: null });
    expect(await db.selectFrom('engine_unsold').select('domain').execute()).toHaveLength(2);
  });
});
