import { pair } from '../../../core/money.js';
import { sql, type Kysely } from 'kysely';
import { addDays, dayNumber, idtDay, toJerusalemIso } from '../../../core/dates.js';
import type { Database, DomainRow } from '../../../db/types.js';
import { pendingDomains } from '../../listing/index.js';
import { perDomainOffers, type OfferRow } from '../../selling/index.js';
import { priceValues, walkawayPair } from './money.js';

const iso = (d: Date | null) => (d ? toJerusalemIso(d) : null);

/** Every name except those still being bought, by domain: the rows /report, GET /portfolio and the warnings all read (loaded once per /report). */
export function loadReportDomains(db: Kysely<Database>): Promise<DomainRow[]> {
  return db.selectFrom('domains').selectAll().where('status', '!=', 'pending_purchase').orderBy('domain').execute();
}

/**
 * `o.domains` / `o.offers`: rows the caller already loaded (one /report loads them once for every part). `o.domain`: only that name
 * (GET /portfolio/{domain} builds one row, not the whole portfolio).
 */
export async function perDomain(db: Kysely<Database>, now: Date, o: { domains?: DomainRow[]; offers?: OfferRow[]; domain?: string } = {}) {
  const today = idtDay(now);
  const domains = o.domains ?? (o.domain
    ? await db.selectFrom('domains').selectAll().where('status', '!=', 'pending_purchase').where('domain', '=', o.domain).execute()
    : await loadReportDomains(db));
  const ids = o.domain ? domains.map((d) => d.id) : undefined;
  const offers = await perDomainOffers(db, now, { offers: o.offers, domainIds: ids });
  const costRows = await sql<{ domain_id: number; cost: string }>`
    select domain_id, (-sum(amount_cents))::bigint as cost from ledger_entries
    where type in ('registration', 'renewal') and domain_id is not null ${ids ? sql`and domain_id = any(${ids})` : sql``} group by domain_id`.execute(db);
  const costBy = new Map(costRows.rows.map((c) => [c.domain_id, Number(c.cost)]));
  let pq = db.selectFrom('price_schedule').selectAll().where('status', '=', 'planned');
  if (ids) pq = pq.where('domain_id', 'in', ids.length ? ids : [-1]);
  const planned = await pq.orderBy('due_on').orderBy('id').execute();
  return domains.map((d) => {
    const next = planned.find((p) => p.domain_id === d.id && p.plan_id === d.plan_id);
    // days held stop at the sale (sold) or the drop date (dropped); otherwise they run to today
    const end = d.status === 'sold' && d.sold_at ? idtDay(d.sold_at) : d.status === 'dropped' && d.drop_date ? d.drop_date : today;
    return {
      domain: d.domain, line: d.lane === 'S8' ? 2 : 1, lane: d.lane, status: d.status, registrar: d.registrar, registrar_api: d.registrar_api, category: d.category, price_grade: d.price_grade,
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

export async function applied7d(db: Kysely<Database>, now: Date, pendingAfternic?: Set<string>) {
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const rows = await db.selectFrom('price_schedule').innerJoin('domains', 'domains.id', 'price_schedule.domain_id')
    .select(['price_schedule.domain_id', 'domains.domain', 'price_schedule.event', 'price_schedule.applied_at', 'price_schedule.listing_history_id',
      'price_schedule.bin_cents', 'price_schedule.floor_cents', 'price_schedule.walkaway_cents'])
    .where('price_schedule.status', '=', 'applied').where('price_schedule.applied_at', '>=', since).orderBy('price_schedule.applied_at').orderBy('price_schedule.id').execute();
  const pending = pendingAfternic ?? new Set(await pendingDomains(db, 'afternic'));
  // the history row of each applied event and the one before it, in two statements for all rows (not two per row)
  type Prices = { bin_cents: number | null; floor_cents: number | null; walkaway_cents: number | null };
  const histIds = [...new Set(rows.filter((r) => r.listing_history_id !== null).map((r) => r.listing_history_id!))];
  const hists = new Map<number, Prices>();
  const prevs = new Map<number, Prices>();
  if (histIds.length > 0) {
    for (const h of await db.selectFrom('listing_history').select(['id', 'bin_cents', 'floor_cents', 'walkaway_cents']).where('id', 'in', histIds).execute()) hists.set(h.id, h);
    const pr = await sql<{ lh: number; bin_cents: number | null; floor_cents: number | null; walkaway_cents: number | null }>`
      select h.id as lh, p.bin_cents, p.floor_cents, p.walkaway_cents from listing_history h
      join lateral (select bin_cents, floor_cents, walkaway_cents from listing_history x where x.domain_id = h.domain_id and x.id < h.id order by x.id desc limit 1) p on true
      where h.id = any(${histIds})`.execute(db);
    for (const p of pr.rows) prevs.set(p.lh, p);
  }
  const out = [];
  for (const r of rows) {
    const hist = r.listing_history_id === null ? undefined : hists.get(r.listing_history_id);
    const prev = r.listing_history_id === null ? undefined : prevs.get(r.listing_history_id);
    out.push({
      domain: r.domain, event: r.event, applied_at: toJerusalemIso(r.applied_at!),
      old: priceValues(prev ?? { bin_cents: null, floor_cents: null, walkaway_cents: null }), new: priceValues(hist ?? r), export_pending: pending.has(r.domain),
    });
  }
  return out;
}
