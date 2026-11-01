// G-139: the `episodes` step is set-based SQL. EP-139-1 pins the data-transfer cost (little crosses from the database to Node) and the no-rewrite rule; EP-139-2 pins the
// GoDaddy source hash that the SQL computes against the Node formula the step used before.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { dbBytesIn } from '../../../src/core/db-stats.js';
import { runEpisodes } from '../../../src/modules/market/index.js';
import { testDb as db } from '../../helpers/db.js';

const at = (iso: string) => Date.parse(`${iso}T16:00:00Z`);
const seal = async (day: string) => {
  await db.insertInto('snapshot_manifests').values({ source: 'dynadot_aftermarket', data_date: day, file_name: 'bot_upload', status: 'complete', sha256: day.replace(/-/g, 'a').padEnd(64, 'e'), rows: 1000, sealed_at: new Date(`${day}T16:00:00Z`), origin: 'bot_upload', updated_at: new Date(`${day}T16:00:00Z`) }).onConflict((oc) => oc.doNothing()).execute();
};
const day = async (d: string, names: string[], price: (i: number) => number) => {
  await seal(d);
  const rows = names.map((domain, i) => ({ data_date: d, kind: 'aftermarket' as const, domain, listing_id: `${domain}-${d}`, price_cents: price(i) }));
  for (let i = 0; i < rows.length; i += 500) await db.insertInto('dynadot_rows').values(rows.slice(i, i + 500)).execute();
};

describe('EP139 episodes as SQL', () => {
  it('EP-139-1 a daily run reads little from the database (under 20% of the rows), and a second run rewrites nothing', async () => {
    const names = Array.from({ length: 600 }, (_, i) => `ep139-name${i}-with-a-long-enough-label.com`);
    await day('2026-10-01', names.slice(0, 500), () => 150000);
    await day('2026-10-02', names.slice(0, 520), (i) => (i % 10 === 0 ? 170000 : 150000));
    await day('2026-10-03', names.slice(0, 540), () => 150000);
    await runEpisodes(db, at('2026-10-04'));
    // the 4th sealed day: 540 names continue (54 change price), 60 are new
    await day('2026-10-04', names, (i) => (i % 10 === 0 ? 190000 : 150000));
    const rowsBytes = await (async () => { const b0 = dbBytesIn(); await db.selectFrom('market_names').selectAll().execute(); return dbBytesIn() - b0; })();
    const before = await db.selectFrom('market_names').select(['episode_id', 'derived_at', 'seen_days']).orderBy('episode_id').execute();
    expect(before).toHaveLength(540);
    const b1 = dbBytesIn();
    const first = await runEpisodes(db, at('2026-10-04'));
    const stepBytes = dbBytesIn() - b1;
    expect(first).toMatchObject({ episodes_n: 600, inserted_n: 60, updated_n: 540, deleted_n: 0 });
    expect(rowsBytes).toBeGreaterThan(100_000);
    expect(stepBytes).toBeLessThan(rowsBytes * 0.2);
    console.log(`EP-139-1 bytes read: step ${stepBytes}, a select of all ${before.length} rows ${rowsBytes}`);
    const mid = await db.selectFrom('market_names').select(['episode_id', 'derived_at']).orderBy('episode_id').execute();
    const second = await runEpisodes(db, at('2026-10-05'));
    expect(second).toMatchObject({ episodes_n: 600, inserted_n: 0, updated_n: 0, deleted_n: 0 });
    expect(await db.selectFrom('market_names').select(['episode_id', 'derived_at']).orderBy('episode_id').execute()).toEqual(mid);
    const row = await db.selectFrom('market_names').selectAll().where('name', '=', names[0]!).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ seen_days: 4, price_changes: 3, first_seen: '2026-10-01', last_seen: '2026-10-04', list_price_cents_first: 150000, list_price_cents_last: 190000 });
  });

  it('EP-139-2 the GoDaddy source hash computed in SQL equals sha256(JSON.stringify([domain, end ISO, price, bids, final day]))', async () => {
    const end = new Date('2026-11-12T20:00:00.123Z');
    await db.insertInto('godaddy_auctions').values({ domain: 'ep139-gd.com', end_time: end, first_seen: '2026-11-05', last_seen: '2026-11-12', last_price_cents: 123400, max_price_cents: 123400, last_bid_count: 6, final_state_at: '2026-11-13', ended: true }).execute();
    await runEpisodes(db, at('2026-11-20'));
    const r = await db.selectFrom('market_names').select(['source_sha256', 'outcome_rule', 'sale_price_cents', 'sale_date']).where('name', '=', 'ep139-gd.com').executeTakeFirstOrThrow();
    expect(r.source_sha256).toBe(createHash('sha256').update(JSON.stringify(['ep139-gd.com', end.toISOString(), 123400, 6, '2026-11-13'])).digest('hex'));
    expect(r).toMatchObject({ outcome_rule: 'SOLD_BIDS', sale_price_cents: 123400, sale_date: '2026-11-12' });
  });
});
