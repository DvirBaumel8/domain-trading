// v5.42.0 (BK542): bulk writes of POST /data/sales, POST /ledger/costs and the labelled-names upload. The query counts come from the v5.40.0 counter.
import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { withDbScope } from '../../../src/core/db-stats.js';
import { COSTS_MAX_ROWS, postCosts } from '../../../src/modules/reporting/books.js';
import { loadSales, SALES_MAX_ROWS } from '../../../src/modules/market/sales.js';
import { testDb as db } from '../../helpers/db.js';

const log = (id: string, n: number) => { if (process.env.BK_LOG) appendFileSync(process.env.BK_LOG, `${id}: ${n}\n`); };
const row = (i: number, price = 1000 + i) => ({ name: `bulk${i}.com`, venue: 'afternic', sale_price_cents: price, sale_date: '2026-10-01', source: 'bk542', tier: 'B' });
const ctx = (dryRun = false) => ({ by: 'bots', auditId: null, todayUtc: '2026-10-25', dryRun });

describe('BK542 bulk writes: sales', () => {
  it('BK542-1 5,000 sale rows take fewer than 20 queries; a re-post is all duplicates; a changed price is still 409 APPEND_ONLY and stores nothing', async () => {
    const rows = Array.from({ length: SALES_MAX_ROWS }, (_, i) => row(i));
    const first = await withDbScope('bk542-1a', () => loadSales(db, rows, ctx()));
    log('BK542-1 first post', first.stats.queries);
    expect(first.value).toMatchObject({ received_n: 5000, accepted_n: 5000, duplicate_n: 0 });
    expect(first.stats.queries).toBeLessThan(20); // before 5.42.0: 2 queries per row = about 10,000
    expect(Number((await db.selectFrom('market_sales').select(({ fn }) => fn.countAll().as('n')).executeTakeFirstOrThrow()).n)).toBe(5000);
    const again = await withDbScope('bk542-1b', () => loadSales(db, rows, ctx()));
    log('BK542-1 re-post', again.stats.queries);
    expect(again.value).toMatchObject({ accepted_n: 0, duplicate_n: 5000 });
    expect(again.stats.queries).toBeLessThan(20);
    // the same row twice in one body: the second is a duplicate of the first
    const twice = await loadSales(db, [row(9000), row(9000)], ctx());
    expect(twice).toMatchObject({ accepted_n: 1, duplicate_n: 1 });
    // a changed price on a stored row, and on a repeat within the body: 409, nothing new stored
    await expect(loadSales(db, [row(9001), row(7, 5)], ctx())).rejects.toMatchObject({ status: 409, code: 'APPEND_ONLY' });
    await expect(loadSales(db, [row(9002), row(9002, 77)], ctx())).rejects.toMatchObject({ status: 409, code: 'APPEND_ONLY' });
    expect(await db.selectFrom('market_sales').select('name').where('name', 'in', ['bulk9001.com', 'bulk9002.com']).execute()).toEqual([]);
    // dry run stores nothing
    expect(await loadSales(db, [row(9100)], ctx(true))).toMatchObject({ dry_run: true, accepted_n: 1 });
    expect(await db.selectFrom('market_sales').select('name').where('name', '=', 'bulk9100.com').execute()).toEqual([]);
  });
});

describe('BK542 bulk writes: ledger costs', () => {
  it('BK542-7 500 cost rows are stored with fewer than 6 queries, in body order', async () => {
    const rows = Array.from({ length: COSTS_MAX_ROWS }, (_, i) => ({ date: '2026-10-20', type: 'tool', amount_usd: '-1.00', note: `row ${i}` }));
    const { value, stats } = await withDbScope('bk542-7', () => postCosts(db, { rows }, { auditId: null }));
    log('BK542-7', stats.queries);
    expect(value).toMatchObject({ dry_run: false, accepted_n: 500 });
    expect(stats.queries).toBeLessThan(6); // before 5.42.0: 500 inserts
    const stored = await db.selectFrom('ledger_entries').select('note').where('type', '=', 'tool').orderBy('id').execute();
    expect(stored.map((r) => r.note)).toEqual(rows.map((r) => r.note));
  });
});
