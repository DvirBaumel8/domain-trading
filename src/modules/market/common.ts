// CR-075 (v5.23.0): small shared pieces of the market module: price bands, ids, name parts, dates.
import { createHash } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { addDays } from '../../core/dates.js';

export { addDays };

/** Nothing under $500 is stored (CR-075 Q1). */
export const MIN_CENTS = 50_000;
export type Band = '500-999' | '1k-2.5k' | '2.5k-5k' | '5k-10k' | '10k+';
export const BANDS: readonly Band[] = ['500-999', '1k-2.5k', '2.5k-5k', '5k-10k', '10k+'];
export type Tier = 'A' | 'B' | 'C' | 'D';
export const TIERS: readonly Tier[] = ['A', 'B', 'C', 'D'];
export type ListingType = 'bin' | 'offer' | 'auction' | 'closeout';
export const LISTING_TYPES: readonly ListingType[] = ['bin', 'offer', 'auction', 'closeout'];

/** R-1 bands, in cents: 500-999, 1k-2.5k (1,000-2,499), 2.5k-5k, 5k-10k, 10k+. Under $500: null (never stored). */
export function bandOf(cents: number | null | undefined): Band | null {
  if (cents === null || cents === undefined || cents < MIN_CENTS) return null;
  if (cents < 100_000) return '500-999';
  if (cents < 250_000) return '1k-2.5k';
  if (cents < 500_000) return '2.5k-5k';
  if (cents < 1_000_000) return '5k-10k';
  return '10k+';
}

export const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex');
export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** episode_id = sha1(name|venue|first_seen); a non-bin episode appends |listing_type so a BIN and an auction of one name that start the same day never collide. */
export const episodeId = (name: string, venue: string, firstSeen: string, type: ListingType): string => sha1(`${name}|${venue}|${firstSeen}${type === 'bin' ? '' : `|${type}`}`);

/** Lowercase, IDN as punycode; null when not a plausible domain name. */
export function normalizeName(raw: string): string | null {
  const t = raw.trim().toLowerCase();
  if (t.length === 0 || t.length > 253) return null;
  const a = domainToASCII(t);
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(a) ? a : null;
}
export function splitName(name: string): { sld: string; tld: string } {
  const i = name.indexOf('.');
  return { sld: name.slice(0, i), tld: name.slice(i + 1) };
}
export const lettersOnly = (sld: string): boolean => /^[a-z]+$/.test(sld);

export const DAY_MS = 86_400_000;
export const dayNum = (d: string): number => Math.round(Date.parse(`${d}T00:00:00Z`) / DAY_MS);
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const tierRank = (t: Tier): number => TIERS.indexOf(t);
