// CR-075 (v5.23.0) R-5: reading market_names. Money is integer cents with a display string; nothing here writes.
import { sql, type Kysely, type Selectable } from 'kysely';
import { formatUsd } from '../../core/money.js';
import type { Database } from '../../db/types.js';
import { lettersOnly } from './common.js';

export type MarketRow = Selectable<Database['market_names']>;
type Row = MarketRow;
const money = (name: string, cents: number | null) => ({ [`${name}_cents`]: cents, [name]: cents === null ? null : formatUsd(cents) });

export function episodeOut(r: Row): Record<string, unknown> {
  return {
    episode_id: r.episode_id, name: r.name, sld: r.sld, tld: r.tld, venue: r.venue, listing_type: r.listing_type,
    ...money('list_price_first', r.list_price_cents_first), ...money('list_price_last', r.list_price_cents_last), price_changes: r.price_changes,
    first_seen: r.first_seen, last_seen: r.last_seen, days_listed: r.days_listed, seen_days: r.seen_days,
    outcome: r.outcome, outcome_rule: r.outcome_rule, ...money('sale_price', r.sale_price_cents), sale_date: r.sale_date,
    source: r.source, source_url: r.source_url, source_sha256: r.source_sha256, tier: r.tier, feat_asof: r.feat_asof, dup_group: r.dup_group, dup_sources: r.dup_sources,
    price_band: r.price_band, letters_only: lettersOnly(r.sld), sale_only: r.sale_only,
  };
}

export interface EpisodeFilter { outcome?: string; rule?: string; band?: string; from?: string; to?: string; venue?: string; limit: number }

export async function listEpisodes(db: Kysely<Database>, f: EpisodeFilter) {
  const filtered = () => {
    let q = db.selectFrom('market_names');
    if (f.outcome) q = q.where('outcome', '=', f.outcome as Row['outcome']);
    if (f.rule) q = q.where('outcome_rule', '=', f.rule);
    if (f.band) q = q.where('price_band', '=', f.band as Row['price_band']);
    if (f.venue) q = q.where('venue', '=', f.venue);
    if (f.from) q = q.where('first_seen', '>=', f.from);
    if (f.to) q = q.where('first_seen', '<=', f.to);
    return q;
  };
  const [total, byOutcome, byRule, byBand, rows] = await Promise.all([
    filtered().select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
    filtered().select(['outcome', (eb) => eb.fn.countAll<number>().as('n')]).groupBy('outcome').execute(),
    filtered().select(['outcome_rule', (eb) => eb.fn.countAll<number>().as('n')]).groupBy('outcome_rule').execute(),
    filtered().select(['price_band', (eb) => eb.fn.countAll<number>().as('n')]).groupBy('price_band').execute(),
    filtered().selectAll().orderBy('first_seen', 'desc').orderBy('episode_id').limit(f.limit).execute(),
  ]);
  const obj = <K extends string>(xs: ({ n: number } & Record<K, string>)[], k: K) => Object.fromEntries(xs.map((x) => [x[k], Number(x.n)]).sort());
  return {
    summary: { total: Number(total.n), by_outcome: obj(byOutcome, 'outcome'), by_rule: obj(byRule, 'outcome_rule'), by_band: obj(byBand, 'price_band') },
    limit: f.limit, returned: rows.length, rows: rows.map(episodeOut),
  };
}

/** A row passes the leakage rule when no feature as-of date is later than first_seen or the sale date (R-3). */
export const CLEAN_FEATURES = sql<boolean>`(feat_asof is null or (feat_asof <= first_seen and (sale_date is null or feat_asof <= sale_date)))`;
