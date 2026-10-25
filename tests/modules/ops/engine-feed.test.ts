// v5.41.0: the datasave step engineFeed (unsold names from the GoDaddy closeouts, sold names from GoDaddy auction endings), the regime-first RDAP cap,
// settings.datasave_auction_min_cents, and the DB size guard. RDAP is a stub; nothing calls the network.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RdapLookup, RdapLookupFn } from '../../../src/core/rdap.js';
import { loadConfig } from '../../../src/config.js';
import { loadRegimeTest } from '../../../src/modules/engine/index.js';
import { DatasaveJob } from '../../../src/modules/ops/jobs/datasave/datasave.js';
import { auctionsJson, makeZip } from '../../helpers/datasave.js';
import { testDb as db } from '../../helpers/db.js';
import { testEnv } from '../../helpers/env.js';

const NOW = Date.parse('2026-10-20T15:30:00Z');
const SNAP = loadConfig(testEnv()).snapshotDir;
beforeEach(async () => { await rm(SNAP, { recursive: true, force: true }); });

const free: RdapLookup = { outcome: 'not_registered', reasonCode: null, httpStatus: 404, url: '', retrievedAt: new Date(NOW), body: null, facts: null };
const reg = (registrar: string, statuses: string[], created = '2019-05-01T00:00:00Z'): RdapLookup => ({
  outcome: 'registered', reasonCode: null, httpStatus: 200, url: '', retrievedAt: new Date(NOW), body: null,
  facts: { registrar, created_at: created, expires_at: null, updated_at: null, statuses, nameservers: [] },
});
const mkJob = (answers: Record<string, RdapLookup> = {}, extra: Partial<ConstructorParameters<typeof DatasaveJob>[0]> = {}) => {
  const calls: string[] = [];
  const rdap: RdapLookupFn = async (d) => { calls.push(d); return answers[d] ?? { ...free, outcome: 'unknown', reasonCode: 'TIMEOUT' }; };
  return { job: new DatasaveJob({ db, now: () => NOW, snapshotDir: SNAP, rdap, sleep: async () => {}, ...extra }), calls };
};
const tagged = (domain: string, tag: 'deleted' | 'bought' | 'unknown', reason: string, o: { gone?: string; source?: string } = {}) =>
  db.insertInto('disappearances').values({ source: (o.source ?? 'godaddy_closeouts') as 'godaddy_closeouts', domain, gone_date: o.gone ?? '2026-10-20', prev_date: '2026-10-19', tag, tag_reason: reason, final: tag !== 'unknown' }).execute();
const unsold = () => db.selectFrom('engine_unsold').select(['domain', 'type', 'observation_date', 'caught_by_catcher']).orderBy('domain').execute();
const sales = () => db.selectFrom('engine_sales').select(['domain', 'price_cents', 'sale_date', 'venue', 'source', 'source_url']).orderBy('domain').execute();
const ended = (domain: string, o: { price?: number; bids?: number; end?: string; ended?: boolean } = {}) => db.insertInto('godaddy_auctions').values({
  domain, end_time: new Date(o.end ?? '2026-10-20T09:00:00Z'), auction_type: 'Bid', first_seen: '2026-10-18', last_seen: '2026-10-19', last_price_cents: o.price ?? 25_000, max_price_cents: o.price ?? 25_000,
  last_bid_count: o.bids ?? 3, ended: o.ended ?? true, final_state_at: (o.ended ?? true) ? '2026-10-20' : null,
}).execute();

