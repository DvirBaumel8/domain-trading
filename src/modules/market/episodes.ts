// CR-075 (v5.23.0) R-1, R-2: the `episodes` step. Merges the sealed snapshots (Dynadot Buy-Now listings, Dynadot closed auctions, GoDaddy auction endings)
// and the reported sales (market_sales) into market_names (one row per name x venue x listing episode) and labels every episode. Rules and test ids: docs/internal/market.md.
// Safe to run twice: the result is a pure function of the sealed sources, the sales and the clock date; an unchanged row is not rewritten.
// G-139: set-based. The step used to read every market_names row (and every sealed aftermarket row) into Node and write the changed ones back; on Neon free
// that was the biggest data-transfer-out cost. Now the fold, the closed-auction and GoDaddy rows and the labels run as SQL inside the one transaction. Only the
// sales (a small table), the rows that sales can attach to (by name) and the keys of NEW episodes (their sha1 ids are computed in Node) cross the wire.
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { chunks } from '../../core/chunks.js';
import { advisoryXactLock } from '../../core/locks.js';
import { lowCoverageSql } from '../../core/snapshot-coverage.js';
import type { Database } from '../../db/types.js';
import { addDays, bandOf, dayNum, episodeId, MIN_CENTS, sha1, sha256, splitName, tierRank, utcDay, type ListingType, type Tier } from './common.js';

/** A gap between two sightings of a name breaks an episode only if it is longer than this (R-2) and a sealed snapshot day of the source lies between them where the name is absent. */
export const GAP_DAYS = 7;
/** A sale report is attached to an episode up to this many days after its last sighting (R-2: "no sale report up to day 90"). */
export const SALE_WINDOW_DAYS = 90;

interface Sale { name: string; venue: string; price: number; date: string; id: number; source: string; url: string | null; tier: Tier; type: ListingType }
interface Cand { id: string; name: string; venue: string; first: string; last: string }

export interface EpisodesSummary {
  episodes_n: number; sold_n: number; unsold_60d_n: number; unsold_30d_n: number; unknown_n: number; sale_only_n: number;
  inserted_n: number; updated_n: number; deleted_n: number; sales_matched_n: number; sales_unmatched_n: number; sales_below_floor_n: number;
  sealed_days: Record<string, string | null>;
}

/** The label of an episode that has no sale (R-2). `open` = the name was still on the source's latest snapshot days. The `episodes` step applies the same rule in SQL (the `ruled` CTE below). */
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

// v6.3.0: market_names is a view over two tables. market_episodes (cold, wide) holds what changes only when an episode is created or its label/source changes;
// market_episode_seen (hot, narrow, fillfactor 50, only its primary key indexed) holds what the daily fold changes. This file writes the two base tables directly.
// COLD_COLS: every cold column an upsert of a whole episode replaces (feat_asof is never written here; id is the identity). HOT_COLS: the hot columns (id is the key).
const COLD_COLS = ['name', 'sld', 'tld', 'venue', 'listing_type', 'list_price_cents_first', 'first_seen', 'sale_only', 'outcome', 'outcome_rule', 'sale_price_cents', 'sale_date',
  'source', 'source_url', 'source_sha256', 'tier', 'dup_group', 'dup_sources', 'price_band', 'sale_id'] as const;
const HOT_COLS = ['last_seen', 'seen_days', 'list_price_cents_last', 'price_changes'] as const;
const COLD_LIST = sql.raw(`episode_id, ${COLD_COLS.join(', ')}, derived_at`);
const SET_COLD = sql.raw([...COLD_COLS, 'derived_at'].map((c) => `${c} = excluded.${c}`).join(', '));
/** Compare list for `ON CONFLICT ... WHERE`: derived_at is left out (a row that only differs by its stamp is not rewritten). */
const DIFFERS_COLD = sql.raw(`(${COLD_COLS.map((c) => `market_episodes.${c}`).join(', ')}) is distinct from (${COLD_COLS.map((c) => `excluded.${c}`).join(', ')})`);
const DIFFERS_HOT = sql.raw(`(${HOT_COLS.map((c) => `market_episode_seen.${c}`).join(', ')}) is distinct from (${HOT_COLS.map((c) => `excluded.${c}`).join(', ')})`);
const SET_HOT = sql.raw(HOT_COLS.map((c) => `${c} = excluded.${c}`).join(', '));
const HOT_LIST = sql.raw(HOT_COLS.join(', '));

