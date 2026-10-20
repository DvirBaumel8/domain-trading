// CR-075 (v5.23.0) R-1, R-2: the `episodes` step. Merges the sealed snapshots (Dynadot Buy-Now listings, Dynadot closed auctions, GoDaddy auction endings)
// and the reported sales (market_sales) into market_names (one row per name x venue x listing episode) and labels every episode. Rules and test ids: docs/internal/market.md.
// Safe to run twice: the result is a pure function of the sealed sources, the sales and the clock date; an unchanged row is not rewritten.
import { sql, type Insertable, type Kysely } from 'kysely';
import { chunks } from '../../core/chunks.js';
import { advisoryXactLock } from '../../core/locks.js';
import type { Database } from '../../db/types.js';
import { addDays, bandOf, dayNum, episodeId, MIN_CENTS, sha1, sha256, splitName, tierRank, utcDay, type ListingType, type Tier } from './common.js';

/** A gap between two sightings of a name breaks an episode only if it is longer than this (R-2) and a sealed snapshot day of the source lies between them where the name is absent. */
export const GAP_DAYS = 7;
/** A sale report is attached to an episode up to this many days after its last sighting (R-2: "no sale report up to day 90"). */
export const SALE_WINDOW_DAYS = 90;

interface Sale { name: string; venue: string; price: number; date: string; id: number; source: string; url: string | null; tier: Tier; type: ListingType }
interface Ep {
  id: string; name: string; venue: string; type: ListingType; first: string; last: string; seenDays: number;
  listFirst: number | null; listLast: number | null; changes: number;
  source: string; sourceUrl: string | null; sha: string | null; tier: Tier; saleOnly: boolean;
  bid: { price: number; date: string } | null;
  // result
  outcome?: 'sold' | 'unsold' | 'unknown'; rule?: string; salePrice?: number | null; saleDate?: string | null; saleId?: number | null; dupGroup?: string | null; dupSources?: string[] | null;
}

export interface EpisodesSummary {
  episodes_n: number; sold_n: number; unsold_60d_n: number; unsold_30d_n: number; unknown_n: number; sale_only_n: number;
  inserted_n: number; updated_n: number; deleted_n: number; sales_matched_n: number; sales_unmatched_n: number; sales_below_floor_n: number;
  sealed_days: Record<string, string | null>;
}

const best = (a: Tier, b: Tier): Tier => (tierRank(a) <= tierRank(b) ? a : b);

/** The label of an episode that has no sale (R-2). `open` = the name was still on the source's latest snapshot days. */
export function labelUnsold(e: { first: string; last: string; seenDays: number }, open: boolean, today: string): { outcome: 'unsold' | 'unknown'; rule: string } {
  const span = dayNum(e.last) - dayNum(e.first);
  if (e.seenDays <= 1 || span === 0) return { outcome: 'unknown', rule: 'SEEN_ONCE' };
  if (open) {
    if (span >= 60) return { outcome: 'unsold', rule: 'UNSOLD_60D' };
    if (span >= 30) return { outcome: 'unsold', rule: 'UNSOLD_30D' };
    return { outcome: 'unknown', rule: 'TOO_SHORT' };
  }
  // gone from the source: a sale could explain it, so it counts as unsold only once the 90 days for a sale report have passed
  if (span >= 60 && dayNum(today) >= dayNum(e.first) + SALE_WINDOW_DAYS) return { outcome: 'unsold', rule: 'UNSOLD_60D' };
  return { outcome: 'unknown', rule: 'DISAPPEARED' };
}

export async function runEpisodes(db: Kysely<Database>, nowMs: number): Promise<EpisodesSummary> {
  return db.transaction().execute(async (trx) => {
    await advisoryXactLock(trx, 'market_episodes');
    return derive(trx, nowMs);
  });
}

