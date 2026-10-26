// v5.59.0 (CR-081): the outcomes of the replayed names, read from data stored AFTER day D (never used by the logic). Labels are true / false / null (unknown).
//   auctions   reached_100 (final >= $100), beat_our_max (final >= our suggested maximum). Final = the ended-auction tracker (godaddy_auctions, ended) when it has the name,
//              else the last archived price and bids of the name before its end time (`basis: last_archived`, a lower bound: bids come late). `ended` = the tracker says so, or the end
//              time is before the start of the newest archived day.
//   closeouts  taken (RDAP tag `held` in closeout_expiries: bought or renewed) vs dropped; weak signal; pending until D+30, only stored results, no live lookups.
//   both       retail_sale / retail_500: a later reported retail sale (market_sales with a listing type other than closeout, engine_sales not from the GoDaddy auction file).
import { sql, type Kysely } from 'kysely';
import { addDays } from '../../../core/dates.js';
import type { Database } from '../../../db/types.js';
import { archivedDays, readArchive } from '../archive/godaddy-archive.js';
import { type Ranked, type ReplayKind } from './logic.js';

export const RETAIL_BIG_CENTS = 50_000;

export interface NameOutcome {
  labels: Record<string, boolean | null>;
  final_price_cents: number | null; final_bids: number | null; basis: 'godaddy_auctions' | 'last_archived' | null; ended: boolean | null;
  rdap_tag: string | null; retail: Array<{ price_cents: number; sale_date: string; venue: string; source: string }>;
}
export interface OutcomeSet {
  byName: Map<string, NameOutcome>;
  labels: string[];
  status: { retail: { status: 'ok' | 'no_data'; sales_after_d_n: number }; rdap?: { status: 'pending' | 'ready'; ready_on: string; stored_n: number }; auctions?: { archived_days_after_d: number; newest_archived_day: string | null } };
}

const DAY = 86_400_000;

/** Last archived row of each target name, from the biddable files of day D onward (rows whose snapshot day is not after the auction's end day). */
async function lastArchived(archiveRoot: string, date: string, targets: Map<string, number | null>): Promise<{ last: Map<string, { price: number; bids: number }>; days: string[] }> {
  const days = (await archivedDays(archiveRoot, 'all_biddable_auctions')).filter((d) => d >= date);
  const last = new Map<string, { price: number; bids: number }>();
  for (const day of days) {
    try {
      for await (const raw of readArchive(archiveRoot, day, 'all_biddable_auctions')) {
        const name = typeof raw.domainName === 'string' ? raw.domainName.trim().toLowerCase() : '';
        if (!targets.has(name)) continue;
        const endMs = typeof raw.auctionEndTime === 'string' ? Date.parse(raw.auctionEndTime) : NaN;
        const want = targets.get(name);
        if (want !== null && want !== undefined && !Number.isNaN(endMs) && Math.abs(endMs - want) > 3 * DAY) continue; // another auction of the same name
        if (!Number.isNaN(endMs) && day > new Date(endMs).toISOString().slice(0, 10)) continue; // listed again after it ended
        const m = /^\$?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)$/.exec(String(raw.price ?? '').trim());
        const price = m ? Math.round(Number(m[1]!.replace(/,/g, '')) * 100) : null;
        if (price === null) continue;
        const bids = typeof raw.numberOfBids === 'number' ? raw.numberOfBids : 0;
        last.set(name, { price, bids });
      }
    } catch { /* a missing or damaged day adds nothing */ }
  }
  return { last, days };
}

