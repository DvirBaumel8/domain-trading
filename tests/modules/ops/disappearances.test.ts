// v5.34.0 (BUG-052): RDAP tags for closeout names gone before their end and for DISAPPEARED market episodes (closeouts/disappearances.ts, via buildPanel).
// RDAP is a stub per name; nothing calls the network.
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RdapLookup, RdapLookupFn } from '../../../src/core/rdap.js';
import { tagOf } from '../../../src/modules/ops/closeouts/disappearances.js';
import { DatasaveJob } from '../../../src/modules/ops/jobs/datasave/datasave.js';
import { makeApp } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { issueToken } from '../../helpers/tokens.js';

const NOW = Date.parse('2026-10-20T15:30:00Z');
const DAY = 86_400_000;
let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

const reg = (registrar: string | null, statuses: string[], created = '2019-05-01T00:00:00Z'): RdapLookup => ({
  outcome: 'registered', reasonCode: null, httpStatus: 200, url: '', retrievedAt: new Date(NOW), body: null,
  facts: { registrar, created_at: created, expires_at: null, updated_at: null, statuses, nameservers: [] },
});
const free: RdapLookup = { outcome: 'not_registered', reasonCode: null, httpStatus: 404, url: '', retrievedAt: new Date(NOW), body: null, facts: null };
const fail = (reasonCode: RdapLookup['reasonCode']): RdapLookup => ({ outcome: 'unknown', reasonCode, httpStatus: null, url: '', retrievedAt: new Date(NOW), body: null, facts: null });

/** A job whose RDAP answers come from `answers` (an unlisted name times out); `calls` records every live lookup. */
const setup = (answers: Record<string, RdapLookup>) => {
  const calls: string[] = [];
  const rdap: RdapLookupFn = async (d) => { calls.push(d); return answers[d] ?? fail('TIMEOUT'); };
  let clock = NOW;
  const job = new DatasaveJob({ db, now: () => clock, snapshotDir: '/nonexistent', rdap, sleep: async () => {} });
  return { job, calls, setClock: (ms: number) => { clock = ms; } };
};
/** Closeout names on 10-19 that are all gone on 10-20 before their end (10-21). */
const goneGodaddy = async (names: string[]) => {
  const row = (d: string, domain: string) => ({ data_date: d, source: 'godaddy_closeouts', domain, price_cents: 1500, ends_at: new Date('2026-10-21T10:00:00Z') });
  await db.insertInto('datasave_pool').values([...names.map((n) => row('2026-10-19', n)), row('2026-10-19', 'stays.com'), row('2026-10-20', 'stays.com')]).execute();
};
const tagRow = (domain: string) => db.selectFrom('disappearances').selectAll().where('domain', '=', domain).executeTakeFirstOrThrow();