/** bandOf() in SQL (R-1 bands, cents); null under the $500 floor. */
const bandSql = (c: string): RawBuilder<string | null> => sql.raw(`(case when ${c} is null or ${c} < ${MIN_CENTS} then null when ${c} < 100000 then '500-999' when ${c} < 250000 then '1k-2.5k' when ${c} < 500000 then '2.5k-5k' when ${c} < 1000000 then '5k-10k' else '10k+' end)`);
const WANT_PRICE = "(case when w.outcome = 'sold' then w.price else w.ll end)";

/** Every statement that changes an episode table reports the episode ids it touched into the temp table ep_touched (never to Node): `inserted` tells a new row from an updated one. */
const TOUCH_UPDATE = sql`insert into ep_touched (episode_id, inserted) select episode_id, false from u on conflict (episode_id) do nothing`;
const TOUCH_UPSERT = sql`insert into ep_touched (episode_id, inserted) select episode_id, ins from u on conflict (episode_id) do update set inserted = ep_touched.inserted or excluded.inserted`;
/** The hot upsert reports hot ids; a row the cold upsert already reported as inserted stays inserted. */
const TOUCH_HOT = sql`insert into ep_touched (episode_id, inserted) select e.episode_id, false from u join market_episodes e on e.id = u.id on conflict (episode_id) do nothing`;

/** Upserts whole episode rows (cold first, then hot) from `src`, a SELECT that returns episode_id, every COLD_COLS column, derived_at and every HOT_COLS column. */
async function upsertEpisodes(db: Kysely<Database>, src: RawBuilder<unknown>, onlyIfChanged: boolean): Promise<void> {
  await sql`with src as (${src}), u as (
      insert into market_episodes (${COLD_LIST}) select ${COLD_LIST} from src
      on conflict (episode_id) do update set ${SET_COLD} ${onlyIfChanged ? sql`where ${DIFFERS_COLD}` : sql``}
      returning episode_id, (xmax = 0) as ins
    ) ${TOUCH_UPSERT}`.execute(db);
  await sql`with src as (${src}), u as (
      insert into market_episode_seen (id, ${HOT_LIST}) select e.id, ${sql.raw(HOT_COLS.map((c) => `src.${c}`).join(', '))} from src join market_episodes e on e.episode_id = src.episode_id
      on conflict (id) do update set ${SET_HOT} where ${DIFFERS_HOT}
      returning id
    ) ${TOUCH_HOT}`.execute(db);
}

