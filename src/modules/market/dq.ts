// CR-075 (v5.23.0) R-3, R-7: the `dqMarket` step and GET /market/dq. Every check is stored (market_dq_runs); any failed check makes /health.dq_market "alert" and /report DQ_MARKET_FAIL.
import { sql, type Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { addDays, utcDay } from './common.js';
import { CLEAN_FEATURES } from './read.js';

export type DqCheckName = 'duplicates' | 'survivorship' | 'leakage' | 'price_sanity' | 'coverage' | 'tier_present';
export interface DqResult { check: DqCheckName; status: 'pass' | 'fail'; source?: string; day?: string; detail: Record<string, unknown> }
export interface DqRun { id: number | null; checked_at: string | null; status: 'ok' | 'alert' | 'unknown'; failed_checks: DqCheckName[]; results: DqResult[] }

/** Coverage: a day with fewer rows than this share of the median of the 7 days before it fails (R-3, AT-8); at least MIN_PRIOR_DAYS prior days are needed to judge. */
export const COVERAGE_MIN_SHARE = 0.5;
export const COVERAGE_MIN_PRIOR_DAYS = 3;
export const COVERAGE_LOOKBACK_DAYS = 7;
/** Survivorship: after this many sealed days, more than this share of episodes seen from the first snapshot day means new listings are not arriving. */
export const SURVIVORSHIP_MATURE_DAYS = 30;
export const SURVIVORSHIP_MAX_SHARE = 0.9;
export const PRICE_JUMP_FACTOR = 10;
/** A reported sale under this many cents looks like dollars read as cents (the program only stores $500+). */
export const SALE_DOLLARS_SUSPECT_CENTS = 10_000;

const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

export async function runDqMarket(db: Kysely<Database>, nowMs: number): Promise<DqRun> {
  const today = utcDay(nowMs);
  const results: DqResult[] = [];

  // duplicates: two episodes of one name, venue and listing type whose days overlap
  const dup = await sql<{ n: number; sample: string[] | null }>`
    select count(*)::int as n, (array_agg(a.name order by a.name))[1:5] as sample from market_names a join market_names b
      on a.name = b.name and a.venue = b.venue and a.listing_type = b.listing_type and a.episode_id < b.episode_id and a.first_seen <= b.last_seen and b.first_seen <= a.last_seen`.execute(db);
  results.push({ check: 'duplicates', status: dup.rows[0]!.n === 0 ? 'pass' : 'fail', detail: { overlapping_pairs_n: dup.rows[0]!.n, sample_names: dup.rows[0]!.sample ?? [] } });

  // survivorship: the share of Dynadot Buy-Now episodes seen from the first snapshot day of the source
  const days = await db.selectFrom('snapshot_manifests').select('data_date').where('source', '=', 'dynadot_aftermarket').where('status', '=', 'complete').orderBy('data_date').execute();
  const eps = await sql<{ total: number; first_day: number }>`
    select count(*)::int as total, (count(*) filter (where first_seen = ${days[0]?.data_date ?? '1970-01-01'}::date))::int as first_day
    from market_names where venue = 'dynadot' and listing_type = 'bin'`.execute(db);
  const total = eps.rows[0]!.total;
  const share = total === 0 ? 0 : eps.rows[0]!.first_day / total;
  const mature = days.length >= SURVIVORSHIP_MATURE_DAYS;
  results.push({ check: 'survivorship', status: mature && share > SURVIVORSHIP_MAX_SHARE ? 'fail' : 'pass',
    detail: { source: 'dynadot_aftermarket', sealed_days_n: days.length, episodes_n: total, seen_from_first_day_n: eps.rows[0]!.first_day, share: Math.round(share * 1000) / 1000, mature, max_share: SURVIVORSHIP_MAX_SHARE } });

  // leakage: a feature as-of date after first_seen or after the sale date (the row is excluded from /market/matched)
  const leak = await sql<{ n: number; sample: string[] | null }>`
    select count(*)::int as n, (array_agg(episode_id order by episode_id))[1:5] as sample from market_names where not ${CLEAN_FEATURES}`.execute(db);
  results.push({ check: 'leakage', status: leak.rows[0]!.n === 0 ? 'pass' : 'fail', detail: { rows_n: leak.rows[0]!.n, sample_episode_ids: leak.rows[0]!.sample ?? [], action: 'excluded from /market/matched' } });

  // price sanity: a >10x jump between consecutive snapshot days of one name, a sale that looks like dollars read as cents, a sale >10x or <1/10 of the listing price
  const since = addDays(today, -30);
  const jumps = await sql<{ n: number }>`
    with sealed as (select data_date from snapshot_manifests where source = 'dynadot_aftermarket' and status = 'complete' and data_date >= ${since}::date),
    obs as (select r.domain, r.data_date, min(r.price_cents) as p from dynadot_rows r join sealed s on s.data_date = r.data_date where r.kind = 'aftermarket' group by 1, 2),
    lagged as (select p, lag(p) over (partition by domain order by data_date) as prevp from obs)
    select count(*)::int as n from lagged where prevp is not null and (p > prevp * ${PRICE_JUMP_FACTOR} or p * ${PRICE_JUMP_FACTOR} < prevp)`.execute(db);
  const cheap = await sql<{ n: number }>`select count(*)::int as n from market_sales where sale_price_cents < ${SALE_DOLLARS_SUSPECT_CENTS}`.execute(db);
  const mism = await sql<{ n: number }>`select count(*)::int as n from market_names where outcome = 'sold' and list_price_cents_last is not null
    and (sale_price_cents > list_price_cents_last * ${PRICE_JUMP_FACTOR} or sale_price_cents * ${PRICE_JUMP_FACTOR} < list_price_cents_last)`.execute(db);
  const flagged = jumps.rows[0]!.n + cheap.rows[0]!.n + mism.rows[0]!.n;
  results.push({ check: 'price_sanity', status: flagged === 0 ? 'pass' : 'fail',
    detail: { jumps_over_10x_n: jumps.rows[0]!.n, sales_under_100_usd_n: cheap.rows[0]!.n, sale_vs_list_over_10x_n: mism.rows[0]!.n, window_from: since } });

  // coverage: rows per source per day against the median of the 7 days before
  for (const [source, kind] of [['dynadot_aftermarket', 'aftermarket'], ['dynadot_closed_auctions', 'closed_auctions']] as const) {
    const rows = await sql<{ day: string; n: number }>`
      select r.data_date::text as day, count(*)::int as n from dynadot_rows r join snapshot_manifests m on m.source = ${source} and m.status = 'complete' and m.data_date = r.data_date
      where r.kind = ${kind} and r.data_date >= ${addDays(today, -(COVERAGE_LOOKBACK_DAYS * 2))}::date group by 1 order by 1`.execute(db);
    const byDay = new Map(rows.rows.map((r) => [r.day, r.n]));
    let checked = 0;
    let failed = 0;
    for (let k = COVERAGE_LOOKBACK_DAYS - 1; k >= 0; k--) {
      const day = addDays(today, -k);
      const n = byDay.get(day);
      if (n === undefined) continue;
      const prior = Array.from({ length: COVERAGE_LOOKBACK_DAYS }, (_, i) => byDay.get(addDays(day, -(i + 1)))).filter((x): x is number => x !== undefined);
      if (prior.length < COVERAGE_MIN_PRIOR_DAYS) continue;
      checked++;
      const med = median(prior);
      if (n < med * COVERAGE_MIN_SHARE) { failed++; results.push({ check: 'coverage', status: 'fail', source, day, detail: { rows: n, median_7d: med, share: Math.round((n / med) * 1000) / 1000, min_share: COVERAGE_MIN_SHARE } }); }
    }
    if (failed === 0) results.push({ check: 'coverage', status: 'pass', source, detail: { days_checked_n: checked, min_share: COVERAGE_MIN_SHARE } });
  }

  // tier present on every row
  const noTier = await sql<{ a: number; b: number }>`select (select count(*) from market_names where tier is null)::int as a, (select count(*) from market_sales where tier is null)::int as b`.execute(db);
  const nt = noTier.rows[0]!;
  results.push({ check: 'tier_present', status: nt.a + nt.b === 0 ? 'pass' : 'fail', detail: { market_names_without_tier_n: nt.a, market_sales_without_tier_n: nt.b } });

  const failed = [...new Set(results.filter((r) => r.status === 'fail').map((r) => r.check))];
  const status = failed.length > 0 ? 'alert' : 'ok';
  const at = new Date(nowMs);
  const row = await db.insertInto('market_dq_runs').values({ checked_at: at, status, results: JSON.stringify(results) }).returning('id').executeTakeFirstOrThrow();
  await db.deleteFrom('market_dq_runs').where('id', '<', row.id - 89).execute();
  return { id: row.id, checked_at: at.toISOString(), status, failed_checks: failed, results };
}

export async function latestDq(db: Kysely<Database>): Promise<DqRun> {
  const r = await db.selectFrom('market_dq_runs').selectAll().orderBy('id', 'desc').limit(1).executeTakeFirst();
  if (!r) return { id: null, checked_at: null, status: 'unknown', failed_checks: [], results: [] };
  const results = r.results as DqResult[];
  return { id: r.id, checked_at: r.checked_at.toISOString(), status: r.status, failed_checks: [...new Set(results.filter((x) => x.status === 'fail').map((x) => x.check))], results };
}
