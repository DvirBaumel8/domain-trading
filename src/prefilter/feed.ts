// Reads a GoDaddy public inventory file piece by piece: {"meta": {...}, "data": [{...}, ...]}. The closeout file is over 300 MB.
import { z } from 'zod';

export class FeedError extends Error {}

/** Yields the text of `meta` and of each row. A file that stops early is an error, never a shorter list. */
export async function* feedObjects(chunks: AsyncIterable<string>): AsyncGenerator<{ kind: 'meta' | 'row'; text: string }> {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let parts = '';
  let kind: 'meta' | 'row' | null = null;
  let closed = false;
  for await (const chunk of chunks) {
    let from = 0;
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === '{' || c === '[') {
        if (c === '{' && kind === null && stack.join('') !== '') { kind = stack.join('') === '{[' ? 'row' : 'meta'; parts = ''; from = i; }
        stack.push(c);
      } else if (c === '}' || c === ']') {
        if (stack.pop() !== (c === '}' ? '{' : '[')) throw new FeedError('not valid JSON');
        if (stack.length === 0) closed = true;
        if (kind !== null && c === '}' && stack.length === (kind === 'row' ? 2 : 1)) { yield { kind, text: parts + chunk.slice(from, i + 1) }; kind = null; }
      }
    }
    if (kind !== null) parts += chunk.slice(from);
  }
  if (!closed || inString || stack.length > 0) throw new FeedError('the file ends early');
}

const Meta = z.object({ lastBuildDate: z.iso.datetime() });
const Row = z.object({
  domainName: z.string(),
  link: z.string(),
  auctionType: z.string(),
  auctionEndTime: z.iso.datetime(),
  price: z.string().regex(/^\$\d[\d,]*(\.\d\d)?$/),
  numberOfBids: z.int().nonnegative(),
  domainAge: z.int().nonnegative().optional(),
  isAdult: z.boolean(),
  exactMatchTlds: z.int().nonnegative(),
  developedTlds: z.int().nonnegative(),
});

export interface Listing {
  domain: string; auctionId: string | null; type: string; endsAt: number; priceCents: number; bids: number;
  age: number | null; adult: boolean; exactMatchTlds: number; developedTlds: number;
}
export interface FeedCounts { read: number; not_com: number; not_letters: number; too_long: number; unreadable: number }
export interface Feed { builtAt: number; listings: Listing[]; counts: FeedCounts }

export const MAX_NAME_LENGTH = 13;
/** Built once a day by GoDaddy; an older file would show ended auctions. */
const MAX_FILE_AGE_MS = 12 * 3_600_000;

/** Every listing whose name is a .com of letters only, up to 13 long. A stale, empty or changed file is an error, never "no names". */
export async function readFeed(chunks: AsyncIterable<string>, now: number): Promise<Feed> {
  const counts: FeedCounts = { read: 0, not_com: 0, not_letters: 0, too_long: 0, unreadable: 0 };
  const listings: Listing[] = [];
  let builtAt: number | null = null;
  for await (const o of feedObjects(chunks)) {
    const raw = JSON.parse(o.text) as { domainName?: unknown };
    if (o.kind === 'meta') {
      const meta = Meta.safeParse(raw);
      if (meta.success) builtAt = Date.parse(meta.data.lastBuildDate);
      continue;
    }
    counts.read++;
    if (typeof raw.domainName !== 'string') { counts.unreadable++; continue; }
    const domain = raw.domainName.toLowerCase();
    if (!domain.endsWith('.com')) { counts.not_com++; continue; }
    const label = domain.slice(0, -4);
    if (!/^[a-z]+$/.test(label)) { counts.not_letters++; continue; }
    if (label.length > MAX_NAME_LENGTH) { counts.too_long++; continue; }
    const row = Row.safeParse(raw);
    if (!row.success) { counts.unreadable++; continue; }
    const r = row.data;
    listings.push({
      domain, auctionId: /-(\d+)(?:\?|$)/.exec(r.link)?.[1] ?? null, type: r.auctionType, endsAt: Date.parse(r.auctionEndTime),
      priceCents: Math.round(Number(r.price.replace(/[$,]/g, '')) * 100), bids: r.numberOfBids, age: r.domainAge ?? null, adult: r.isAdult,
      exactMatchTlds: r.exactMatchTlds, developedTlds: r.developedTlds,
    });
  }
  if (builtAt === null) throw new FeedError('the file has no build date');
  if (now - builtAt > MAX_FILE_AGE_MS) throw new FeedError('the file is more than 12 hours old');
  if (counts.unreadable * 100 > listings.length + counts.unreadable) throw new FeedError('the file changed: over 1% of the rows cannot be read');
  if (listings.length === 0) throw new FeedError('the file has no usable rows');
  return { builtAt, listings, counts };
}
