// v5.46.0: the unsold feed for closeout names that stayed to their end date (closeout_expiries, step buildPanel, engineFeed). RDAP is a stub; nothing calls the network.
import { rm } from 'node:fs/promises';
import { sql } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RdapLookup, RdapLookupFn } from '../../../src/core/rdap.js';
import { loadConfig } from '../../../src/config.js';
import { loadRegimeTest } from '../../../src/modules/engine/index.js';
import { checkExpiries, expiryTagOf, md5Of } from '../../../src/modules/ops/closeouts/expiries.js';
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
const run = async (answers: Record<string, RdapLookup>, o: { now?: number; capLeft?: number; all?: boolean; none?: boolean } = {}) => {
  const m = mk(answers, o.now ?? NOW);
  const regime = o.none ? undefined : o.all ? () => true : await loadRegimeTest(db);
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

describe('ST547 closeout expiries storage (v5.47.0, F19)', () => {
  const put = (domain: string, o: Partial<{ tag: 'pending' | 'dropped' | 'held' | 'unknown'; final: boolean; attempts: number; fed_at: Date | null; rdap_checked_at: Date | null; ends_at: string }> = {}) => {
    const ends = o.ends_at ?? '2026-10-01T10:00:00Z';
    return db.insertInto('closeout_expiries').values({ domain, ends_at: new Date(ends), ends_on: ends.slice(0, 10), first_seen_on: '2026-10-02', tag: o.tag ?? 'pending', final: o.final ?? false, attempts: o.attempts ?? 0, fed_at: o.fed_at ?? null, rdap_checked_at: o.rdap_checked_at ?? null }).execute();
  };

  it('ST547-1 without a regime test nothing is collected (the 25 Oct first run stored every pool name)', async () => {
    await pool('septicdrone.com');
    await pool('zzqqxx.com');
    const a = await run({}, { none: true });
    expect(a.s).toMatchObject({ collected_n: 0, regime_loaded: false });
    expect(await rows()).toHaveLength(0);
    expect((await run({})).s).toMatchObject({ collected_n: 1, regime_loaded: true });
  });

  it('ST547-2 never-asked rows of names outside the regime are deleted by the next run; a row that was asked, or is in the regime, stays', async () => {
    await put('zzqqxx.com');                       // out of the regime, never asked: deleted
    await put('septicdrone.com');                  // in the regime: stays
    await put('qqzzxx.com', { attempts: 2, tag: 'dropped', final: true }); // out of the regime but already asked: stays (its answer may feed the engine)
    const r = await run({});
    expect(r.s.out_of_regime_deleted_n).toBe(1);
    expect((await rows()).map((x) => x.domain)).toEqual(['qqzzxx.com', 'septicdrone.com']);
  });

  it('ST547-3 decided rows go after the short keep: fed dropped rows 7 days after feeding, held and unknown rows 7 days after the decision; open rows and younger rows stay', async () => {
    const t = (days: number) => new Date(NOW - days * DAY);
    await put('oldfed.com', { tag: 'dropped', final: true, attempts: 1, fed_at: t(8), rdap_checked_at: t(9) });
    await put('newfed.com', { tag: 'dropped', final: true, attempts: 1, fed_at: t(3), rdap_checked_at: t(4) });
    await put('unfed.com', { tag: 'dropped', final: true, attempts: 1, fed_at: null, rdap_checked_at: t(30) }); // not fed yet: never deleted
    await put('oldheld.com', { tag: 'held', final: true, attempts: 1, rdap_checked_at: t(8) });
    await put('newheld.com', { tag: 'held', final: true, attempts: 1, rdap_checked_at: t(2) });
    await put('oldunknown.com', { tag: 'unknown', final: true, attempts: 3, rdap_checked_at: t(10) });
    await put('openname.com', { attempts: 1, rdap_checked_at: t(40) });
    const r = await run({});
    expect(r.s.decided_deleted_n).toBe(3);
    expect((await rows()).map((x) => x.domain)).toEqual(['newfed.com', 'newheld.com', 'openname.com', 'unfed.com']);
  });

  it('ST547-4 a fed name that is still in the pool is not collected again after its row was deleted (the keep is at least the pool keep + 1 day)', async () => {
    const s = await db.selectFrom('settings').select(['closeout_expiry_keep_days', 'datasave_pool_keep_days']).executeTakeFirstOrThrow();
    expect(s.closeout_expiry_keep_days).toBe(7);
    expect(s.closeout_expiry_keep_days).toBeGreaterThan(s.datasave_pool_keep_days);
    await pool('septicdrone.com');
    await run({ 'septicdrone.com': free }, { now: NOW + 4 * DAY });
    await db.updateTable('closeout_expiries').set({ fed_at: new Date(NOW - 8 * DAY) }).execute();
    const again = await run({}, { now: NOW + 4 * DAY });
    expect(again.s.decided_deleted_n).toBe(1);
    await db.deleteFrom('datasave_pool').execute(); // the pool keeps only a few days: the name is gone from it when its row goes
    expect((await run({}, { now: NOW + 5 * DAY })).s.collected_n).toBe(0);
  });
});

describe('AS549 closeout expiries storage (v5.49.0, P1)', () => {
  it('AS549-7: the migration state: collect_max 1000, pool keep 2 days, renewal default 2300 (column default and value), the unused datasave_pool (source, domain) index is gone', async () => {
    const s = await db.selectFrom('settings').select(['closeout_expiry_collect_max', 'datasave_pool_keep_days']).executeTakeFirstOrThrow();
    expect(s).toEqual({ closeout_expiry_collect_max: 1000, datasave_pool_keep_days: 2 });
    const def = await sql<{ d: string; t: string }>`select column_default as d, table_name as t from information_schema.columns where table_name = 'settings' and column_name in ('shortlist_renewal_cents', 'datasave_pool_keep_days') order by column_name`.execute(db);
    expect(def.rows.map((r) => r.d)).toEqual(['2', '2300']);
    const idx = await sql<{ indexname: string }>`select indexname from pg_indexes where tablename = 'datasave_pool'`.execute(db);
    expect(idx.rows.map((r) => r.indexname)).toEqual(['datasave_pool_pkey']);
  });

  it('AS549-8: collect adds at most closeout_expiry_collect_max NEW names a run, the smallest md5(domain) first; the next run takes the next ones (names already stored are not counted)', async () => {
    const names = Array.from({ length: 12 }, (_, i) => `sample${i}name.com`);
    for (const n of names) await pool(n);
    await sql`update settings set closeout_expiry_collect_max = 3`.execute(db);
    try {
      const sorted = [...names].sort((a, b) => (md5Of(a) < md5Of(b) ? -1 : 1));
      const a = await run({}, { all: true });
      expect(a.s).toMatchObject({ collected_n: 3, sample_max: 3, eligible_new_n: 12 });
      expect((await rows()).map((r) => r.domain).sort()).toEqual(sorted.slice(0, 3).sort());
      const b = await run({}, { all: true });
      expect(b.s).toMatchObject({ collected_n: 3, eligible_new_n: 9 });
      expect((await rows()).map((r) => r.domain).sort()).toEqual(sorted.slice(0, 6).sort());
      // the md5 of the code is the md5 of Postgres
      const pg = (await sql<{ m: string }>`select md5(${names[0]!}) as m`.execute(db)).rows[0]!.m;
      expect(md5Of(names[0]!)).toBe(pg);
    } finally { await sql`update settings set closeout_expiry_collect_max = 1000`.execute(db); }
  });

  it('AS549-9: never-checked open rows whose end date is older than closeout_expiry_max_days are deleted (stale_deleted_n); a checked row and a recent row stay', async () => {
    const ins = (domain: string, endsOn: string, attempts: number) => sql`insert into closeout_expiries (domain, ends_at, ends_on, first_seen_on, attempts) values (${domain}, ${new Date(`${endsOn}T10:00:00Z`)}, ${endsOn}::date, ${endsOn}::date, ${attempts})`.execute(db);
    await ins('oldnever.com', '2026-07-01', 0); // 111 days before the 20 Oct "today": past the 80-day window
    await ins('oldchecked.com', '2026-07-01', 2);
    await ins('recent.com', '2026-10-10', 0);
    const r = await run({}, { none: true });
    expect(r.s.stale_deleted_n).toBe(1);
    expect((await rows()).map((x) => x.domain).sort()).toEqual(['oldchecked.com', 'recent.com']);
  });
});