describe('BG052 disappearance tags', () => {
  it('BG052-1 (AT-1) a gone closeout name in redemptionPeriod is deleted, tag_reason names the status', async () => {
    await goneGodaddy(['redeem.com']);
    const { job } = setup({ 'redeem.com': reg('GoDaddy.com, LLC', ['redemptionPeriod']) });
    const p = await job.buildPanel() as Record<string, unknown>;
    expect(p).toMatchObject({ gone_before_end_n: 1, gone_deleted_n: 1, gone_bought_n: 0, gone_unknown_n: 0 });
    expect(await tagRow('redeem.com')).toMatchObject({ source: 'godaddy_closeouts', gone_date: '2026-10-20', prev_date: '2026-10-19', tag: 'deleted', tag_reason: 'STATUS:redemptionPeriod', final: true, baseline_source: 'feed', rdap_registrar: 'GoDaddy.com, LLC' });
  });

  it('BG052-2 (AT-2) pendingDelete and "pending delete" are deleted; a 404 is deleted (NOT_REGISTERED)', async () => {
    await goneGodaddy(['pd1.com', 'pd2.com', 'gone404.com']);
    const { job } = setup({ 'pd1.com': reg('GoDaddy.com, LLC', ['pendingDelete']), 'pd2.com': reg('GoDaddy.com, LLC', ['client hold', 'pending delete']), 'gone404.com': free });
    expect(await job.buildPanel()).toMatchObject({ gone_before_end_n: 3, gone_deleted_n: 3 });
    expect(await tagRow('pd1.com')).toMatchObject({ tag: 'deleted', tag_reason: 'STATUS:pendingDelete' });
    expect(await tagRow('pd2.com')).toMatchObject({ tag: 'deleted', tag_reason: 'STATUS:pending delete' });
    expect(await tagRow('gone404.com')).toMatchObject({ tag: 'deleted', tag_reason: 'NOT_REGISTERED' });
  });

  it('BG052-3 (AT-3) a registrar outside the baseline with an active status is bought; a baseline read from rdap_cache before the name left is used', async () => {
    await goneGodaddy(['moved.com', 'cached.com']);
    await db.insertInto('rdap_cache').values({ domain: 'cached.com', registered: true, created: null, expires: null, registrar: 'Wild West Domains, LLC', statuses: [], nameservers: [], updated_at: null, checked_at: new Date('2026-10-18T12:00:00Z'), reason_code: null }).execute();
    const { job } = setup({ 'moved.com': reg('NameCheap, Inc.', ['clientTransferProhibited']), 'cached.com': reg('GoDaddy.com, LLC', ['active']) });
    expect(await job.buildPanel()).toMatchObject({ gone_before_end_n: 2, gone_bought_n: 2 });
    expect(await tagRow('moved.com')).toMatchObject({ tag: 'bought', tag_reason: 'REGISTRAR_CHANGED:GoDaddy -> NameCheap, Inc.', baseline_source: 'feed', final: true });
    expect(await tagRow('cached.com')).toMatchObject({ tag: 'bought', baseline_registrar: 'Wild West Domains, LLC', baseline_source: 'rdap_cache' });
  });

  it('BG052-4 (AT-4) same registrar (or the feed registrar\'s family), active status, no owner change: unknown, never bought; a later run checks it again', async () => {
    await goneGodaddy(['same.com', 'family.com']);
    const { job, calls, setClock } = setup({ 'same.com': reg('GoDaddy.com, LLC', ['active']), 'family.com': reg('Wild West Domains, LLC', ['clientTransferProhibited']) });
    expect(await job.buildPanel()).toMatchObject({ gone_before_end_n: 2, gone_unknown_n: 2, gone_bought_n: 0 });
    expect(await tagRow('same.com')).toMatchObject({ tag: 'unknown', tag_reason: 'SAME_REGISTRAR', final: false });
    expect(await tagRow('family.com')).toMatchObject({ tag: 'unknown', tag_reason: 'SAME_REGISTRAR' });
    setClock(NOW + DAY);
    await sql`delete from rdap_cache`.execute(db);
    await job.buildPanel();
    expect(calls.filter((c) => c === 'same.com')).toHaveLength(2);
  });

  it('BG052-5 (AT-5) timeout, 5xx and the per-run cap leave unknown with the step ok; retried on later days up to 7 days after the first check, then final; a 429 stops the run', async () => {
    await goneGodaddy(['t1.com', 'e5.com', 'zcapped.com']);
    await sql`update settings set disappearance_lookups_max_per_run = 2`.execute(db);
    const { job, calls, setClock } = setup({ 'e5.com': fail('SOURCE_ERROR') });
    const p = await job.buildPanel() as { tags: Record<string, unknown>; gone_unknown_n: number };
    expect(p.gone_unknown_n).toBe(3);
    expect(p.tags).toMatchObject({ status: 'stopped', stopped_reason: 'CAP', lookups_n: 2, unknown_n: 2, eligible_n: 3, cap: 2 });
    expect(await tagRow('zcapped.com')).toMatchObject({ tag: 'unknown', tag_reason: 'NOT_CHECKED', attempts: 0 });
    expect(await tagRow('e5.com')).toMatchObject({ tag: 'unknown', tag_reason: 'SOURCE_ERROR', final: false, attempts: 1 });
    // same day: nothing checked twice
    const again = await job.buildPanel() as { tags: Record<string, unknown> };
    expect(again.tags).toMatchObject({ lookups_n: 1, eligible_n: 1 });
    expect(calls).toEqual(['e5.com', 't1.com', 'zcapped.com']);
    // 7 days after the first check the error is final
    await sql`update settings set disappearance_lookups_max_per_run = 100`.execute(db);
    setClock(NOW + 7 * DAY);
    await job.buildPanel();
    expect(await tagRow('e5.com')).toMatchObject({ tag: 'unknown', final: true });
    // a 429 stops the run
    await db.deleteFrom('disappearances').execute();
    const r429 = setup({ 'e5.com': fail('RATE_LIMITED') });
    const s = await r429.job.buildPanel() as { tags: Record<string, unknown> };
    expect(s.tags).toMatchObject({ status: 'stopped', stopped_reason: 'RATE_LIMITED', lookups_n: 1 });
  });

  it('BG052-6 (AT-6) the first run tags every stored past day pair (backfill); 3 readable + 2 unreadable -> retagged 3, unknown 2; a second run changes nothing', async () => {
    const row = (d: string, domain: string) => ({ data_date: d, source: 'godaddy_closeouts', domain, price_cents: 1500, ends_at: new Date('2026-10-25T10:00:00Z') });
    await db.insertInto('datasave_pool').values([
      row('2026-10-18', 'a.com'), row('2026-10-18', 'b.com'), row('2026-10-18', 'x.com'), row('2026-10-18', 'keep.com'),
      row('2026-10-19', 'c.com'), row('2026-10-19', 'y.com'), row('2026-10-19', 'keep.com'),
      row('2026-10-20', 'keep.com'),
    ]).execute();
    const { job } = setup({ 'a.com': free, 'b.com': reg('GoDaddy.com, LLC', ['redemptionPeriod']), 'c.com': reg('Dynadot Inc', ['ok']) });
    const p = await job.buildPanel() as { tags: Record<string, unknown> };
    expect(p.tags).toMatchObject({ inserted: { godaddy_closeouts: 5 }, eligible_n: 5, retagged_n: 3, bought_n: 1, deleted_n: 2, unknown_n: 2 });
    const before = await db.selectFrom('disappearances').selectAll().orderBy('domain').execute();
    expect(before.map((r) => [r.domain, r.gone_date, r.tag])).toEqual([['a.com', '2026-10-19', 'deleted'], ['b.com', '2026-10-19', 'deleted'], ['c.com', '2026-10-20', 'bought'], ['x.com', '2026-10-19', 'unknown'], ['y.com', '2026-10-20', 'unknown']]);
    const second = await job.buildPanel() as { tags: Record<string, unknown> };
    expect(second.tags).toMatchObject({ inserted: { godaddy_closeouts: 0 }, eligible_n: 0, lookups_n: 0, retagged_n: 0 });
    expect(await db.selectFrom('disappearances').selectAll().orderBy('domain').execute()).toEqual(before);
  });

  it('BG052-7 (AT-7) buildPanel splits gone_before_end_n by tag (also for sealed Dynadot uploads) and /market/episodes shows disappearance_tag on DISAPPEARED rows', async () => {
    await goneGodaddy(['gd1.com', 'gd2.com', 'gd3.com']);
    for (const d of ['2026-10-19', '2026-10-20']) {
      await db.insertInto('snapshot_manifests').values({ source: 'dynadot_closeouts', data_date: d, file_name: 'bot_upload', status: 'complete', sha256: d.replace(/-/g, '').padEnd(64, 'c'), rows: 1, sealed_at: new Date(`${d}T14:00:00Z`), origin: 'bot_upload' }).execute();
    }
    await db.insertInto('dynadot_rows').values([
      { data_date: '2026-10-19', kind: 'closeouts', domain: 'dy1.com', listing_id: null, price_cents: 900, ends_at: new Date('2026-10-22T00:00:00Z') },
      { data_date: '2026-10-19', kind: 'closeouts', domain: 'dyk.com', listing_id: null, price_cents: 900, ends_at: new Date('2026-10-22T00:00:00Z') },
      { data_date: '2026-10-20', kind: 'closeouts', domain: 'dyk.com', listing_id: null, price_cents: 900, ends_at: new Date('2026-10-22T00:00:00Z') },
    ]).execute();
    const ep = (id: string, name: string, rule: string) => ({
      episode_id: id.padEnd(40, '0'), name, sld: name.split('.')[0]!, tld: 'com', venue: 'dynadot', listing_type: 'bin' as const, list_price_cents_first: 90000, list_price_cents_last: 90000, price_changes: 0,
      first_seen: '2026-09-01', last_seen: '2026-10-01', days_listed: 30, seen_days: 5, sale_only: false, outcome: 'unknown' as const, outcome_rule: rule, sale_price_cents: null, sale_date: null,
      source: 'dynadot_aftermarket', source_url: null, source_sha256: null, tier: 'B' as const, dup_group: null, dup_sources: null, price_band: '500-999' as const, sale_id: null,
    });
    await db.insertInto('market_names').values([ep('a1', 'epgone.com', 'DISAPPEARED'), ep('b2', 'eplive.com', 'TOO_SHORT')]).execute();
    const { job } = setup({ 'gd1.com': free, 'gd2.com': reg('Tucows', ['ok']), 'dy1.com': reg('Dynadot Inc', ['pendingDelete']), 'epgone.com': free });
    const p = await job.buildPanel() as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(p).toMatchObject({ gone_before_end_n: 3, gone_bought_n: 1, gone_deleted_n: 1, gone_unknown_n: 1 });
    expect(p.gone_bought_n + p.gone_deleted_n + p.gone_unknown_n).toBe(p.gone_before_end_n);
    expect(p.dynadot).toEqual({ data_date: '2026-10-20', previous_date: '2026-10-19', gone_before_end_n: 1, gone_bought_n: 0, gone_deleted_n: 1, gone_unknown_n: 0 });
    expect(p.tags.inserted).toEqual({ godaddy_closeouts: 3, dynadot_closeouts: 1, market_episode: 1 });

    app = await makeApp({ testRoutes: false, now: () => NOW });
    const read = await issueToken('read');
    const r = (await app.inject({ method: 'GET', url: '/market/episodes?limit=10', headers: read.auth })).json();
    const byName = Object.fromEntries(r.rows.map((x: { name: string }) => [x.name, x]));
    expect(byName['epgone.com']).toMatchObject({ outcome_rule: 'DISAPPEARED', disappearance_tag: 'deleted', disappearance_tag_reason: 'NOT_REGISTERED' });
    expect(byName['eplive.com']).toMatchObject({ disappearance_tag: null, disappearance_tag_reason: null });
    expect(r.summary.disappeared_by_tag).toEqual({ bought: 0, deleted: 1, unknown: 0 });
  });

  it('BG052-8 tagOf: a registration created after the name was last seen is deleted; no baseline is unknown; a non-.com name is unknown without a lookup', async () => {
    expect(tagOf(reg('Tucows', ['ok'], '2026-10-20T03:00:00Z'), { registrar: 'GoDaddy', source: 'feed' }, 'godaddy_closeouts', '2026-10-19')).toEqual({ tag: 'deleted', reason: 'RE_REGISTERED' });
    expect(tagOf(reg('Tucows', ['ok']), { registrar: null, source: null }, 'market_episode', '2026-10-19')).toEqual({ tag: 'unknown', reason: 'NO_BASELINE' });
    expect(tagOf(reg(null, ['ok']), { registrar: 'GoDaddy', source: 'feed' }, 'godaddy_closeouts', '2026-10-19')).toEqual({ tag: 'unknown', reason: 'NO_REGISTRAR' });
    await goneGodaddy(['other.net']);
    const { job, calls } = setup({});
    expect(await job.buildPanel()).toMatchObject({ gone_before_end_n: 1, gone_unknown_n: 1 });
    expect(await tagRow('other.net')).toMatchObject({ tag: 'unknown', tag_reason: 'TLD_NOT_CHECKED', final: true });
    expect(calls).toEqual([]);
  });
});

