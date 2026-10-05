import { sql, type Kysely } from 'kysely';
import { jerusalemDate } from '../../dates.js';
import type { Database, PriceScheduleEvent } from '../../db/types.js';
import { toJerusalemIso } from '../../time.js';
import { idtDayStart } from '../offer-stats.js';
import { dayNumber } from './domains.js';
import { pair } from './money.js';

const STAGE: Partial<Record<PriceScheduleEvent, string>> = { drop1_m6: 'M6', geo_drop_m12: 'M12', drop2_m18: 'M18', final_push: 'final' };
const AT_FLOOR_TOLERANCE_CENTS = 100;
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const round4 = (n: number) => Math.round((n + Number.EPSILON) * 10_000) / 10_000;

/** Q10: the quarterly review input. `from`/`to` are IDT days (inclusive). */
export async function pricingReview(db: Kysely<Database>, o: { from: string; to: string }) {
  const start = await idtDayStart(db, o.from);
  const end = await idtDayStart(db, o.to, 1);
  const sales = await db.selectFrom('sales').innerJoin('domains', 'domains.id', 'sales.domain_id')
    .select(['domains.domain', 'domains.id as domain_id', 'domains.first_listed_at', 'sales.venue', 'sales.sale_price_cents', 'sales.sold_at'])
    .where('sales.sold_at', '>=', start).where('sales.sold_at', '<', end).orderBy('sales.sold_at').orderBy('sales.id').execute();

  const out = [];
  const versions = new Set<number>();
  for (const s of sales) {
    const h = await db.selectFrom('listing_history').select(['bin_cents', 'floor_cents'])
      .where('domain_id', '=', s.domain_id).where('at', '<=', s.sold_at).orderBy('at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
    const ev = await db.selectFrom('price_schedule').select('event').where('domain_id', '=', s.domain_id).where('status', '=', 'applied')
      .where('event', 'in', Object.keys(STAGE) as PriceScheduleEvent[])
      .where('applied_at', '<=', s.sold_at).orderBy('applied_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
    const bin = h?.bin_cents ?? null;
    const floor = h?.floor_cents ?? null;
    out.push({
      domain: s.domain, venue: s.venue, ...pair('gross', s.sale_price_cents), ...pair('bin_at_sale', bin),
      ratio: bin ? round2(s.sale_price_cents / bin) : null,
      stage: (ev && STAGE[ev.event]) ?? 'M0',
      days_listed: s.first_listed_at ? dayNumber(jerusalemDate(s.sold_at)) - dayNumber(jerusalemDate(s.first_listed_at)) : null,
      at_floor: floor !== null && Math.abs(s.sale_price_cents - floor) <= AT_FLOOR_TOLERANCE_CENTS,
      sold_at: toJerusalemIso(s.sold_at),
    });
  }

  // settings versions in use: those that priced the sales in the window
  const inUse = await sql<{ v: number }>`select distinct h.pricing_settings_version as v from sales s
    join lateral (select pricing_settings_version from listing_history where domain_id = s.domain_id and at <= s.sold_at order by at desc, id desc limit 1) h on true
    where s.sold_at >= ${start} and s.sold_at < ${end} and h.pricing_settings_version is not null`.execute(db);
  for (const r of inUse.rows) versions.add(r.v);

  const offerRows = await db.selectFrom('offers').select(['amount_cents', 'bin_cents_at', 'band']).where('received_at', '>=', start).where('received_at', '<', end).execute();
  const by_band: Record<string, number> = {};
  for (const r of offerRows) by_band[r.band] = (by_band[r.band] ?? 0) + 1;
  const pcts = offerRows.filter((r) => r.bin_cents_at).map((r) => r.amount_cents / r.bin_cents_at!);

  const evCount = async (statuses: string[]) => Number((await sql<{ n: string }>`
    select count(*) as n from price_schedule where status = any(${statuses}::text[]) and updated_at >= ${start} and updated_at < ${end}`.execute(db)).rows[0]!.n);
  const held = Number((await sql<{ n: string }>`select count(*) as n from domains where pricing_hold`.execute(db)).rows[0]!.n);

  return {
    from: o.from, to: o.to, sales: out,
    offers: { count: offerRows.length, by_band, median_pct_of_bin: pcts.length ? round4(median(pcts)) : null },
    skipped_events: await evCount(['skipped_at_minimum', 'skipped_no_change', 'skipped_disabled']),
    held_domains_now: held, // a snapshot of domains on a pricing hold now, not events in the window
    settings_versions_in_use: [...versions].sort((a, b) => a - b),
    insufficient_data: out.length < 3,
  };
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
