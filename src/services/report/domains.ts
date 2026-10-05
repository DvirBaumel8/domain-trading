import type { Kysely } from 'kysely';
import { jerusalemDate } from '../../dates.js';
import type { Database } from '../../db/types.js';
import { toJerusalemIso } from '../../time.js';
import { pendingDomains } from '../export-state.js';
import { perDomainOffers } from '../offer-stats.js';
import { money, moneyOrNull, type Money } from './money.js';

export const dayNumber = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
export const addDays = (d: string, n: number) => new Date((dayNumber(d) + n) * 86_400_000).toISOString().slice(0, 10);
const iso = (d: Date | null) => (d ? toJerusalemIso(d) : null);

export interface PriceValues { bin: Money | null; floor: Money | null; walkaway: Money | null }

export async function perDomain(db: Kysely<Database>, now: Date) {
  const today = jerusalemDate(now);
  const domains = await db.selectFrom('domains').selectAll().where('status', '!=', 'pending_purchase').orderBy('domain').execute();
  const offers = await perDomainOffers(db, now);
  const costs = await db.selectFrom('ledger_entries').select(['domain_id', 'amount_cents']).where('type', 'in', ['registration', 'renewal']).execute();
  const costBy = new Map<number, number>();
  for (const c of costs) if (c.domain_id !== null) costBy.set(c.domain_id, (costBy.get(c.domain_id) ?? 0) - c.amount_cents);
  const planned = await db.selectFrom('price_schedule').selectAll().where('status', '=', 'planned').orderBy('due_on').orderBy('id').execute();
  return domains.map((d) => {
    const next = planned.find((p) => p.domain_id === d.id && p.plan_id === d.plan_id);
    return {
      domain: d.domain, status: d.status, registrar: d.registrar, registrar_api: d.registrar_api, category: d.category, price_grade: d.price_grade,
      listing_mode: d.listing_mode, bin: moneyOrNull(d.bin_cents), floor: moneyOrNull(d.floor_cents),
      walkaway: d.walkaway_cents === null ? null : { cents: d.walkaway_cents, display: `${money(d.walkaway_cents).display} (private)` },
      min_offer: moneyOrNull(d.min_offer_cents), pricing_source: d.pricing_source, pricing_settings_version: d.pricing_settings_version,
      offers: offers.get(d.id)!,
      next_price_event: next ? { event: next.event, due_on: next.due_on, bin: moneyOrNull(next.bin_cents), floor: moneyOrNull(next.floor_cents), walkaway: moneyOrNull(next.walkaway_cents) } : null,
      pricing_hold: d.pricing_hold, export_pending_since: iso(d.export_pending_since),
      cost: money(costBy.get(d.id) ?? 0), renewal_price: moneyOrNull(d.renewal_price_cents), renewals_used: d.renewals_used,
      expiry_date: d.expiry_date, drop_date: d.drop_date, lander: d.lander, ns_verified: d.ns_verified_at !== null,
      days_held: d.buy_date ? dayNumber(today) - dayNumber(d.buy_date) : null,
      sold_at: iso(d.sold_at), delisted_at: iso(d.delisted_at),
    };
  });
}

export async function payoutsPending(db: Kysely<Database>, now: Date) {
  const today = jerusalemDate(now);
  const rows = await db.selectFrom('payouts')
    .innerJoin('sales', 'sales.sale_ledger_id', 'payouts.sale_ledger_id').innerJoin('domains', 'domains.id', 'payouts.domain_id')
    .select(['domains.domain', 'payouts.venue', 'payouts.amount_cents', 'payouts.fee_cents', 'payouts.method', 'sales.sold_at'])
    .where('payouts.received_on', 'is', null).orderBy('sales.sold_at').orderBy('payouts.id').execute();
  return rows.map((r) => ({
    domain: r.domain, venue: r.venue, amount: money(r.amount_cents), fee: money(r.fee_cents), method: r.method,
    sold_at: toJerusalemIso(r.sold_at), days_pending: dayNumber(today) - dayNumber(jerusalemDate(r.sold_at)),
  }));
}

export async function applied7d(db: Kysely<Database>, now: Date) {
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const rows = await db.selectFrom('price_schedule').innerJoin('domains', 'domains.id', 'price_schedule.domain_id')
    .select(['price_schedule.domain_id', 'domains.domain', 'price_schedule.event', 'price_schedule.applied_at', 'price_schedule.listing_history_id',
      'price_schedule.bin_cents', 'price_schedule.floor_cents', 'price_schedule.walkaway_cents'])
    .where('price_schedule.status', '=', 'applied').where('price_schedule.applied_at', '>=', since).orderBy('price_schedule.applied_at').orderBy('price_schedule.id').execute();
  const pending = new Set(await pendingDomains(db, 'afternic'));
  const vals = (r: { bin_cents: number | null; floor_cents: number | null; walkaway_cents: number | null } | undefined): PriceValues =>
    ({ bin: moneyOrNull(r?.bin_cents ?? null), floor: moneyOrNull(r?.floor_cents ?? null), walkaway: moneyOrNull(r?.walkaway_cents ?? null) });
  const out = [];
  for (const r of rows) {
    const cols = ['bin_cents', 'floor_cents', 'walkaway_cents'] as const;
    const hist = r.listing_history_id === null ? undefined
      : await db.selectFrom('listing_history').select(cols).where('id', '=', r.listing_history_id).executeTakeFirst();
    const prev = r.listing_history_id === null ? undefined
      : await db.selectFrom('listing_history').select(cols).where('domain_id', '=', r.domain_id).where('id', '<', r.listing_history_id).orderBy('id', 'desc').limit(1).executeTakeFirst();
    out.push({
      domain: r.domain, event: r.event, applied_at: toJerusalemIso(r.applied_at!), old: vals(prev), new: vals(hist ?? r), export_pending: pending.has(r.domain),
    });
  }
  return out;
}