export async function readOutcomes(db: Kysely<Database>, archiveRoot: string, o: { date: string; kind: ReplayKind; names: readonly Ranked[]; nowMs: number }): Promise<OutcomeSet> {
  const { date, kind, names } = o;
  const list = names.map((r) => r.row.domain);
  const byName = new Map<string, NameOutcome>(list.map((d) => [d, { labels: {}, final_price_cents: null, final_bids: null, basis: null, ended: null, rdap_tag: null, retail: [] }]));
  const status: OutcomeSet['status'] = { retail: { status: 'no_data', sales_after_d_n: 0 } };
  const labels: string[] = [];

  if (kind === 'auctions') {
    labels.push('reached_100', 'beat_our_max');
    const arch = await lastArchived(archiveRoot, date, new Map(names.map((r) => [r.row.domain, r.row.end_time?.getTime() ?? null])));
    const newest = (await archivedDays(archiveRoot, 'all_biddable_auctions')).at(-1) ?? null;
    status.auctions = { archived_days_after_d: arch.days.filter((d) => d > date).length, newest_archived_day: newest };
    const tracked = list.length === 0 ? [] : (await sql<{ domain: string; p: number; b: number; end_time: Date }>`
      select distinct on (domain) domain, last_price_cents as p, last_bid_count as b, end_time from godaddy_auctions
      where ended and domain = any(${list}::text[]) and end_time > ${new Date(Date.parse(`${date}T00:00:00Z`))} order by domain, end_time desc`.execute(db)).rows;
    const trackedBy = new Map(tracked.map((t) => [t.domain, t]));
    for (const r of names) {
      const out = byName.get(r.row.domain)!;
      const t = trackedBy.get(r.row.domain);
      const a = arch.last.get(r.row.domain);
      if (t) { out.final_price_cents = t.p; out.final_bids = t.b; out.basis = 'godaddy_auctions'; out.ended = true; }
      else if (a) {
        out.final_price_cents = Math.max(a.price, r.row.price_cents); out.final_bids = Math.max(a.bids, r.row.bids); out.basis = 'last_archived';
        out.ended = r.row.end_time !== null && newest !== null ? r.row.end_time.getTime() < Date.parse(`${newest}T00:00:00Z`) : null;
      }
      if (out.final_price_cents !== null && out.ended) {
        out.labels.reached_100 = out.final_price_cents >= 10_000;
        out.labels.beat_our_max = out.final_price_cents >= r.max_bid_cents;
      } else { out.labels.reached_100 = null; out.labels.beat_our_max = null; }
    }
  } else {
    labels.push('taken');
    const readyOn = addDays(date, 30);
    const tags = list.length === 0 ? [] : (await sql<{ domain: string; tag: string }>`
      select distinct on (domain) domain, tag from closeout_expiries where domain = any(${list}::text[]) and ends_on >= ${date}::date order by domain, ends_on desc`.execute(db)).rows;
    const tagBy = new Map(tags.map((t) => [t.domain, t.tag]));
    status.rdap = { status: o.nowMs >= Date.parse(`${readyOn}T00:00:00Z`) ? 'ready' : 'pending', ready_on: readyOn, stored_n: tags.filter((t) => t.tag === 'held' || t.tag === 'dropped').length };
    for (const r of names) {
      const out = byName.get(r.row.domain)!;
      const tag = tagBy.get(r.row.domain) ?? null;
      out.rdap_tag = tag;
      out.labels.taken = tag === 'held' ? true : tag === 'dropped' ? false : null;
    }
  }

  // retail sales reported after D (the later stores only; the logic never read them)
  if (list.length > 0) {
    const total = Number((await sql<{ n: string }>`select (
        (select count(*) from market_sales where sale_date > ${date}::date and listing_type <> 'closeout')
      + (select count(*) from engine_sales where sale_date > ${date}::date and source <> 'godaddy_auctions_file'))::text as n`.execute(db)).rows[0]!.n);
    status.retail = { status: total > 0 ? 'ok' : 'no_data', sales_after_d_n: total };
    if (total > 0) {
      labels.push('retail_sale', 'retail_500');
      const sales = (await sql<{ domain: string; price_cents: number; d: string; venue: string; source: string }>`
        select name as domain, sale_price_cents as price_cents, to_char(sale_date, 'YYYY-MM-DD') as d, venue, source from market_sales where name = any(${list}::text[]) and sale_date > ${date}::date and listing_type <> 'closeout'
        union all
        select domain, price_cents, to_char(sale_date, 'YYYY-MM-DD'), venue, source from engine_sales where domain = any(${list}::text[]) and sale_date > ${date}::date and source <> 'godaddy_auctions_file'`.execute(db)).rows;
      for (const s of sales) byName.get(s.domain)?.retail.push({ price_cents: Number(s.price_cents), sale_date: s.d, venue: s.venue, source: s.source });
      for (const out of byName.values()) {
        out.labels.retail_sale = out.retail.length > 0;
        out.labels.retail_500 = out.retail.some((x) => x.price_cents >= RETAIL_BIG_CENTS);
      }
    }
  }
  return { byName, labels, status };
}
