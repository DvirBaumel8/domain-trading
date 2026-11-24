// Our Afternic listings and sales (Aftermarket Portfolio API). Two GETs; nothing here can change a listing.
import { z } from 'zod';
import { microToCents, readJson, SourceError, type Fetch } from './client.js';

const SOURCE = 'afternic';
const BASE = 'https://api.afternic.com/v3/aftermarket/customers/my';
const PAGE = 100;
/** Before our first purchase, so every sale of ours is in range (the API's own default is one month). */
const SALES_FROM = '2026-10-01T00:00:00Z';

export type SsoKeys = { key: string; secret: string } | null;

const micro = z.number().nullish();
const Pagination = z.object({ total: z.number().int().nonnegative() });
const Listings = z.object({
  domains: z.array(z.object({
    name: z.string(), listStatus: z.string(), hidden: z.boolean().nullish(), fastTransferStatus: z.string().nullish(), buynowPrice: micro, floorPrice: micro, minbidPrice: micro,
    leasingEnabled: z.boolean().nullish(), intakeLeads: z.number().nullish(), intakeViews: z.number().nullish(),
  })),
  pagination: Pagination,
});
// the transfer auth code a sale may carry is left out on purpose
const Sales = z.object({
  sales: z.array(z.object({ name: z.string(), status: z.string(), saleType: z.string().nullish(), salePrice: micro, commission: micro, soldAt: z.string().nullish(), disbursedAt: z.string().nullish() })),
  pagination: Pagination,
});

async function get<T>(keys: SsoKeys, path: string, schema: z.ZodType<T>, fetchFn: Fetch): Promise<T> {
  if (!keys) throw new SourceError(SOURCE, 'KEY_MISSING');
  const parsed = schema.safeParse(await readJson(fetchFn, { source: SOURCE, url: `${BASE}${path}`, headers: { authorization: `sso-key ${keys.key}:${keys.secret}` } }));
  if (!parsed.success) throw new SourceError(SOURCE, 'BAD_RESPONSE', 200);
  return parsed.data;
}
/** Our cap is 40 names, so one page holds everything; a cut answer is an error. */
const whole = (got: number, total: number): void => { if (got !== total) throw new SourceError(SOURCE, 'BAD_RESPONSE', 200); };

export async function afternicListings(keys: SsoKeys, fetchFn: Fetch = fetch) {
  const { domains, pagination } = await get(keys, `/domains?limit=${PAGE}&offset=0&order=NAME_ASC&includes=fastTransferStatus`, Listings, fetchFn);
  whole(domains.length, pagination.total);
  return domains.map((d) => ({
    domain: d.name.toLowerCase(), list_status: d.listStatus, hidden: d.hidden ?? null, fast_transfer_status: d.fastTransferStatus ?? null,
    buy_now_cents: microToCents(SOURCE, d.buynowPrice), floor_cents: microToCents(SOURCE, d.floorPrice), min_offer_cents: microToCents(SOURCE, d.minbidPrice),
    lease_to_own: d.leasingEnabled ?? null, leads: d.intakeLeads ?? null, views: d.intakeViews ?? null,
  }));
}

export async function afternicSales(keys: SsoKeys, fetchFn: Fetch = fetch) {
  const { sales, pagination } = await get(keys, `/sales?limit=${PAGE}&offset=0&order=SOLD_AT_DESC&soldAtStartDate=${encodeURIComponent(SALES_FROM)}`, Sales, fetchFn);
  whole(sales.length, pagination.total);
  return sales.map((s) => ({
    domain: s.name.toLowerCase(), status: s.status, sale_type: s.saleType ?? null, price_cents: microToCents(SOURCE, s.salePrice), commission_cents: microToCents(SOURCE, s.commission),
    sold_at: s.soldAt ?? null, disbursed_at: s.disbursedAt ?? null,
  }));
}