describe('BK542 bulk writes: disappearance tags', () => {
  it('BK542-3 120 due names: the cache is read once, tags are written in batches, at most 4 lookups are in flight and the cap of 100 is exact', async () => {
    const names = Array.from({ length: 120 }, (_, i) => `bulk${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}.com`);
    await goneGodaddy(names);
    await sql`update settings set disappearance_lookups_max_per_run = 100`.execute(db);
    // one name has a stored answer that is newer than the day it left: no lookup
    await db.insertInto('rdap_cache').values({ domain: names[0]!, registered: false, created: null, expires: null, registrar: null, statuses: [], nameservers: [], updated_at: null, checked_at: new Date(NOW - 3_600_000), reason_code: null }).execute();
    const calls: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const rdap: RdapLookupFn = async (d) => {
      calls.push(d); inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return free;
    };
    const { collectAndTag } = await import('./disappearances-helpers.js');
    const { value, stats } = await collectAndTag(rdap, NOW);
    if (process.env.BK_LOG) (await import('node:fs')).appendFileSync(process.env.BK_LOG, `BK542-3: ${stats.queries}\n`);
    expect(value).toMatchObject({ status: 'stopped', stopped_reason: 'CAP', lookups_n: 100, cache_hits_n: 1, eligible_n: 120 });
    expect(calls).toHaveLength(100);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(stats.queries).toBeLessThan(40); // before 5.42.0: 3 or more queries per name (cache read, tag update, cache write) = about 350
    expect(await db.selectFrom('disappearances').select('domain').where('tag', '=', 'deleted').execute()).toHaveLength(101);
    expect(await db.selectFrom('disappearances').select('domain').where('attempts', '=', 0).where('tag_reason', '=', 'NOT_CHECKED').execute()).toHaveLength(19);
  });
});