describe('EF541 engineFeed', () => {
  it('EF541-1 deleted closeout names become engine_unsold rows (dropped_after_held, observation_date = gone_date, caught flag from the tag reason); bought, unknown, other feeds and other endings are left out; one engine_uploads row, by datasave', async () => {
    await tagged('reregistered.com', 'deleted', 'RE_REGISTERED');
    await tagged('free.com', 'deleted', 'NOT_REGISTERED', { gone: '2026-10-19' });
    await tagged('redeem.com', 'deleted', 'STATUS:redemptionPeriod');
    await tagged('moved.com', 'bought', 'REGISTRAR_CHANGED:GoDaddy -> X');
    await tagged('maybe.com', 'unknown', 'SAME_REGISTRAR');
    await tagged('dyn.com', 'deleted', 'NOT_REGISTERED', { source: 'dynadot_closeouts' });
    await tagged('thing.net', 'deleted', 'NOT_REGISTERED');
    const { job } = mkJob();
    const r = await job.engineFeed() as Record<string, unknown>;
    expect(r).toMatchObject({ status: 'ok', unsold_inserted_n: 3, sales_inserted_n: 0, skipped_dup_n: 0, unsold_candidates_n: 3, rejected_n: 0 });
    expect(await unsold()).toEqual([
      { domain: 'free.com', type: 'dropped_after_held', observation_date: '2026-10-19', caught_by_catcher: false },
      { domain: 'redeem.com', type: 'dropped_after_held', observation_date: '2026-10-20', caught_by_catcher: null },
      { domain: 'reregistered.com', type: 'dropped_after_held', observation_date: '2026-10-20', caught_by_catcher: true },
    ]);
    const ups = await db.selectFrom('engine_uploads').selectAll().execute();
    expect(ups).toHaveLength(1);
    expect(ups[0]).toMatchObject({ kind: 'unsold', by: 'datasave', received_n: 3, accepted_n: 3, duplicate_n: 0, rejected_n: 0, audit_id: null });
    expect(r.unsold_upload_id).toBe(ups[0]!.id);
  });

  it('EF541-2 a second run adds nothing and writes no upload row; a name already in engine_unsold for that day is counted in skipped_dup_n', async () => {
    await tagged('a.com', 'deleted', 'NOT_REGISTERED');
    await tagged('b.com', 'deleted', 'NOT_REGISTERED');
    const up = await db.insertInto('engine_uploads').values({ kind: 'unsold', received_n: 1, accepted_n: 1, duplicate_n: 0, rejected_n: 0, rejects: '[]', by: 'gavriel', audit_id: null, created_at: new Date(NOW) }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('engine_unsold').values({ domain: 'a.com', type: 'registered_unsold', observation_date: '2026-10-20', caught_by_catcher: null, upload_id: up.id }).execute();
    const { job } = mkJob();
    expect(await job.engineFeed()).toMatchObject({ unsold_inserted_n: 1, skipped_dup_n: 1, unsold_candidates_n: 1 });
    expect((await unsold()).map((u) => [u.domain, u.type])).toEqual([['a.com', 'registered_unsold'], ['b.com', 'dropped_after_held']]);
    const again = await job.engineFeed();
    expect(again).toMatchObject({ unsold_inserted_n: 0, skipped_dup_n: 2, unsold_candidates_n: 0, unsold_upload_id: null });
    expect(await db.selectFrom('engine_uploads').select('id').where('by', '=', 'datasave').execute()).toHaveLength(1);
  });

  it('EF541-3 regime names are looked up first, so a cap of 1 lookup goes to the trainable name; regime_due_n counts them and regime_n counts the fed rows in the regime', async () => {
    const regime = await loadRegimeTest(db);
    expect(regime('septicdrone.com')).toBe(true);
    expect(regime('zzqqxx.com')).toBe(false);
    expect(regime('abc.com')).toBe(false);
    const row = (d: string, domain: string) => ({ data_date: d, source: 'godaddy_closeouts', domain, price_cents: 1500, ends_at: new Date('2026-10-21T10:00:00Z') });
    await db.insertInto('datasave_pool').values([...['aaa.com', 'zzqqxx.com', 'septicdrone.com', 'stays.com'].map((n) => row('2026-10-19', n)), row('2026-10-20', 'stays.com')]).execute();
    await sql`update settings set disappearance_lookups_max_per_run = 1`.execute(db);
    const { job, calls } = mkJob({ 'septicdrone.com': free, 'zzqqxx.com': free, 'aaa.com': free });
    const p = await job.buildPanel() as { tags: Record<string, unknown> };
    expect(calls).toEqual(['septicdrone.com']);
    expect(p.tags).toMatchObject({ lookups_n: 1, eligible_n: 3, regime_due_n: 1, stopped_reason: 'CAP' });
    const f = await job.engineFeed();
    expect(f).toMatchObject({ unsold_inserted_n: 1, regime_n: 1 });
    expect((await unsold()).map((u) => u.domain)).toEqual(['septicdrone.com']);
  });

  it('EF541-4 ended GoDaddy auctions with a bid and a price at or above settings.datasave_auction_min_cents become engine_sales (price, Israel end day, venue godaddy, source godaddy_auctions_file); 0 bids, below the floor, open and .net are left out', async () => {
    await ended('sold.com', { price: 25_000, end: '2026-10-18T22:30:00Z' }); // 01:30 on the 19th in Israel
    await ended('edge.com', { price: 10_000, bids: 1 });
    await ended('cheap.com', { price: 9_900 });
    await ended('nobid.com', { bids: 0 });
    await ended('open.com', { ended: false });
    await ended('x.net');
    const { job } = mkJob();
    const r = await job.engineFeed();
    expect(r).toMatchObject({ sales_inserted_n: 2, unsold_inserted_n: 0, sales_candidates_n: 2, auction_min_cents: 10_000 });
    expect(await sales()).toEqual([
      { domain: 'edge.com', price_cents: 10_000, sale_date: '2026-10-20', venue: 'godaddy', source: 'godaddy_auctions_file', source_url: 'https://inventory.auctions.godaddy.com/metadata.json' },
      { domain: 'sold.com', price_cents: 25_000, sale_date: '2026-10-19', venue: 'godaddy', source: 'godaddy_auctions_file', source_url: 'https://inventory.auctions.godaddy.com/metadata.json' },
    ]);
    expect(await db.selectFrom('engine_uploads').select(['kind', 'by', 'accepted_n']).execute()).toEqual([{ kind: 'sales', by: 'datasave', accepted_n: 2 }]);
  });

  it('EF541-5 the engine 20-day rule: a name with a sale within 20 days of the auction end is not added again (counted in skipped_dup_n); 21 days apart it is; a rerun adds nothing', async () => {
    const up = await db.insertInto('engine_uploads').values({ kind: 'sales', received_n: 2, accepted_n: 2, duplicate_n: 0, rejected_n: 0, rejects: '[]', by: 'gavriel', audit_id: null, created_at: new Date(NOW) }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('engine_sales').values([
      { domain: 'near.com', price_cents: 90_000, sale_date: '2026-10-01', venue: 'namebio', source: 'x', source_url: null, upload_id: up.id },
      { domain: 'far.com', price_cents: 90_000, sale_date: '2026-09-29', venue: 'namebio', source: 'x', source_url: null, upload_id: up.id },
    ]).execute();
    await ended('near.com'); await ended('far.com'); await ended('fresh.com');
    const { job } = mkJob();
    expect(await job.engineFeed()).toMatchObject({ sales_inserted_n: 2, skipped_dup_n: 1, sales_candidates_n: 2 });
    expect((await sales()).map((s) => [s.domain, s.source])).toEqual([['far.com', 'x'], ['far.com', 'godaddy_auctions_file'], ['fresh.com', 'godaddy_auctions_file'], ['near.com', 'x']]);
    expect(await job.engineFeed()).toMatchObject({ sales_inserted_n: 0, skipped_dup_n: 3, sales_upload_id: null });
  });

  it('EF541-6 settings.datasave_auction_min_cents: default 10000, the database refuses below 100, and parseAuctions keeps an auction at or above it (not the old fixed $500) and follows a changed value', async () => {
    expect((await db.selectFrom('settings').select('datasave_auction_min_cents').executeTakeFirstOrThrow()).datasave_auction_min_cents).toBe(10_000);
    await expect(sql`update settings set datasave_auction_min_cents = 99`.execute(db)).rejects.toThrow();
    await mkdir(SNAP, { recursive: true });
    const file = join(SNAP, 'auctions.json.zip');
    await writeFile(file, makeZip('auctions.json', auctionsJson([
      { domainName: 'hundred.com', price: '$100', auctionEndTime: '2026-10-21T09:00:00Z', numberOfBids: 2 },
      { domainName: 'ninety.com', price: '$99', auctionEndTime: '2026-10-21T09:00:00Z', numberOfBids: 2 },
      { domainName: 'five.com', price: '$500', auctionEndTime: '2026-10-21T09:00:00Z', numberOfBids: 2 },
    ])));
    const { job } = mkJob();
    await job.parseAuctions(file, '2026-10-20');
    expect((await db.selectFrom('godaddy_auctions').select('domain').orderBy('domain').execute()).map((r) => r.domain)).toEqual(['five.com', 'hundred.com']);
    await db.deleteFrom('godaddy_auctions').execute();
    await sql`update settings set datasave_auction_min_cents = 50000`.execute(db);
    await job.parseAuctions(file, '2026-10-20');
    expect((await db.selectFrom('godaddy_auctions').select('domain').execute()).map((r) => r.domain)).toEqual(['five.com']);
  });

  it('EF541-7 the database size guard applies: over 70% of the limit the step stores nothing and says db_size_high', async () => {
    await tagged('a.com', 'deleted', 'NOT_REGISTERED');
    await ended('sold.com');
    const limit = 1024 ** 3;
    const { job } = mkJob({}, { dbSize: { limitBytes: limit, warnPercent: 70, bytes: async () => limit * 0.7 } });
    expect(await job.engineFeed()).toMatchObject({ status: 'db_size_high', unsold_inserted_n: 0, sales_inserted_n: 0 });
    expect(await unsold()).toEqual([]);
    expect(await sales()).toEqual([]);
    expect(await db.selectFrom('engine_uploads').select('id').execute()).toEqual([]);
    const ok = mkJob({}, { dbSize: { limitBytes: limit, warnPercent: 70, bytes: async () => 1000 } });
    expect(await ok.job.engineFeed()).toMatchObject({ status: 'ok', unsold_inserted_n: 1, sales_inserted_n: 1, db_bytes_before: 1000 });
  });

  it('EF541-8 fed rows count for the engine: the token-index cache key follows max(engine_uploads.id), so a feed run moves it', async () => {
    await tagged('a.com', 'deleted', 'NOT_REGISTERED');
    const before = (await db.selectFrom('engine_uploads').select((eb) => eb.fn.max('id').as('m')).executeTakeFirst())?.m ?? null;
    await mkJob().job.engineFeed();
    const after = (await db.selectFrom('engine_uploads').select((eb) => eb.fn.max('id').as('m')).executeTakeFirst())?.m ?? null;
    expect(after).not.toBe(before);
    expect(await db.selectFrom('engine_unsold').select('domain').execute()).toEqual([{ domain: 'a.com' }]);
  });
});
