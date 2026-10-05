import { sql, type Kysely } from 'kysely';
import { jerusalemDate } from '../../dates.js';
import type { Database } from '../../db/types.js';
import { toJerusalemIso } from '../../time.js';
import { pendingDomains } from '../export-state.js';
import { perDomainOffers } from '../offer-stats.js';
import { pair, priceValues, walkawayPair } from './money.js';

export const dayNumber = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
export const addDays = (d: string, n: number) => new Date((dayNumber(d) + n) * 86_400_000).toISOString().slice(0, 10);
const iso = (d: Date | null) => (d ? toJerusalemIso(d) : null);

export async function perDomain(db: Kysely<Database>, now: Date) {
  const today = jerusalemDate(now);
  const domains = await db.selectFrom('domains').selectAll().where('status', '!=', 'pending_purchase').orderBy('domain').execute();
  const offers = await perDomainOffers(db, now);
  const costRows = await sql<{ domain_id: number; cost: string }>`
    select domain_id, (-sum(amount_cents))::bigint as cost from ledger_entries
    where type in ('registration', 'renewal') and domain_id is not null group by domain_id`.execute(db);
  const costBy = new Map(costRows.rows.map((c) => [c.domain_id, Number(c.cost)]));
  const planned = await db.selectFrom('price_schedule').selectAll().where('status', '=', 'planned').orderBy('due_on').orderBy('id').execute();
  return domains.map((d) => {
    const next = planned.find((p) => p.domain_id === d.id && p.plan_id === d.plan_id);
    // days held stop at the sale (sold) or the drop date (dropped); otherwise they run to today
    const end = d.status === 'sold' && d.sold_at ? jerusalemDate(d.sold_at) : d.status === 'dropped' && d.drop_date ? d.drop_date : today;
    return {
      domain: d.domain, status: d.status, registrar: d.registrar, registrar_api: d.registrar_api, category: d.category, price_grade: d.price_grade,
      listing_mode: d.listing_mode, ...pair('bin', d.bin_cents), ...pair('floor', d.floor_cents), ...walkawayPair(d.walkaway_cents),
      ...pair('min_offer', d.min_offer_cents), pricing_source: d.pricing_source, pricing_settings_version: d.pricing_settings_version,
      offers: offers.get(d.id)!,
      next_price_event: next ? { event: next.event, due_on: next.due_on, ...priceValues(next) } : null,
      pricing_hold: d.pricing_hold, export_pending_since: iso(d.export_pending_since),
      ...pair('cost', costBy.get(d.id) ?? 0), ...pair('renewal_price', d.renewal_price_cents), renewals_used: d.renewals_used,
      expiry_date: d.expiry_date, drop_date: d.drop_date, lander: d.lander, ns_verified: d.ns_verified_at !== null,
      days_held: d.buy_date ? dayNumber(end) - dayNumber(d.buy_date) : null,
      sold_at: iso(d.sold_at), delisted_at: iso(d.delisted_at),
    };
  });
}

export async function applied7d(db: Kysely<Database>, now: Date) {
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const rows = await db.selectFrom('price_schedule').innerJoin('domains', 'domains.id', 'price_schedule.domain_id')
    .select(['price_schedule.domain_id', 'domains.domain', 'price_schedule.event', 'price_schedule.applied_at', 'price_schedule.listing_history_id',
      'price_schedule.bin_cents', 'price_schedule.floor_cents', 'price_schedule.walkaway_cents'])
    .where('price_schedule.status', '=', 'applied').where('price_schedule.applied_at', '>=', since).orderBy('price_schedule.applied_at').orderBy('price_schedule.id').execute();
  const pending = new Set(await pendingDomains(db, 'afternic'));
  const cols = ['bin_cents', 'floor_cents', 'walkaway_cents'] as const;
  const out = [];
  for (const r of rows) {
    const hist = r.listing_history_id === null ? undefined
      : await db.selectFrom('listing_history').select(cols).where('id', '=', r.listing_history_id).executeTakeFirst();
    const prev = r.listing_history_id === null ? undefined
      : await db.selectFrom('listing_history').select(cols).where('domain_id', '=', r.domain_id).where('id', '<', r.listing_history_id).orderBy('id', 'desc').limit(1).executeTakeFirst();
    out.push({
      domain: r.domain, event: r.event, applied_at: toJerusalemIso(r.applied_at!),
      old: priceValues(prev ?? { bin_cents: null, floor_cents: null, walkaway_cents: null }), new: priceValues(hist ?? r), export_pending: pending.has(r.domain),
    });
  }
  return out;
}
