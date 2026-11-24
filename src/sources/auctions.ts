// GoDaddy Auctions: is a name for sale now, at what price? The only call is the availability check (a POST that reads); no bid or buy call exists here.
import { z } from 'zod';
import { microToCents, readJson, SourceError, type Fetch } from './client.js';
import type { SsoKeys } from './afternic.js';

const SOURCE = 'godaddy_auctions';
const URL_AVAILABLE = 'https://api.godaddy.com/v1/customers/MY/aftermarket/listings/available?includes=listing';
export const MAX_NAMES = 50;

const money = z.number().nullish();
const Answer = z.object({
  availabilities: z.array(z.object({
    domainName: z.string(), status: z.enum(['AVAILABLE', 'UNAVAILABLE']),
    listing: z.object({ listingId: z.number().nullish(), listingType: z.string().nullish(), currencyId: z.literal('USD'), auctionEndAt: z.string().nullish(), priceCurrent: money, priceNextBid: money, priceTransfer: money, priceRenewal: money }).nullish(),
  })),
});

export async function auctionLookup(domains: readonly string[], keys: SsoKeys, fetchFn: Fetch = fetch) {
  if (!keys) throw new SourceError(SOURCE, 'KEY_MISSING');
  const parsed = Answer.safeParse(await readJson(fetchFn, { source: SOURCE, url: URL_AVAILABLE, headers: { authorization: `sso-key ${keys.key}:${keys.secret}` }, body: { domains } }));
  if (!parsed.success) throw new SourceError(SOURCE, 'BAD_RESPONSE', 200);
  return domains.map((domain) => {
    const a = parsed.data.availabilities.find((x) => x.domainName.toLowerCase() === domain);
    if (!a || (a.status === 'AVAILABLE' && !a.listing)) throw new SourceError(SOURCE, 'BAD_RESPONSE', 200); // a name left out is not "unavailable"
    const l = a.status === 'AVAILABLE' ? a.listing! : null;
    return {
      domain, for_sale: l !== null, listing_id: l?.listingId ?? null, listing_type: l?.listingType ?? null, ends_at: l?.auctionEndAt ?? null,
      price_cents: microToCents(SOURCE, l?.priceCurrent), next_bid_cents: microToCents(SOURCE, l?.priceNextBid), renewal_cents: microToCents(SOURCE, l?.priceRenewal), transfer_cents: microToCents(SOURCE, l?.priceTransfer),
    };
  });
}
