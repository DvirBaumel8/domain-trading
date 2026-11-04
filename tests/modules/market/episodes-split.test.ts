// v6.3.0: market_names is a view over market_episodes (cold, wide) and market_episode_seen (hot, narrow, fillfactor 50). EP-63-* pin the split:
// the view keeps the old columns, the daily continue writes only the hot table (HOT updates), the Buy-Now sha is derived from the day's manifest, the INSTEAD OF
// triggers keep other writers working, days_listed is computed, and a whole episodes run gives the rows it gave before the split.
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { runEpisodes } from '../../../src/modules/market/index.js';
import { testDb as db } from '../../helpers/db.js';

const at = (iso: string) => Date.parse(`${iso}T16:00:00Z`);
const shaOf = (d: string) => d.replace(/-/g, 'a').padEnd(64, 'e');
const seal = async (d: string) => {
  await db.insertInto('snapshot_manifests').values({ source: 'dynadot_aftermarket', data_date: d, file_name: 'bot_upload', status: 'complete', sha256: shaOf(d), rows: 1000, sealed_at: new Date(`${d}T16:00:00Z`), origin: 'bot_upload', updated_at: new Date(`${d}T16:00:00Z`) }).onConflict((oc) => oc.doNothing()).execute();
};
const day = async (d: string, names: string[], price: (i: number) => number) => {
  await seal(d);
  const rows = names.map((domain, i) => ({ data_date: d, kind: 'aftermarket' as const, domain, listing_id: `${domain}-${d}`, price_cents: price(i) }));
  for (let i = 0; i < rows.length; i += 500) await db.insertInto('dynadot_rows').values(rows.slice(i, i + 500)).execute();
};

/** The columns of the old market_names table, in order, with the old types. */
const OLD_COLUMNS: Array<[string, string]> = [
  ['episode_id', 'text'], ['name', 'text'], ['sld', 'text'], ['tld', 'text'], ['venue', 'text'], ['listing_type', 'text'], ['list_price_cents_first', 'bigint'], ['list_price_cents_last', 'bigint'],
  ['price_changes', 'integer'], ['first_seen', 'date'], ['last_seen', 'date'], ['days_listed', 'integer'], ['seen_days', 'integer'], ['sale_only', 'boolean'], ['outcome', 'text'], ['outcome_rule', 'text'],
  ['sale_price_cents', 'bigint'], ['sale_date', 'date'], ['source', 'text'], ['source_url', 'text'], ['source_sha256', 'text'], ['tier', 'text'], ['feat_asof', 'date'], ['dup_group', 'text'],
  ['dup_sources', 'ARRAY'], ['price_band', 'text'], ['sale_id', 'bigint'], ['derived_at', 'timestamp with time zone'],
];
const ep = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  episode_id: id.padEnd(40, '0'), name, sld: name.split('.')[0]!, tld: 'com', venue: 'dynadot', listing_type: 'bin' as const, list_price_cents_first: 90000, list_price_cents_last: 90000, price_changes: 0,
  first_seen: '2026-09-01', last_seen: '2026-10-01', days_listed: 30, seen_days: 5, sale_only: false, outcome: 'unknown' as const, outcome_rule: 'TOO_SHORT', sale_price_cents: null, sale_date: null,
  source: 'dynadot_aftermarket', source_url: null, source_sha256: null, tier: 'B' as const, dup_group: null, dup_sources: null, price_band: '500-999' as const, sale_id: null, ...over,
});

