import { sql, type Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { idtDay, idtDayStart, toJerusalemIso } from '../../core/dates.js';
import { formatUsd } from '../../core/money.js';
import type { Band } from './offer-rules.js';

export interface Money { cents: number; display: string }
export interface PerDomainOffers {
  count_30d: number; highest_30d: Money | null; count_90d: number; highest_90d: Money | null;
  count_all: number; highest_all: Money | null; highest_all_pct_of_bin: number | null; last_offer_at: string | null; open_for_dvir: number;
}
export interface StrategyRow {
  category: string; strategy: string; names_listed: number; names_with_offers: number; offers_90d: number;
  offers_per_listed_name_per_month: number; median_offer_pct_of_bin: number | null; max_offer_pct_of_bin: number | null;
  band_shares: Record<Band, number>;
}
export interface GroupRow {
  key: string; count: number; highest: Money | null; median_pct_of_bin: number | null; max_pct_of_bin: number | null; band_shares: Record<Band, number>;
}
export type GroupBy = 'domain' | 'category' | 'source' | 'month';

const BANDS: readonly Band[] = ['below_min', 'below_walkaway', 'mid_range', 'at_or_above_floor', 'at_or_above_bin', 'geo_below_bin', 'unpriced'];
const STRATEGY: Record<string, string> = { geo: 'S2', trend: 'S3', b2b: 'S3/S4', collision: 'S4', regulation: 'S6', buzzword: 'S5', other: 'S7' };

const money = (c: number): Money => ({ cents: c, display: formatUsd(c) });
const round = (n: number, dp: number) => Math.round((n + Number.EPSILON) * 10 ** dp) / 10 ** dp;

interface Row {
  domain_id: number; domain: string; category: string | null; amount_cents: number; received_at: Date; bin: number | null;
  band: Band; source: string; routing: string; outcome: string;
}
async function loadOffers(db: Kysely<Database>): Promise<Row[]> {
  const rows = await db.selectFrom('offers').innerJoin('domains', 'domains.id', 'offers.domain_id')
    .select(['offers.domain_id', 'domains.domain', 'domains.category', 'offers.amount_cents', 'offers.received_at', 'offers.bin_cents_at as bin',
      'offers.band', 'offers.source', 'offers.routing', 'offers.outcome']).execute();
  return rows as Row[];
}

const pct = (r: Row) => (r.bin ? r.amount_cents / r.bin : null);
const highest = (rs: Row[]): Row | null => rs.reduce<Row | null>((m, r) => (!m || r.amount_cents > m.amount_cents
  || (r.amount_cents === m.amount_cents && r.received_at > m.received_at) ? r : m), null);

function medianPct(rs: Row[]): number | null {
  const v = rs.map(pct).filter((x): x is number => x !== null).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return round(v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2, 4);
}
function maxPct(rs: Row[]): number | null {
  const v = rs.map(pct).filter((x): x is number => x !== null);
  return v.length ? round(Math.max(...v), 4) : null;
}
/** Shares to 4 decimals that add up to exactly 1 (largest remainder); all zeros when there are no offers. */
function bandShares(rs: Row[]): Record<Band, number> {
  const out = Object.fromEntries(BANDS.map((b) => [b, 0])) as Record<Band, number>;
  if (!rs.length) return out;
  const units = 10_000;
  const parts = BANDS.map((b) => {
    const exact = (rs.filter((r) => r.band === b).length / rs.length) * units;
    return { b, floor: Math.floor(exact + 1e-9), frac: exact - Math.floor(exact + 1e-9) };
  });
  let left = units - parts.reduce((s, p) => s + p.floor, 0);
  for (const p of [...parts].sort((a, c) => c.frac - a.frac)) { if (left <= 0) break; if (p.frac > 0) { p.floor += 1; left -= 1; } }
  for (const p of parts) out[p.b] = p.floor / units;
  return out;
}

export async function perDomainOffers(db: Kysely<Database>, now: Date): Promise<Map<number, PerDomainOffers>> {
  const today = idtDay(now);
  const [s30, s90] = [idtDayStart(today, -29), idtDayStart(today, -89)];
  const out = new Map<number, PerDomainOffers>();
  const empty = (): PerDomainOffers => ({ count_30d: 0, highest_30d: null, count_90d: 0, highest_90d: null, count_all: 0, highest_all: null,
    highest_all_pct_of_bin: null, last_offer_at: null, open_for_dvir: 0 });
  for (const d of await db.selectFrom('domains').select('id').execute()) out.set(d.id, empty());
  const by = new Map<number, Row[]>();
  for (const r of await loadOffers(db)) { const l = by.get(r.domain_id); if (l) l.push(r); else by.set(r.domain_id, [r]); }
  for (const [id, rs] of by) {
    const r30 = rs.filter((r) => r.received_at >= s30);
    const r90 = rs.filter((r) => r.received_at >= s90);
    const h = (x: Row[]) => { const m = highest(x); return m ? money(m.amount_cents) : null; };
    const top = highest(rs);
    const last = rs.reduce((m, r) => (r.received_at > m ? r.received_at : m), rs[0]!.received_at);
    out.set(id, {
      count_30d: r30.length, highest_30d: h(r30), count_90d: r90.length, highest_90d: h(r90), count_all: rs.length, highest_all: h(rs),
      highest_all_pct_of_bin: top && top.bin ? round(top.amount_cents / top.bin, 4) : null, last_offer_at: toJerusalemIso(last),
      open_for_dvir: rs.filter((r) => r.routing === 'dvir' && (r.outcome === 'open' || r.outcome === 'countered')).length,
    });
  }
  return out;
}

/**
 * Per category. offers_90d and names_with_offers count only names currently `listed` (same set as names_listed, so the
 * per-listed-name rate is consistent); median/max/band shares are all-time over every offer of the category.
 */
export async function offersByStrategy(db: Kysely<Database>, now: Date): Promise<StrategyRow[]> {
  const s90 = idtDayStart(idtDay(now), -89);
  const offers = await loadOffers(db);
  const listed = await db.selectFrom('domains').select(['id', 'category']).where('status', '=', 'listed').execute();
  const cats = new Set<string>([...listed.map((d) => d.category ?? 'other'), ...offers.map((o) => o.category ?? 'other')]);
  return [...cats].sort().map((category) => {
    const names = listed.filter((d) => (d.category ?? 'other') === category);
    const all = offers.filter((o) => (o.category ?? 'other') === category);
    const r90 = all.filter((o) => o.received_at >= s90);
    const ids = new Set(names.map((d) => d.id));
    const r90L = r90.filter((o) => ids.has(o.domain_id));
    const r90Listed = r90L.length;
    const withOffers = new Set(r90L.map((o) => o.domain_id)).size;
    return {
      category, strategy: STRATEGY[category] ?? 'S7', names_listed: names.length, names_with_offers: withOffers, offers_90d: r90Listed,
      offers_per_listed_name_per_month: names.length ? round(r90Listed / names.length / 3, 2) : 0,
      median_offer_pct_of_bin: medianPct(all), max_offer_pct_of_bin: maxPct(all), band_shares: bandShares(all),
    };
  });
}

/** Offers received in [from, to), grouped. */
export async function reportOffers(db: Kysely<Database>, o: { from: Date; to: Date; groupBy: GroupBy }): Promise<GroupRow[]> {
  const rs = (await loadOffers(db)).filter((r) => r.received_at >= o.from && r.received_at < o.to);
  const keyOf = (r: Row) => (o.groupBy === 'domain' ? r.domain : o.groupBy === 'category' ? (r.category ?? 'other')
    : o.groupBy === 'source' ? r.source : toJerusalemIso(r.received_at).slice(0, 7));
  const groups = new Map<string, Row[]>();
  for (const r of rs) { const k = keyOf(r); const l = groups.get(k); if (l) l.push(r); else groups.set(k, [r]); }
  return [...groups.keys()].sort().map((key) => {
    const g = groups.get(key)!;
    const h = highest(g);
    return { key, count: g.length, highest: h ? money(h.amount_cents) : null, median_pct_of_bin: medianPct(g), max_pct_of_bin: maxPct(g), band_shares: bandShares(g) };
  });
}