async function derive(db: Kysely<Database>, nowMs: number): Promise<EpisodesSummary> {
  const today = utcDay(nowMs);
  const eps = new Map<string, Ep>();
  const existing = await db.selectFrom('market_names').selectAll().execute();
  const before = new Map(existing.map((r) => [r.episode_id, r]));
  const byNameVenue = new Map<string, Ep[]>();
  const index = (e: Ep) => { const k = `${e.name}|${e.venue}|${e.type}`; (byNameVenue.get(k) ?? byNameVenue.set(k, []).get(k)!).push(e); };

  // 1. what is stored already (sale-only episodes are rebuilt from the sales below)
  for (const r of existing) {
    if (r.sale_only) continue;
    const e: Ep = {
      id: r.episode_id, name: r.name, venue: r.venue, type: r.listing_type, first: r.first_seen, last: r.last_seen, seenDays: r.seen_days, listFirst: r.list_price_cents_first, listLast: r.list_price_cents_last,
      changes: r.price_changes, source: r.source, sourceUrl: r.source_url, sha: r.source_sha256, tier: r.tier, saleOnly: false,
      bid: r.outcome_rule === 'SOLD_BIDS' && r.sale_price_cents !== null && r.sale_date !== null ? { price: r.sale_price_cents, date: r.sale_date } : null,
    };
    eps.set(e.id, e); index(e);
  }

  // 2. Dynadot Buy-Now listings: one episode per run of sightings on the source's sealed days
  const am = await db.selectFrom('snapshot_manifests').select(['data_date', 'sha256']).where('source', '=', 'dynadot_aftermarket').where('status', '=', 'complete').orderBy('data_date').execute();
  const amSha = new Map(am.map((m) => [m.data_date, m.sha256]));
  const lastAm = am.length ? am[am.length - 1]!.data_date : null;
  const islands = await sql<{ domain: string; first_seen: string; last_seen: string; n: number; first_p: number; last_p: number; changes: number }>`
    with sealed as (select data_date, row_number() over (order by data_date) as rn from snapshot_manifests where source = 'dynadot_aftermarket' and status = 'complete'),
    obs as (select r.domain, r.data_date, s.rn, min(r.price_cents) as p from dynadot_rows r join sealed s on s.data_date = r.data_date
            where r.kind = 'aftermarket' and r.price_cents >= ${MIN_CENTS} group by r.domain, r.data_date, s.rn),
    flagged as (select domain, data_date, rn, p, lag(p) over w as prevp,
                  case when lag(rn) over w is null or ((rn - lag(rn) over w) > 1 and (data_date - lag(data_date) over w) > ${GAP_DAYS}) then 1 else 0 end as brk
                from obs window w as (partition by domain order by data_date)),
    isl as (select *, sum(brk) over (partition by domain order by data_date rows unbounded preceding) as grp from flagged)
    select domain, min(data_date)::text as first_seen, max(data_date)::text as last_seen, count(*)::int as n,
           (array_agg(p order by data_date))[1] as first_p, (array_agg(p order by data_date desc))[1] as last_p,
           (count(*) filter (where brk = 0 and prevp is not null and prevp <> p))::int as changes
    from isl group by domain, grp`.execute(db);
  for (const i of islands.rows) {
    const name = i.domain;
    const d: Ep = { id: episodeId(name, 'dynadot', i.first_seen, 'bin'), name, venue: 'dynadot', type: 'bin', first: i.first_seen, last: i.last_seen, seenDays: i.n, listFirst: i.first_p, listLast: i.last_p, changes: i.changes,
      source: 'dynadot_aftermarket', sourceUrl: null, sha: amSha.get(i.last_seen) ?? null, tier: 'B', saleOnly: false, bid: null };
    // the oldest days may be pruned (120 days): a derived run that starts later than a stored episode of the same name, within the gap rule, continues that episode
    const prior = (byNameVenue.get(`${name}|dynadot|bin`) ?? []).find((p) => p.id !== d.id && p.first < d.first && dayNum(d.first) - dayNum(p.last) <= GAP_DAYS);
    if (prior) {
      d.id = prior.id; d.first = prior.first; d.listFirst = prior.listFirst; d.changes = prior.changes + d.changes;
      d.seenDays = d.first <= prior.last && prior.last >= i.first_seen ? Math.max(prior.seenDays, d.seenDays) : prior.seenDays + d.seenDays;
    }
    const old = eps.get(d.id);
    if (old) { Object.assign(old, d); } else { eps.set(d.id, d); index(d); }
  }

  // 3. Dynadot closed auctions (one episode per auction; a price of $500 or more at the end)
  const closed = await sql<{ domain: string; end_time: Date; bid_count: number; final_price_cents: number; first_day: string; sha: string | null }>`
    select r.domain, r.end_time, max(r.bid_count) as bid_count, max(r.final_price_cents) as final_price_cents, min(r.data_date)::text as first_day, min(m.sha256) as sha
    from dynadot_rows r join snapshot_manifests m on m.source = 'dynadot_closed_auctions' and m.status = 'complete' and m.data_date = r.data_date
    where r.kind = 'closed_auctions' and r.final_price_cents >= ${MIN_CENTS} and r.end_time is not null
    group by r.domain, r.end_time`.execute(db);
  for (const c of closed.rows) {
    const bids = c.bid_count ?? 0;
    const e: Ep = { id: episodeId(c.domain, 'dynadot', c.first_day, 'auction'), name: c.domain, venue: 'dynadot', type: 'auction', first: c.first_day, last: c.first_day, seenDays: 1, listFirst: null, listLast: c.final_price_cents, changes: 0,
      source: 'dynadot_closed_auctions', sourceUrl: null, sha: c.sha, tier: 'B', saleOnly: false, bid: bids >= 1 ? { price: c.final_price_cents, date: utcDay(c.end_time.getTime()) } : null };
    const old = eps.get(e.id);
    if (old) Object.assign(old, e); else { eps.set(e.id, e); index(e); }
  }

  // 4. GoDaddy auction endings (official inventory files, tier A)
  const gd = await db.selectFrom('godaddy_auctions').selectAll().where('ended', '=', true).where('last_price_cents', '>=', MIN_CENTS).execute();
  for (const a of gd) {
    const e: Ep = { id: episodeId(a.domain, 'godaddy', a.first_seen, 'auction'), name: a.domain, venue: 'godaddy', type: 'auction', first: a.first_seen, last: a.last_seen, seenDays: a.first_seen === a.last_seen ? 1 : 2,
      listFirst: null, listLast: a.last_price_cents, changes: 0, source: 'godaddy_auction_end',
      sourceUrl: null, sha: sha256(JSON.stringify([a.domain, a.end_time.toISOString(), a.last_price_cents, a.last_bid_count, a.final_state_at])), tier: 'A', saleOnly: false,
      bid: a.last_bid_count >= 1 ? { price: a.last_price_cents, date: utcDay(a.end_time.getTime()) } : null };
    const old = eps.get(e.id);
    if (old) Object.assign(old, e); else { eps.set(e.id, e); index(e); }
  }

  // 5. sales: one winner per (name, venue, date) (highest tier), the others are recorded as dup_sources
  const saleRows = await db.selectFrom('market_sales').selectAll().orderBy('sale_date').orderBy('id').execute();
  const belowFloor = saleRows.filter((s) => s.sale_price_cents < MIN_CENTS).length;
  const groups = new Map<string, { win: Sale; others: Set<string> }>();
  for (const s of saleRows) {
    if (s.sale_price_cents < MIN_CENTS) continue;
    const sale: Sale = { name: s.name, venue: s.venue, price: s.sale_price_cents, date: s.sale_date, id: s.id, source: s.source, url: s.source_url, tier: s.tier, type: s.listing_type };
    const k = `${s.name}|${s.venue}|${s.sale_date}`;
    const g = groups.get(k);
    if (!g) { groups.set(k, { win: sale, others: new Set() }); continue; }
    if (tierRank(sale.tier) < tierRank(g.win.tier)) { g.others.add(g.win.source); g.win = sale; } else g.others.add(sale.source);
  }
  const byName = new Map<string, Ep[]>();
  for (const e of eps.values()) (byName.get(e.name) ?? byName.set(e.name, []).get(e.name)!).push(e);
  const sold = new Map<string, { sale: Sale; others: string[]; dupGroup: string }>();
  let matched = 0;
  const saleOnly: Ep[] = [];
  for (const g of [...groups.values()].sort((a, b) => (a.win.date < b.win.date ? -1 : a.win.date > b.win.date ? 1 : a.win.id - b.win.id))) {
    const s = g.win;
    const others = [...g.others].filter((o) => o !== s.source).sort();
    const dupGroup = sha1(`${s.name}|${s.venue}|${s.date}`);
    const cands = (byName.get(s.name) ?? []).filter((e) => !sold.has(e.id) && e.first <= s.date && s.date <= addDays(e.last, SALE_WINDOW_DAYS));
    cands.sort((a, b) => Number(b.venue === s.venue) - Number(a.venue === s.venue) || (a.first < b.first ? 1 : a.first > b.first ? -1 : 0));
    const hit = cands[0];
    if (hit) { sold.set(hit.id, { sale: s, others, dupGroup }); matched++; continue; }
    const e: Ep = { id: episodeId(s.name, s.venue, s.date, s.type), name: s.name, venue: s.venue, type: s.type, first: s.date, last: s.date, seenDays: 0, listFirst: null, listLast: null, changes: 0,
      source: s.source, sourceUrl: s.url, sha: sha256(JSON.stringify([s.name, s.venue, s.price, s.date, s.source, s.tier])), tier: s.tier, saleOnly: true, bid: null };
    sold.set(e.id, { sale: s, others, dupGroup }); saleOnly.push(e);
  }
  for (const e of saleOnly) eps.set(e.id, e);

  // 6. labels and rows
  const rows: Insertable<Database['market_names']>[] = [];
  const counts = { sold: 0, u60: 0, u30: 0, unk: 0 };
  for (const e of eps.values()) {
    const sale = sold.get(e.id);
    let tier = e.tier;
    if (sale) {
      e.outcome = 'sold'; e.rule = 'SOLD_REPORTED'; e.salePrice = sale.sale.price; e.saleDate = sale.sale.date; e.saleId = sale.sale.id;
      e.dupGroup = sale.dupGroup; e.dupSources = sale.others.length ? sale.others : null;
      tier = best(tier, sale.sale.tier);
      if (!e.saleOnly && sale.sale.url) e.sourceUrl = sale.sale.url;
    } else if (e.bid) {
      e.outcome = 'sold'; e.rule = 'SOLD_BIDS'; e.salePrice = e.bid.price; e.saleDate = e.bid.date; e.saleId = null; e.dupGroup = null; e.dupSources = null;
    } else {
      const open = e.venue === 'dynadot' && e.type === 'bin' && lastAm !== null && dayNum(lastAm) - dayNum(e.last) <= GAP_DAYS;
      const l = labelUnsold(e, open, today);
      e.outcome = l.outcome; e.rule = l.rule; e.salePrice = null; e.saleDate = null; e.saleId = null; e.dupGroup = null; e.dupSources = null;
    }
    const band = bandOf(e.outcome === 'sold' ? e.salePrice : e.listLast);
    if (band === null) continue;
    if (e.outcome === 'sold') counts.sold++; else if (e.rule === 'UNSOLD_60D') counts.u60++; else if (e.rule === 'UNSOLD_30D') counts.u30++; else counts.unk++;
    const { sld, tld } = splitName(e.name);
    rows.push({
      episode_id: e.id, name: e.name, sld, tld, venue: e.venue, listing_type: e.type, list_price_cents_first: e.listFirst, list_price_cents_last: e.listLast, price_changes: e.changes,
      first_seen: e.first, last_seen: e.last, days_listed: dayNum(e.last) - dayNum(e.first), seen_days: e.seenDays, sale_only: e.saleOnly, outcome: e.outcome, outcome_rule: e.rule!,
      sale_price_cents: e.salePrice ?? null, sale_date: e.saleDate ?? null, source: e.source, source_url: e.sourceUrl, source_sha256: e.sha, tier, feat_asof: null,
      dup_group: e.dupGroup ?? null, dup_sources: e.dupSources ?? null, price_band: band, sale_id: e.saleId ?? null,
    } as unknown as Insertable<Database['market_names']>);
  }

  // 7. write: only the rows that changed; the rows that are no longer derived (a sale-only episode a listing now explains) are removed
  const same = (a: Insertable<Database['market_names']>, b: Insertable<Database['market_names']>): boolean =>
    (['name', 'venue', 'listing_type', 'list_price_cents_first', 'list_price_cents_last', 'price_changes', 'first_seen', 'last_seen', 'days_listed', 'seen_days', 'sale_only', 'outcome', 'outcome_rule', 'sale_price_cents', 'sale_date',
      'source', 'source_url', 'source_sha256', 'tier', 'dup_group', 'price_band', 'sale_id'] as const).every((k) => a[k] === b[k]) &&
    JSON.stringify(a.dup_sources ?? null) === JSON.stringify(b.dup_sources ?? null);
  const keep = new Set(rows.map((r) => r.episode_id));
  const changed = rows.filter((r) => { const o = before.get(r.episode_id); return !o || !same(o as unknown as Insertable<Database['market_names']>, r); });
  const gone = existing.filter((r) => !keep.has(r.episode_id)).map((r) => r.episode_id);
  const at = new Date(nowMs);
  for (const part of chunks(changed, 500)) {
    await db.insertInto('market_names').values(part.map((r) => ({ ...r, derived_at: at, dup_sources: r.dup_sources } as never)))
      .onConflict((oc) => oc.column('episode_id').doUpdateSet((eb) => ({
        name: eb.ref('excluded.name'), sld: eb.ref('excluded.sld'), tld: eb.ref('excluded.tld'), venue: eb.ref('excluded.venue'), listing_type: eb.ref('excluded.listing_type'),
        list_price_cents_first: eb.ref('excluded.list_price_cents_first'), list_price_cents_last: eb.ref('excluded.list_price_cents_last'), price_changes: eb.ref('excluded.price_changes'),
        first_seen: eb.ref('excluded.first_seen'), last_seen: eb.ref('excluded.last_seen'), days_listed: eb.ref('excluded.days_listed'), seen_days: eb.ref('excluded.seen_days'),
        sale_only: eb.ref('excluded.sale_only'), outcome: eb.ref('excluded.outcome'), outcome_rule: eb.ref('excluded.outcome_rule'), sale_price_cents: eb.ref('excluded.sale_price_cents'),
        sale_date: eb.ref('excluded.sale_date'), source: eb.ref('excluded.source'), source_url: eb.ref('excluded.source_url'), source_sha256: eb.ref('excluded.source_sha256'),
        tier: eb.ref('excluded.tier'), dup_group: eb.ref('excluded.dup_group'), dup_sources: eb.ref('excluded.dup_sources'), price_band: eb.ref('excluded.price_band'),
        sale_id: eb.ref('excluded.sale_id'), derived_at: eb.ref('excluded.derived_at'),
      }))).execute();
  }
  for (const part of chunks(gone, 1000)) await db.deleteFrom('market_names').where('episode_id', 'in', part).execute();
  return {
    episodes_n: rows.length, sold_n: counts.sold, unsold_60d_n: counts.u60, unsold_30d_n: counts.u30, unknown_n: counts.unk, sale_only_n: rows.filter((r) => r.sale_only).length,
    inserted_n: changed.filter((r) => !before.has(r.episode_id)).length, updated_n: changed.filter((r) => before.has(r.episode_id)).length, deleted_n: gone.length,
    sales_matched_n: matched, sales_unmatched_n: saleOnly.length, sales_below_floor_n: belowFloor,
    sealed_days: { dynadot_aftermarket: lastAm },
  };
}