describe('EP63 market_names split into market_episodes and market_episode_seen', () => {
  it('EP-63-1 the view has exactly the old columns, order and types; fillfactor 50 and only the primary key on the hot table', async () => {
    const cols = (await sql<{ column_name: string; data_type: string }>`select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = 'market_names' order by ordinal_position`.execute(db)).rows;
    expect(cols.map((c) => [c.column_name, c.data_type])).toEqual(OLD_COLUMNS);
    const kind = (await sql<{ relkind: string }>`select relkind from pg_class where oid = 'public.market_names'::regclass`.execute(db)).rows[0]!.relkind;
    expect(kind).toBe('v');
    const ff = (await sql<{ o: string[] }>`select reloptions as o from pg_class where oid = 'public.market_episode_seen'::regclass`.execute(db)).rows[0]!.o;
    expect(ff).toEqual(['fillfactor=50']);
    const idx = (await sql<{ indexname: string }>`select indexname from pg_indexes where tablename = 'market_episode_seen'`.execute(db)).rows;
    expect(idx.map((i) => i.indexname)).toEqual(['market_episode_seen_pkey']);
    const cold = (await sql<{ indexname: string }>`select indexname from pg_indexes where tablename = 'market_episodes' order by indexname`.execute(db)).rows.map((i) => i.indexname);
    expect(cold).toEqual(['market_episodes_id_key', 'market_episodes_name_venue', 'market_episodes_outcome', 'market_episodes_pkey', 'market_episodes_sale_date']);
  });

  it('EP-63-2 the daily continue writes only the hot table (cold xmin unchanged) and the update is HOT', async () => {
    const names = Array.from({ length: 300 }, (_, i) => `ep63-hot${i}-with-a-long-enough-label.com`);
    await day('2026-10-01', names, () => 150000);
    await runEpisodes(db, at('2026-10-02'));
    await day('2026-10-02', names, () => 150000);
    await runEpisodes(db, at('2026-10-03')); // the label settles (SEEN_ONCE -> TOO_SHORT): that is the one legitimate cold rewrite
    await day('2026-10-03', names, (i) => (i % 2 === 0 ? 170000 : 150000));
    const coldBefore = (await sql<{ episode_id: string; x: string; derived_at: Date }>`select episode_id, xmin::text as x, derived_at from market_episodes order by episode_id`.execute(db)).rows;
    const hotX = async () => (await sql<{ h: string }>`select coalesce(n_tup_hot_upd, 0)::text as h from pg_stat_user_tables where relname = 'market_episode_seen'`.execute(db)).rows[0]!.h;
    // the statistics of earlier folds reach the shared stats a moment late: wait until the counter stands still before measuring
    let hot0 = Number(await hotX());
    for (let k = 0; k < 20; k++) { await new Promise((r) => setTimeout(r, 1300)); const h = Number(await hotX()); if (h === hot0) break; hot0 = h; }
    const s = await runEpisodes(db, at('2026-10-03'));
    expect(s).toMatchObject({ episodes_n: 300, inserted_n: 0, updated_n: 300 });
    const coldAfter = (await sql<{ episode_id: string; x: string; derived_at: Date }>`select episode_id, xmin::text as x, derived_at from market_episodes order by episode_id`.execute(db)).rows;
    expect(coldAfter).toEqual(coldBefore);
    let hot1 = hot0;
    for (let k = 0; k < 40 && hot1 - hot0 < 300; k++) { await new Promise((r) => setTimeout(r, 300)); hot1 = Number(await hotX()); }
    expect(hot1 - hot0).toBe(300);
    const v = await db.selectFrom('market_names').selectAll().where('name', '=', names[0]!).executeTakeFirstOrThrow();
    expect(v).toMatchObject({ seen_days: 3, price_changes: 1, last_seen: '2026-10-03', list_price_cents_first: 150000, list_price_cents_last: 170000, days_listed: 2 });
  });

  it('EP-63-3 source_sha256 from the view is the day manifest sha for a Buy-Now row (NULL in the cold table) and the stored sha for an auction row', async () => {
    await day('2026-10-01', ['ep63-sha.com'], () => 150000);
    await day('2026-10-02', ['ep63-sha.com'], () => 150000);
    await db.insertInto('godaddy_auctions').values({ domain: 'ep63-gd.com', end_time: new Date('2026-10-02T20:00:00.000Z'), first_seen: '2026-09-29', last_seen: '2026-10-02', last_price_cents: 123400, max_price_cents: 123400, last_bid_count: 2, final_state_at: '2026-10-03', ended: true }).execute();
    await runEpisodes(db, at('2026-10-05'));
    const bn = await db.selectFrom('market_names').select(['source_sha256', 'last_seen']).where('name', '=', 'ep63-sha.com').executeTakeFirstOrThrow();
    expect(bn).toEqual({ source_sha256: shaOf('2026-10-02'), last_seen: '2026-10-02' });
    expect((await sql<{ s: string | null }>`select source_sha256 as s from market_episodes where name = 'ep63-sha.com'`.execute(db)).rows[0]!.s).toBeNull();
    const gd = await db.selectFrom('market_names').select('source_sha256').where('name', '=', 'ep63-gd.com').executeTakeFirstOrThrow();
    expect(gd.source_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await sql<{ s: string }>`select source_sha256 as s from market_episodes where name = 'ep63-gd.com'`.execute(db)).rows[0]!.s).toBe(gd.source_sha256);
    // a third day moves last_seen and the view follows with the new manifest sha, with no write to the cold row
    await day('2026-10-03', ['ep63-sha.com'], () => 150000);
    await runEpisodes(db, at('2026-10-05'));
    expect((await db.selectFrom('market_names').select('source_sha256').where('name', '=', 'ep63-sha.com').executeTakeFirstOrThrow()).source_sha256).toBe(shaOf('2026-10-03'));
  });

  it('EP-63-4 INSTEAD OF insert, update and delete through the view write both tables; last_seen before first_seen is refused', async () => {
    await db.insertInto('market_names').values(ep('a1', 'ep63a.com')).execute();
    const row = (await sql<{ id: string }>`select id::text from market_episodes where name = 'ep63a.com'`.execute(db)).rows;
    expect(row).toHaveLength(1);
    expect(await db.selectFrom('market_episode_seen').select(['last_seen', 'seen_days', 'price_changes']).where('id', '=', Number(row[0]!.id)).executeTakeFirstOrThrow()).toEqual({ last_seen: '2026-10-01', seen_days: 5, price_changes: 0 });
    await db.updateTable('market_names').set({ last_seen: '2026-10-09', seen_days: 6, outcome_rule: 'DISAPPEARED', feat_asof: '2026-09-01' }).where('name', '=', 'ep63a.com').execute();
    expect(await db.selectFrom('market_names').select(['last_seen', 'seen_days', 'outcome_rule', 'feat_asof', 'days_listed']).where('name', '=', 'ep63a.com').executeTakeFirstOrThrow())
      .toEqual({ last_seen: '2026-10-09', seen_days: 6, outcome_rule: 'DISAPPEARED', feat_asof: '2026-09-01', days_listed: 38 });
    await expect(db.updateTable('market_names').set({ last_seen: '2026-08-01' }).where('name', '=', 'ep63a.com').execute()).rejects.toThrow(/before first_seen/);
    await expect(db.insertInto('market_names').values(ep('b2', 'ep63b.com', { last_seen: '2026-08-01' })).execute()).rejects.toThrow(/before first_seen/);
    // omitted columns take the old defaults (price_changes 0, seen_days 0, sale_only false, derived_at now)
    const { price_changes, seen_days, sale_only, ...rest } = ep('c3', 'ep63c.com');
    void price_changes; void seen_days; void sale_only;
    await db.insertInto('market_names').values(rest as never).execute();
    expect(await db.selectFrom('market_names').select(['price_changes', 'seen_days', 'sale_only']).where('name', '=', 'ep63c.com').executeTakeFirstOrThrow()).toEqual({ price_changes: 0, seen_days: 0, sale_only: false });
    await db.deleteFrom('market_names').where('name', '=', 'ep63a.com').execute();
    expect((await sql<{ n: number }>`select (select count(*) from market_episodes where name = 'ep63a.com')::int + (select count(*) from market_episode_seen h where not exists (select 1 from market_episodes c where c.id = h.id))::int as n`.execute(db)).rows[0]!.n).toBe(0);
  });

  it('EP-63-5 days_listed is last_seen - first_seen for every writer (fold, closed auction, GoDaddy, sale-only, the view)', async () => {
    await day('2026-10-01', ['ep63-dl.com'], () => 150000);
    await day('2026-10-04', ['ep63-dl.com'], () => 150000);
    await db.insertInto('godaddy_auctions').values({ domain: 'ep63-dlgd.com', end_time: new Date('2026-10-09T20:00:00.000Z'), first_seen: '2026-10-02', last_seen: '2026-10-09', last_price_cents: 90000, max_price_cents: 90000, last_bid_count: 0, final_state_at: '2026-10-10', ended: true }).execute();
    await db.insertInto('market_sales').values({ name: 'ep63-so.com', venue: 'dnjournal', sale_price_cents: 200000, sale_date: '2026-10-05', source: 'dnjournal_weekly', tier: 'B', by: 'test' } as never).execute();
    await runEpisodes(db, at('2026-10-12'));
    const rows = (await sql<{ name: string; days_listed: number; d: number; sale_only: boolean }>`select name, days_listed, (last_seen - first_seen) as d, sale_only from market_names order by name`.execute(db)).rows;
    expect(rows.map((r) => r.name)).toEqual(['ep63-dl.com', 'ep63-dlgd.com', 'ep63-so.com']);
    for (const r of rows) expect(r.days_listed).toBe(r.d);
    expect(rows.map((r) => r.days_listed)).toEqual([3, 7, 0]);
    // no row anywhere has last_seen before first_seen
    expect((await sql<{ n: number }>`select count(*)::int as n from market_episodes c join market_episode_seen h on h.id = c.id where h.last_seen < c.first_seen`.execute(db)).rows[0]!.n).toBe(0);
  });

  it('EP-63-6 a whole episodes run over a mixed scenario gives the pre-split summary and view rows, and a second run changes nothing', async () => {
    await day('2026-10-01', ['ep63-a.com', 'ep63-b.com', 'ep63-c.com'], (i) => 100000 + i * 100000);
    await day('2026-10-02', ['ep63-a.com', 'ep63-b.com'], (i) => (i === 0 ? 120000 : 200000));
    await day('2026-10-03', ['ep63-a.com', 'ep63-b.com'], () => 120000);
    await db.insertInto('godaddy_auctions').values({ domain: 'ep63-gd.com', end_time: new Date('2026-10-02T20:00:00.000Z'), first_seen: '2026-09-29', last_seen: '2026-10-02', last_price_cents: 123400, max_price_cents: 123400, last_bid_count: 6, final_state_at: '2026-10-03', ended: true }).execute();
    await db.insertInto('market_sales').values({ name: 'ep63-a.com', venue: 'dnjournal', sale_price_cents: 250000, sale_date: '2026-10-03', source: 'dnjournal_weekly', tier: 'B', by: 'test' } as never).execute();
    const s1 = await runEpisodes(db, at('2026-10-04'));
    expect(s1).toEqual({ episodes_n: 4, sold_n: 2, unsold_60d_n: 0, unsold_30d_n: 0, unknown_n: 2, sale_only_n: 0, inserted_n: 4, updated_n: 0, deleted_n: 0, sales_matched_n: 1, sales_unmatched_n: 0, sales_below_floor_n: 0,
      sealed_days: { dynadot_aftermarket: '2026-10-03' } });
    const rows = await db.selectFrom('market_names').select(['name', 'venue', 'listing_type', 'first_seen', 'last_seen', 'days_listed', 'seen_days', 'price_changes', 'list_price_cents_first', 'list_price_cents_last', 'outcome', 'outcome_rule',
      'sale_price_cents', 'sale_date', 'source', 'source_sha256', 'tier', 'price_band', 'sale_only']).orderBy('name').execute();
    expect(rows).toEqual([
      { name: 'ep63-a.com', venue: 'dynadot', listing_type: 'bin', first_seen: '2026-10-01', last_seen: '2026-10-03', days_listed: 2, seen_days: 3, price_changes: 1, list_price_cents_first: 100000, list_price_cents_last: 120000, outcome: 'sold', outcome_rule: 'SOLD_REPORTED', sale_price_cents: 250000, sale_date: '2026-10-03', source: 'dynadot_aftermarket', source_sha256: shaOf('2026-10-03'), tier: 'B', price_band: '2.5k-5k', sale_only: false },
      { name: 'ep63-b.com', venue: 'dynadot', listing_type: 'bin', first_seen: '2026-10-01', last_seen: '2026-10-03', days_listed: 2, seen_days: 3, price_changes: 1, list_price_cents_first: 200000, list_price_cents_last: 120000, outcome: 'unknown', outcome_rule: 'TOO_SHORT', sale_price_cents: null, sale_date: null, source: 'dynadot_aftermarket', source_sha256: shaOf('2026-10-03'), tier: 'B', price_band: '1k-2.5k', sale_only: false },
      { name: 'ep63-c.com', venue: 'dynadot', listing_type: 'bin', first_seen: '2026-10-01', last_seen: '2026-10-01', days_listed: 0, seen_days: 1, price_changes: 0, list_price_cents_first: 300000, list_price_cents_last: 300000, outcome: 'unknown', outcome_rule: 'SEEN_ONCE', sale_price_cents: null, sale_date: null, source: 'dynadot_aftermarket', source_sha256: shaOf('2026-10-01'), tier: 'B', price_band: '2.5k-5k', sale_only: false },
      { name: 'ep63-gd.com', venue: 'godaddy', listing_type: 'auction', first_seen: '2026-09-29', last_seen: '2026-10-02', days_listed: 3, seen_days: 2, price_changes: 0, list_price_cents_first: null, list_price_cents_last: 123400, outcome: 'sold', outcome_rule: 'SOLD_BIDS', sale_price_cents: 123400, sale_date: '2026-10-02', source: 'godaddy_auction_end', source_sha256: expect.stringMatching(/^[0-9a-f]{64}$/), tier: 'A', price_band: '1k-2.5k', sale_only: false },
    ]);
    const before = (await sql<{ c: string; h: string }>`select (select string_agg(xmin::text, ',' order by id) from market_episodes) as c, (select string_agg(xmin::text, ',' order by id) from market_episode_seen) as h`.execute(db)).rows[0]!;
    const s2 = await runEpisodes(db, at('2026-10-05'));
    expect(s2).toMatchObject({ episodes_n: 4, inserted_n: 0, updated_n: 0, deleted_n: 0 });
    expect((await sql<{ c: string; h: string }>`select (select string_agg(xmin::text, ',' order by id) from market_episodes) as c, (select string_agg(xmin::text, ',' order by id) from market_episode_seen) as h`.execute(db)).rows[0]!).toEqual(before);
  });
});
