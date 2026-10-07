import { formatUsd } from '../core/money.js';

export type OfferSource = 'afternic' | 'godaddy' | 'sedo' | 'domainagents' | 'email_inbound' | 'outbound_reply' | 'other';
export const OFFER_SOURCES: readonly OfferSource[] = ['afternic', 'godaddy', 'sedo', 'domainagents', 'email_inbound', 'outbound_reply', 'other'];
export type BuyerType = 'end_user' | 'investor' | 'broker' | 'unknown';
export const BUYER_TYPES: readonly BuyerType[] = ['end_user', 'investor', 'broker', 'unknown'];
export type Band = 'below_min' | 'below_walkaway' | 'mid_range' | 'at_or_above_floor' | 'at_or_above_bin' | 'geo_below_bin' | 'unpriced';
export type Routing = 'auto_decline' | 'dvir' | 'auto_accept' | 'accept_preapproved';

export interface OfferSnapshot {
  mode: 'bin' | 'hybrid' | 'offer' | null;
  binCents: number | null;
  floorCents: number | null;
  walkawayCents: number | null;
  minOfferCents: number | null;
  listingHistoryId: number | null;
  listedAtReceipt: boolean;
  /** Optional; for mode 'bin' a missing category is treated as geo. */
  category?: string | null;
}

export interface Classification {
  band: Band;
  routing: Routing;
  outcome: 'declined_auto' | 'open';
  nextStep: string;
  warnings: string[];
}

const isEmail = (s: OfferSource) => s === 'email_inbound' || s === 'outbound_reply';
const isAutoVenue = (s: OfferSource) => s === 'afternic' || s === 'godaddy';

function bandOf(s: OfferSnapshot, a: number): Band {
  const { binCents: bin, floorCents: floor, walkawayCents: walk, minOfferCents: min } = s;
  if (s.mode === 'hybrid') {
    if (bin === null || floor === null || walk === null || min === null) return 'unpriced';
    if (a < min) return 'below_min';
    if (a < walk) return 'below_walkaway';
    if (a < floor) return 'mid_range';
    if (a < bin) return 'at_or_above_floor';
    return 'at_or_above_bin';
  }
  if (s.mode === 'bin') {
    if (bin === null) return 'unpriced';
    return a < bin ? 'geo_below_bin' : 'at_or_above_bin';
  }
  if (s.mode === 'offer') {
    if (min === null) return 'unpriced';
    if (a < min) return 'below_min';
    if (floor !== null && a >= floor) return 'at_or_above_floor';
    return 'mid_range';
  }
  return 'unpriced';
}

function routingOf(band: Band, source: OfferSource): Routing {
  if (band === 'below_min' || band === 'below_walkaway' || band === 'geo_below_bin') return 'auto_decline';
  if (isEmail(source)) return 'dvir';
  if (band === 'mid_range' || band === 'unpriced') return 'dvir';
  return isAutoVenue(source) ? 'auto_accept' : 'accept_preapproved';
}

function nextStepOf(s: OfferSnapshot, band: Band, routing: Routing, source: OfferSource): string {
  const bin = s.binCents;
  switch (routing) {
    case 'auto_decline': {
      if (band === 'geo_below_bin') {
        const price = formatUsd(bin ?? 0).replace(/\.00$/, '');
        const geo = s.category === undefined || s.category === null || s.category === 'geo';
        return `${geo ? 'Geo price' : 'Price'} is fixed: reply 'The price is ${price}, fixed'.`;
      }
      const head = band === 'below_min' ? 'Below the minimum offer' : 'Below the walk-away';
      if (isAutoVenue(source)) return `${head}: decline in the Afternic dashboard (or let it expire); no Gate D.`;
      if (isEmail(source)) return `${head}: Sochen's standard decline template; Dvir sends it (pre-approved text, no Gate D).`;
      return `${head}: Sochen's standard decline template; no Gate D.`;
    }
    case 'dvir':
      if (isEmail(source)) return 'Email offer: Sochen drafts; Dvir decides and sends.';
      if (band === 'unpriced') return 'No prices in force: ask Dvir.';
      return "Mid-range: Sochen drafts; needs Dvir's Gate D line.";
    case 'auto_accept':
      return 'At or above the floor: Afternic may already have closed this; check the dashboard.';
    case 'accept_preapproved':
      return 'At or above the floor: accept (pre-approved by the buy card).';
  }
}

export function classify(s: OfferSnapshot, amountCents: number, source: OfferSource): Classification {
  const band = bandOf(s, amountCents);
  const routing = routingOf(band, source);
  const warnings: string[] = [];
  if (!s.listedAtReceipt) warnings.push('OFFER_ON_UNLISTED');
  if (band === 'at_or_above_floor' && isAutoVenue(source)) warnings.push('OFFER_AT_OR_ABOVE_FLOOR');
  return {
    band, routing, outcome: routing === 'auto_decline' ? 'declined_auto' : 'open',
    nextStep: nextStepOf(s, band, routing, source), warnings,
  };
}