async function derive(db: Kysely<Database>, nowMs: number): Promise<EpisodesSummary> {
  const today = utcDay(nowMs);
  const at = new Date(nowMs);
  await sql`create temp table ep_touched (episode_id text primary key, inserted boolean not null) on commit drop`.execute(db);

  // 1. Dynadot Buy-Now listings: one episode per run of sightings on the source's sealed days. v5.74.0: each sealed day whose rows are still stored is folded into
  // the stored episodes (the rows are kept only datasave_aftermarket_keep_days, so a full re-derive is no longer possible). A name continues its newest episode when
  // that episode was seen on the previous sealed day or at most GAP_DAYS calendar days before; else a new episode starts (the same split rule as before). A day
  // already folded for a name (its newest episode's last_seen is that day or later) changes nothing, so a second run writes nothing.
  // v5.80.0 (CR-099): a LOW_COVERAGE day (under 90% of its pages read) is left out, so a name missing from it never ends an episode or counts as gone.
  // G-139: one UPDATE (continue) and one INSERT (new episodes) per day, in SQL.
  const am = await db.selectFrom('snapshot_manifests as m').select(['m.data_date', 'm.sha256']).where('m.source', '=', 'dynadot_aftermarket').where('m.status', '=', 'complete')
    .where(sql<boolean>`not ${lowCoverageSql('m')}`).orderBy('m.data_date').execute();
  const amSha = new Map(am.map((m) => [m.data_date, m.sha256]));
  const lastAm = am.length ? am[am.length - 1]!.data_date : null;
  const stored = new Set((await sql<{ d: string }>`select distinct data_date::text as d from dynadot_rows where kind = 'aftermarket'`.execute(db)).rows.map((r) => r.d));
  await sql`create temp table ep_seen (domain text primary key, p bigint not null) on commit drop`.execute(db);
  for (let k = 0; k < am.length; k++) {
    const day = am[k]!.data_date;
    if (!stored.has(day)) continue;
    const prevSealed = k > 0 ? am[k - 1]!.data_date : null;
    const sha = amSha.get(day) ?? null;
    await sql`truncate ep_seen`.execute(db);
    await sql`insert into ep_seen select domain, min(price_cents)::bigint from dynadot_rows where kind = 'aftermarket' and data_date = ${day}::date and price_cents >= ${MIN_CENTS} group by domain`.execute(db);
    // the continue touches only the hot table (in place, HOT): the wide cold row is not rewritten, and derived_at stays the time the episode was created or relabelled
    await sql`with latest as (
        select distinct on (c.name) c.id, c.episode_id, h.last_seen, h.list_price_cents_last, s.p
        from market_episodes c join market_episode_seen h on h.id = c.id join ep_seen s on s.domain = c.name
        where c.venue = 'dynadot' and c.listing_type = 'bin' and not c.sale_only
        order by c.name, h.last_seen desc, c.first_seen desc, c.episode_id
      ), u as (
        update market_episode_seen h set seen_days = h.seen_days + 1, price_changes = h.price_changes + (case when h.list_price_cents_last is distinct from l.p then 1 else 0 end),
          list_price_cents_last = l.p, last_seen = ${day}::date
        from latest l
        where h.id = l.id and l.last_seen < ${day}::date and ((${prevSealed}::date is not null and l.last_seen >= ${prevSealed}::date) or ${day}::date - l.last_seen <= ${GAP_DAYS}::int)
        returning l.episode_id
      ) ${TOUCH_UPDATE}`.execute(db);
    // names with no episode reaching this day start a new episode (never seen, or the gap is too long); only their names come back, to get their sha1 ids
    const fresh = (await sql<{ domain: string }>`select s.domain from ep_seen s where not exists (
        select 1 from market_episodes c join market_episode_seen h on h.id = c.id
        where c.name = s.domain and c.venue = 'dynadot' and c.listing_type = 'bin' and not c.sale_only and h.last_seen >= ${day}::date)`.execute(db)).rows.map((r) => r.domain);
    for (const part of chunks(fresh, 5000)) {
      const ids = part.map((n) => episodeId(n, 'dynadot', day, 'bin'));
      // source_sha256 is NULL for a Buy-Now row: the view derives it (the complete manifest sha of the row's last_seen day)
      await upsertEpisodes(db, sql`select t.id as episode_id, s.domain as name, split_part(s.domain, '.', 1) as sld, substr(s.domain, strpos(s.domain, '.') + 1) as tld, 'dynadot'::text as venue,
          'bin'::text as listing_type, s.p as list_price_cents_first, ${day}::date as first_seen, false as sale_only, 'unknown'::text as outcome, 'SEEN_ONCE'::text as outcome_rule,
          null::bigint as sale_price_cents, null::date as sale_date, 'dynadot_aftermarket'::text as source, null::text as source_url, null::text as source_sha256, 'B'::text as tier,
          null::text as dup_group, null::text[] as dup_sources, ${bandSql('s.p')} as price_band, null::bigint as sale_id, ${at}::timestamptz as derived_at,
          ${day}::date as last_seen, 1 as seen_days, s.p as list_price_cents_last, 0 as price_changes
        from unnest(${ids}::text[], ${part}::text[]) as t(id, name) join ep_seen s on s.domain = t.name`, false);
    }
  }

  // 2. Dynadot closed auctions (one episode per auction; a price of $500 or more at the end) and GoDaddy auction endings (official inventory files, tier A), staged in
  // ep_src inside the database. A stored row is matched by name x venue x type x first_seen, which is what episode_id hashes; only the keys of rows with no match
  // come back to Node for their ids. `bid` = the auction had a bid: its final price and end day are then the sale (SOLD_BIDS).
  await sql`create temp table ep_src (name text not null, venue text not null, ltype text not null, first_seen date not null, last_seen date not null, seen_days integer not null,
      list_last bigint not null, source text not null, sha text, tier text not null, bid_price bigint, bid_date date, primary key (name, venue, ltype, first_seen)) on commit drop`.execute(db);
  await sql`insert into ep_src
    select distinct on (c.domain, c.first_day) c.domain, 'dynadot', 'auction', c.first_day, c.first_day, 1, c.final, 'dynadot_closed_auctions', c.sha, 'B',
      case when coalesce(c.bids, 0) >= 1 then c.final end, case when coalesce(c.bids, 0) >= 1 then (c.end_time at time zone 'UTC')::date end
    from (
      select r.domain, r.end_time, max(r.bid_count) as bids, max(r.final_price_cents)::bigint as final, min(r.data_date) as first_day, min(m.sha256) as sha
      from dynadot_rows r join snapshot_manifests m on m.source = 'dynadot_closed_auctions' and m.status = 'complete' and m.data_date = r.data_date
      where r.kind = 'closed_auctions' and r.final_price_cents >= ${MIN_CENTS} and r.end_time is not null
      group by r.domain, r.end_time
    ) c
    order by c.domain, c.first_day, c.end_time desc`.execute(db);
  // the hash input is JSON.stringify([domain, end_time ISO, last_price, last_bid_count, final_state_at]) exactly as the Node version wrote it (test EP-139-2 pins it)
  await sql`insert into ep_src
    select distinct on (a.domain, a.first_seen) a.domain, 'godaddy', 'auction', a.first_seen, a.last_seen, case when a.first_seen = a.last_seen then 1 else 2 end, a.last_price_cents, 'godaddy_auction_end',
      encode(sha256(convert_to('[' || to_json(a.domain)::text || ',' || to_json(to_char(a.end_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text || ',' || a.last_price_cents || ',' || a.last_bid_count
        || ',' || coalesce(to_json(a.final_state_at::text)::text, 'null') || ']', 'UTF8')), 'hex'), 'A',
      case when a.last_bid_count >= 1 then a.last_price_cents end, case when a.last_bid_count >= 1 then (a.end_time at time zone 'UTC')::date end
    from godaddy_auctions a where a.ended and a.last_price_cents >= ${MIN_CENTS}
    order by a.domain, a.first_seen, a.id desc`.execute(db);
  // hot columns first (last_seen, seen_days, last price, price_changes), then the cold ones that really change (first price, sale_only, source, sha)
  await sql`with u as (
      update market_episode_seen h set list_price_cents_last = s.list_last, price_changes = 0, last_seen = s.last_seen, seen_days = s.seen_days
      from market_episodes c join ep_src s on s.name = c.name and s.venue = c.venue and s.ltype = c.listing_type and s.first_seen = c.first_seen
      where h.id = c.id and (h.list_price_cents_last, h.price_changes, h.last_seen, h.seen_days) is distinct from (s.list_last, 0, s.last_seen, s.seen_days)
      returning c.episode_id
    ) ${TOUCH_UPDATE}`.execute(db);
  await sql`with u as (
      update market_episodes c set list_price_cents_first = null, sale_only = false, source = s.source, source_sha256 = s.sha, derived_at = ${at}::timestamptz
      from ep_src s
      where c.name = s.name and c.venue = s.venue and c.listing_type = s.ltype and c.first_seen = s.first_seen
        and (c.list_price_cents_first, c.sale_only, c.source, c.source_sha256) is distinct from (null::bigint, false, s.source, s.sha)
      returning c.episode_id
    ) ${TOUCH_UPDATE}`.execute(db);
  const missing = (await sql<{ name: string; venue: string; ltype: ListingType; first_seen: string }>`select s.name, s.venue, s.ltype, s.first_seen::text as first_seen from ep_src s
    where not exists (select 1 from market_episodes m where m.name = s.name and m.venue = s.venue and m.listing_type = s.ltype and m.first_seen = s.first_seen)`.execute(db)).rows;
  for (const part of chunks(missing, 3000)) {
    const ids = part.map((r) => episodeId(r.name, r.venue, r.first_seen, r.ltype));
    await upsertEpisodes(db, sql`select t.id as episode_id, s.name, split_part(s.name, '.', 1) as sld, substr(s.name, strpos(s.name, '.') + 1) as tld, s.venue, s.ltype as listing_type,
          null::bigint as list_price_cents_first, s.first_seen, false as sale_only,
          case when s.bid_price is not null then 'sold'
            when s.seen_days > 1 and s.last_seen > s.first_seen and s.last_seen - s.first_seen >= 60 and ${today}::date >= s.first_seen + ${SALE_WINDOW_DAYS}::int then 'unsold' else 'unknown' end as outcome,
          case when s.bid_price is not null then 'SOLD_BIDS' when s.seen_days <= 1 or s.last_seen = s.first_seen then 'SEEN_ONCE'
            when s.last_seen - s.first_seen >= 60 and ${today}::date >= s.first_seen + ${SALE_WINDOW_DAYS}::int then 'UNSOLD_60D' else 'DISAPPEARED' end as outcome_rule,
          s.bid_price as sale_price_cents, s.bid_date as sale_date, s.source, null::text as source_url, s.sha as source_sha256, s.tier, null::text as dup_group, null::text[] as dup_sources,
          ${bandSql('s.list_last')} as price_band, null::bigint as sale_id, ${at}::timestamptz as derived_at,
          s.last_seen, s.seen_days, s.list_last as list_price_cents_last, 0 as price_changes
        from unnest(${ids}::text[], ${part.map((r) => r.name)}::text[], ${part.map((r) => r.venue)}::text[], ${part.map((r) => r.ltype)}::text[], ${part.map((r) => r.first_seen)}::date[]) as t(id, name, venue, ltype, first_seen)
          join ep_src s on s.name = t.name and s.venue = t.venue and s.ltype = t.ltype and s.first_seen = t.first_seen`, false);
  }

  // 3. sales: one winner per (name, venue, date) (highest tier), the others are recorded as dup_sources. The sales table is small; the episodes a sale can attach to are
  // read by name (only the names that have a sale).
  const saleRows = await db.selectFrom('market_sales').select(['id', 'name', 'venue', 'sale_price_cents', 'sale_date', 'source', 'source_url', 'tier', 'listing_type']).orderBy('sale_date').orderBy('id').execute();
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
  const byName = new Map<string, Cand[]>();
  for (const part of chunks([...new Set([...groups.values()].map((g) => g.win.name))], 2000)) {
    const rows = await db.selectFrom('market_names').select(['episode_id', 'name', 'venue', 'first_seen', 'last_seen']).where('name', 'in', part).where('sale_only', '=', false).orderBy('episode_id').execute();
    for (const r of rows) (byName.get(r.name) ?? byName.set(r.name, []).get(r.name)!).push({ id: r.episode_id, name: r.name, venue: r.venue, first: r.first_seen, last: r.last_seen });
  }
  const sold = new Map<string, { sale: Sale; others: string[]; dupGroup: string }>();
  let matched = 0;
  const saleOnly: Array<{ id: string; sale: Sale; others: string[]; dupGroup: string }> = [];
  for (const g of [...groups.values()].sort((a, b) => (a.win.date < b.win.date ? -1 : a.win.date > b.win.date ? 1 : a.win.id - b.win.id))) {
    const s = g.win;
    const others = [...g.others].filter((o) => o !== s.source).sort();
    const dupGroup = sha1(`${s.name}|${s.venue}|${s.date}`);
    const cands = (byName.get(s.name) ?? []).filter((e) => !sold.has(e.id) && e.first <= s.date && s.date <= addDays(e.last, SALE_WINDOW_DAYS));
    cands.sort((a, b) => Number(b.venue === s.venue) - Number(a.venue === s.venue) || (a.first < b.first ? 1 : a.first > b.first ? -1 : 0));
    const hit = cands[0];
    if (hit) { sold.set(hit.id, { sale: s, others, dupGroup }); matched++; continue; }
    const id = episodeId(s.name, s.venue, s.date, s.type);
    sold.set(id, { sale: s, others, dupGroup }); saleOnly.push({ id, sale: s, others, dupGroup });
  }
  const saleOnlyIds = saleOnly.map((e) => e.id);

  // sale-only episodes (a reported sale no listing explains): upserted whole; a row that is already identical is left alone
  for (const part of chunks(saleOnly, 1500)) {
    const json = JSON.stringify(part.map((e) => {
      const s = e.sale;
      const { sld, tld } = splitName(s.name);
      return { episode_id: e.id, name: s.name, sld, tld, venue: s.venue, listing_type: s.type, d: s.date, price: s.price, source: s.source, source_url: s.url,
        sha: sha256(JSON.stringify([s.name, s.venue, s.price, s.date, s.source, s.tier])), tier: s.tier, band: bandOf(s.price), sale_id: s.id, dup_group: e.dupGroup, dup_sources: e.others.length ? e.others : null };
    }));
    await upsertEpisodes(db, sql`select x.episode_id, x.name, x.sld, x.tld, x.venue, x.listing_type, null::bigint as list_price_cents_first, x.d as first_seen, true as sale_only, 'sold'::text as outcome,
          'SOLD_REPORTED'::text as outcome_rule, x.price as sale_price_cents, x.d as sale_date, x.source, x.source_url, x.sha as source_sha256, x.tier, x.dup_group, x.dup_sources, x.band as price_band,
          x.sale_id, ${at}::timestamptz as derived_at, x.d as last_seen, 0 as seen_days, null::bigint as list_price_cents_last, 0 as price_changes
        from jsonb_to_recordset(${json}::jsonb) as x(episode_id text, name text, sld text, tld text, venue text, listing_type text, d date, price bigint, source text, source_url text, sha text, tier text,
          band text, sale_id bigint, dup_group text, dup_sources text[])`, true);
  }
  // sale-only rows that are no longer derived (a listing now explains the sale) are removed
  const gone = (await sql<{ n: number }>`with d as (delete from market_episodes where sale_only and episode_id <> all(${saleOnlyIds}::text[]) returning episode_id)
    select count(*)::int as n from d where not exists (select 1 from ep_touched t where t.episode_id = d.episode_id and t.inserted)`.execute(db)).rows[0]!.n;

  // 4. labels: the matched sales go to a temp table, then ONE update sets sold / SOLD_BIDS / the unsold rules for every listing episode, only where something changes
  await sql`create temp table ep_sale (episode_id text primary key, sale_id bigint not null, price bigint not null, sdate date not null, url text, tier text not null, dup_group text not null, dup_sources text[]) on commit drop`.execute(db);
  const saleOnlySet = new Set(saleOnlyIds);
  const matchedRows = [...sold].filter(([id]) => !saleOnlySet.has(id)).map(([id, v]) => ({ episode_id: id, sale_id: v.sale.id, price: v.sale.price, sdate: v.sale.date, url: v.sale.url, tier: v.sale.tier, dup_group: v.dupGroup, dup_sources: v.others.length ? v.others : null }));
  for (const part of chunks(matchedRows, 3000)) {
    await sql`insert into ep_sale select * from jsonb_to_recordset(${JSON.stringify(part)}::jsonb) as x(episode_id text, sale_id bigint, price bigint, sdate date, url text, tier text, dup_group text, dup_sources text[])`.execute(db);
  }
  // sale > bid > unsold rule (labelUnsold in SQL); `open` = a dynadot bin episode seen on the source's latest sealed days; the bid comes from the staged source when the
  // source row is still there, else from the stored SOLD_BIDS row
  await sql`with base as (
      select m.episode_id, m.first_seen, h.last_seen, h.seen_days, h.list_price_cents_last as ll, sa.episode_id is not null as has_sale, sa.sale_id as sid, sa.price as sap, sa.sdate as sad, sa.url as sau, sa.tier as sat,
        sa.dup_group as dg, sa.dup_sources as ds, coalesce(s.tier, m.tier) as base_tier, s.name is not null as has_src, m.source_url as old_url,
        case when s.name is not null then s.bid_price when m.outcome_rule = 'SOLD_BIDS' then m.sale_price_cents end as bp,
        case when s.name is not null then s.bid_date when m.outcome_rule = 'SOLD_BIDS' then m.sale_date end as bd,
        m.venue = 'dynadot' and m.listing_type = 'bin' and ${lastAm}::date - h.last_seen <= ${GAP_DAYS}::int as is_open
      from market_episodes m join market_episode_seen h on h.id = m.id
        left join ep_sale sa on sa.episode_id = m.episode_id
        left join ep_src s on s.name = m.name and s.venue = m.venue and s.ltype = m.listing_type and s.first_seen = m.first_seen
      where not m.sale_only
    ), ruled as (
      select b.*, case
          when has_sale then 'SOLD_REPORTED'
          when bp is not null and bd is not null then 'SOLD_BIDS'
          when seen_days <= 1 or last_seen = first_seen then 'SEEN_ONCE'
          when is_open then case when last_seen - first_seen >= 60 then 'UNSOLD_60D' when last_seen - first_seen >= 30 then 'UNSOLD_30D' else 'TOO_SHORT' end
          when last_seen - first_seen >= 60 and ${today}::date >= first_seen + ${SALE_WINDOW_DAYS}::int then 'UNSOLD_60D'
          else 'DISAPPEARED' end as rule
      from base b
    ), want as (
      select r.episode_id, r.rule,
        case when r.rule like 'SOLD%' then 'sold' when r.rule like 'UNSOLD%' then 'unsold' else 'unknown' end as outcome,
        case r.rule when 'SOLD_REPORTED' then r.sap when 'SOLD_BIDS' then r.bp end as price,
        case r.rule when 'SOLD_REPORTED' then r.sad when 'SOLD_BIDS' then r.bd end as sdt,
        case when r.rule = 'SOLD_REPORTED' then r.sid end as sid, case when r.rule = 'SOLD_REPORTED' then r.dg end as dg, case when r.rule = 'SOLD_REPORTED' then r.ds end as ds,
        case when r.has_sale then least(r.base_tier, r.sat) else r.base_tier end as tier,
        case when r.has_sale and r.sau is not null then r.sau when r.has_src then null else r.old_url end as url,
        r.ll
      from ruled r
    ), u as (
      update market_episodes m set outcome = w.outcome, outcome_rule = w.rule, sale_price_cents = w.price, sale_date = w.sdt, sale_id = w.sid, dup_group = w.dg, dup_sources = w.ds, tier = w.tier, source_url = w.url,
        price_band = coalesce(${bandSql(WANT_PRICE)}, m.price_band), derived_at = ${at}::timestamptz
      from want w
      where m.episode_id = w.episode_id
        and (m.outcome, m.outcome_rule, m.sale_price_cents, m.sale_date, m.sale_id, m.dup_group, m.dup_sources, m.tier, m.source_url, m.price_band)
          is distinct from (w.outcome, w.rule, w.price, w.sdt, w.sid, w.dg, w.ds, w.tier, w.url, coalesce(${bandSql(WANT_PRICE)}, m.price_band))
      returning m.episode_id
    ) ${TOUCH_UPDATE}`.execute(db);

  // 5. the summary, counted inside the database
  const c = (await sql<{ episodes_n: number; sold_n: number; u60: number; u30: number; unk: number; sale_only_n: number }>`select count(*)::int as episodes_n,
      count(*) filter (where outcome = 'sold')::int as sold_n, count(*) filter (where outcome <> 'sold' and outcome_rule = 'UNSOLD_60D')::int as u60,
      count(*) filter (where outcome <> 'sold' and outcome_rule = 'UNSOLD_30D')::int as u30,
      count(*) filter (where outcome <> 'sold' and outcome_rule not in ('UNSOLD_60D', 'UNSOLD_30D'))::int as unk, count(*) filter (where sale_only)::int as sale_only_n from market_episodes`.execute(db)).rows[0]!;
  const t = (await sql<{ inserted: number; updated: number }>`select count(*) filter (where inserted)::int as inserted, count(*) filter (where not inserted)::int as updated from ep_touched`.execute(db)).rows[0]!;
  return {
    episodes_n: c.episodes_n, sold_n: c.sold_n, unsold_60d_n: c.u60, unsold_30d_n: c.u30, unknown_n: c.unk, sale_only_n: c.sale_only_n,
    inserted_n: t.inserted, updated_n: t.updated, deleted_n: gone,
    sales_matched_n: matched, sales_unmatched_n: saleOnly.length, sales_below_floor_n: belowFloor,
    sealed_days: { dynadot_aftermarket: lastAm },
  };
}
