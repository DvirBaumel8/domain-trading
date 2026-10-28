// CR-075 (v5.23.0) R-7: GET /market/coverage. Rows per source per day, counts per label and band, and the progress against the program targets.
import { sql, type Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { addDays, dayNum, utcDay } from './common.js';
import { buildMatched } from './matched.js';

export const TARGETS = [
  { name: 'unsold_30d', label: 'names unsold for 30+ days (UNSOLD_30D or UNSOLD_60D)', target: 1000, by: '2026-11-25' },
  { name: 'unsold_60d_matched', label: 'UNSOLD_60D names that match a positive (ratio 4, seed 1, as of today)', target: 2000, by: '2026-12-20' },
] as const;

export async function coverage(db: Kysely<Database>, nowMs: number, days = 30) {
  const today = utcDay(nowMs);
  const from = addDays(today, -(days - 1));
  const q = await Promise.all([
    sql<{ source: string; day: string; rows: number; sealed: boolean }>`
      select t.source, t.day, t.rows, exists (select 1 from snapshot_manifests m where m.source = t.source and m.data_date = t.day::date and m.status = 'complete') as sealed
      from (select 'dynadot_' || r.kind as source, r.data_date::text as day, count(*)::int as rows
            from dynadot_rows r where r.kind <> 'closeouts' and r.data_date >= ${from}::date group by 1, 2
            union all -- v5.74.0: sealed days whose rows were pruned (aftermarket rows are kept 2 days) show the manifest's row count
            select m.source, m.data_date::text, coalesce(m.rows, 0)::int from snapshot_manifests m
            where m.source in ('dynadot_aftermarket', 'dynadot_closed_auctions') and m.status = 'complete' and m.data_date >= ${from}::date
              and not exists (select 1 from dynadot_rows r where 'dynadot_' || r.kind = m.source and r.data_date = m.data_date)) t order by t.day, t.source`.execute(db),
    sql<{ day: string; rows: number }>`select final_state_at::text as day, count(*)::int as rows from godaddy_auctions where ended and final_state_at >= ${from}::date group by 1 order by 1`.execute(db),
    sql<{ day: string; rows: number }>`select created_at::date::text as day, count(*)::int as rows from market_sales where created_at >= ${from}::date group by 1 order by 1`.execute(db),
    db.selectFrom('market_names').select(['outcome_rule', (eb) => eb.fn.countAll<number>().as('n')]).groupBy('outcome_rule').execute(),
    db.selectFrom('market_names').select(['price_band', 'outcome', 'outcome_rule', (eb) => eb.fn.countAll<number>().as('n')]).groupBy(['price_band', 'outcome', 'outcome_rule']).execute(),
    sql<{ names: number; sales: number; dq: number; sets: number; bytes: number }>`select (select count(*) from market_names)::int as names, (select count(*) from market_sales)::int as sales,
      (select count(*) from market_dq_runs)::int as dq, (select count(*) from market_matched_sets)::int as sets, pg_total_relation_size('market_names')::bigint as bytes`.execute(db),
    buildMatched(db, today, 4, 1),
  ]);
  const [dyn, gd, sales, rules, bands, size, matched] = q;
  const labelN = (rule: string) => Number(rules.find((r) => r.outcome_rule === rule)?.n ?? 0);
  const unsold30 = labelN('UNSOLD_30D') + labelN('UNSOLD_60D');
  const current: Record<string, number> = { unsold_30d: unsold30, unsold_60d_matched: matched.summary.negatives_n };
  const bandOut: Record<string, Record<string, number>> = {};
  for (const b of bands) {
    const o = (bandOut[b.price_band] ??= { sold: 0, unsold_60d: 0, unsold_30d: 0, unknown: 0 });
    const key = b.outcome === 'sold' ? 'sold' : b.outcome_rule === 'UNSOLD_60D' ? 'unsold_60d' : b.outcome_rule === 'UNSOLD_30D' ? 'unsold_30d' : 'unknown';
    o[key] = (o[key] ?? 0) + Number(b.n);
  }
  const n = size.rows[0]!;
  return {
    as_of: today, window: { from, to: today },
    per_source_daily: [
      ...dyn.rows.map((r) => ({ source: r.source, day: r.day, rows: r.rows, sealed: r.sealed })),
      ...gd.rows.map((r) => ({ source: 'godaddy_auction_end', day: r.day, rows: r.rows, sealed: true })),
      ...sales.rows.map((r) => ({ source: 'sales_reported', day: r.day, rows: r.rows, sealed: true })),
    ].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.source < b.source ? -1 : 1)),
    labels: Object.fromEntries(rules.map((r) => [r.outcome_rule, Number(r.n)]).sort()),
    bands: bandOut,
    unsold_30d_n: unsold30,
    unsold_60d_n: labelN('UNSOLD_60D'),
    unsold_60d_matched_n: matched.summary.negatives_n,
    sold_n: Number(rules.filter((r) => r.outcome_rule.startsWith('SOLD')).reduce((s, r) => s + Number(r.n), 0)),
    targets: TARGETS.map((t) => ({ name: t.name, label: t.label, target: t.target, by: t.by, current: current[t.name]!, progress_pct: Math.round((current[t.name]! / t.target) * 1000) / 10, days_left: dayNum(t.by) - dayNum(today), met: current[t.name]! >= t.target })),
    db_rows: { market_names: n.names, market_sales: n.sales, market_dq_runs: n.dq, market_matched_sets: n.sets, market_names_bytes: Number(n.bytes) },
  };
}
