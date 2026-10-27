// v5.49.0 (P4): paper trading of the auction shortlist. Nothing here buys or bids: it only records what the shortlist said and what the auction did afterwards, so "would our maximum have won?" is answered
// by our own data. Called by the datasave step `auctionShortlist` (ops/auctions/shortlist.ts): `updateOutcomes` first (open rows from the newest godaddy_auctions_live snapshot, bulk SQL), `recordOutcomes` last
// (the day's served names and the control). Rules and test ids: docs/internal/auctions.md "Paper trading".
//   group shortlist = the served top names of the data date (rank, score, suggested maximum). group control = 25 names of the same field that are NOT in the top, chosen by ascending md5(domain || data_date)
//   (deterministic, random in effect). A row is final when its end time has passed and a snapshot of a LATER UTC day than the end day exists (the once-a-day snapshot at 14:08 UTC then has certainly seen the end).
//   The last price seen is the final price when the ended-auction tracker (godaddy_auctions, followed from $100) has the end state; otherwise it is a LOWER BOUND (the auction may have risen after the last
//   snapshot, up to just under $100 because an untracked auction never reached the tracker's floor), so would_win is an optimistic upper bound. would_win = suggested maximum above the final price (shortlist rows only).
import { sql, type Kysely } from 'kysely';
import { chunks } from '../../../core/chunks.js';
import { idtDay, addDays } from '../../../core/dates.js';
import type { Database } from '../../../db/types.js';

export const CONTROL_N = 25;
export const OUTCOME_KEEP_DAYS = 120;

export interface OutcomeRow { domain: string; group: 'shortlist' | 'control'; rank: number | null; score: number | null; max_bid_suggested_cents: number | null; first_price_cents: number; end_time: Date }

export interface OutcomeUpdate { deleted_n: number; seen_updated_n: number; finalized_n: number }

/** Updates the open rows from the newest snapshot, finalises the ended ones, deletes rows older than OUTCOME_KEEP_DAYS. Three bulk statements, no per-row queries. */
export async function updateOutcomes(db: Kysely<Database>, nowMs: number): Promise<OutcomeUpdate> {
  const cut = addDays(idtDay(nowMs), -OUTCOME_KEEP_DAYS);
  const del = await sql`delete from auction_outcomes where data_date < ${cut}::date`.execute(db);
  // the newest snapshot row of every open name (one auction: it ended no more than 3 days after the end time we stored; an extended auction moves its end time)
  const seen = await sql`update auction_outcomes o set prev_seen_price_cents = case when o.last_seen_at is not null and s.data_date::timestamptz > o.last_seen_at then o.last_seen_price_cents else o.prev_seen_price_cents end, last_seen_price_cents = greatest(coalesce(o.last_seen_price_cents, 0), s.price_cents), last_seen_bids = greatest(coalesce(o.last_seen_bids, 0), s.bid_count),
      last_seen_at = s.data_date::timestamptz, end_time = greatest(o.end_time, s.end_time)
    from (select distinct on (l.domain) l.domain, l.data_date, l.price_cents, l.bid_count, l.end_time from godaddy_auctions_live l
          where l.domain in (select domain from auction_outcomes where not final) order by l.domain, l.data_date desc) s
    where o.domain = s.domain and not o.final and s.data_date >= o.data_date and s.end_time <= o.end_time + interval '3 days' and (o.last_seen_at is null or s.data_date::timestamptz >= o.last_seen_at)`.execute(db);
  const fin = await sql`with f as (
      select o.data_date, o.domain, coalesce(g.p, o.last_seen_price_cents, o.first_price_cents) as price, coalesce(g.b, o.last_seen_bids) as bids
      from auction_outcomes o cross join (select max(data_date) as newest from godaddy_auctions_live) n
      left join lateral (select a.last_price_cents as p, a.last_bid_count as b from godaddy_auctions a
        where a.ended and a.domain = o.domain and a.end_time between o.end_time - interval '3 days' and o.end_time + interval '3 days' order by a.end_time desc limit 1) g on true
      where not o.final and o.end_time < ${new Date(nowMs)} and n.newest > (o.end_time at time zone 'UTC')::date)
    update auction_outcomes o set final = true, last_seen_price_cents = f.price, last_seen_bids = f.bids,
      would_win = case when o."group" = 'shortlist' and o.max_bid_suggested_cents is not null then f.price < o.max_bid_suggested_cents else null end
    from f where o.data_date = f.data_date and o.domain = f.domain`.execute(db);
  return { deleted_n: Number(del.numAffectedRows ?? 0), seen_updated_n: Number(seen.numAffectedRows ?? 0), finalized_n: Number(fin.numAffectedRows ?? 0) };
}

/** The deterministic random control: `n` names of the field that are not in `exclude`, the smallest md5(domain || data_date) first. */
export async function pickControl(db: Kysely<Database>, dataDate: string, field: ReadonlyArray<{ domain: string }>, exclude: ReadonlySet<string>, n = CONTROL_N): Promise<string[]> {
  const names = field.map((f) => f.domain).filter((d) => !exclude.has(d));
  if (names.length === 0) return [];
  const rows = (await sql<{ domain: string }>`select d as domain from unnest(${names}::text[]) as u(d) order by md5(d || ${dataDate}), d limit ${n}`.execute(db)).rows;
  return rows.map((r) => r.domain);
}

/** Stores the day's rows (replace the date's set in one transaction; an end state already read for a name that stays is kept). */
export async function recordOutcomes(db: Kysely<Database>, dataDate: string, rows: readonly OutcomeRow[]): Promise<{ shortlist_n: number; control_n: number }> {
  await db.transaction().execute(async (trx) => {
    await sql`delete from auction_outcomes where data_date = ${dataDate}::date and not (domain = any(${rows.map((r) => r.domain)}::text[]))`.execute(trx);
    for (const part of chunks([...rows], 200)) {
      await sql`insert into auction_outcomes (data_date, domain, "group", rank, score, max_bid_suggested_cents, first_price_cents, end_time)
        select ${dataDate}::date, u.domain, u.grp, u.rank, u.score, u.max_bid, u.price, u.end_time
        from unnest(${part.map((r) => r.domain)}::text[], ${part.map((r) => r.group)}::text[], ${part.map((r) => r.rank)}::int[], ${part.map((r) => r.score)}::numeric[], ${part.map((r) => r.max_bid_suggested_cents)}::int[],
          ${part.map((r) => r.first_price_cents)}::int[], ${part.map((r) => r.end_time)}::timestamptz[]) as u(domain, grp, rank, score, max_bid, price, end_time)
        on conflict (data_date, domain) do update set "group" = excluded."group", rank = excluded.rank, score = excluded.score, max_bid_suggested_cents = excluded.max_bid_suggested_cents`.execute(trx);
    }
  });
  return { shortlist_n: rows.filter((r) => r.group === 'shortlist').length, control_n: rows.filter((r) => r.group === 'control').length };
}
