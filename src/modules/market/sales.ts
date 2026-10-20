// CR-075 (v5.23.0) R-4, R-8: POST /data/sales rows. Add-only; the same (name, venue, sale_date, source) re-posted with a changed price is 409 APPEND_ONLY.
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { isRealDate } from '../../core/dates.js';
import { advisoryXactLock } from '../../core/locks.js';
import type { Database } from '../../db/types.js';
import { AppError } from '../../http/errors.js';
import { LISTING_TYPES, MIN_CENTS, normalizeName, TIERS } from './common.js';

export const SALES_MAX_ROWS = 5_000;
export const SalesBody = z.object({ rows: z.array(z.record(z.string(), z.unknown())).min(1).max(SALES_MAX_ROWS), dry_run: z.boolean().optional() }).strict();

const ROW_KEYS = new Set(['name', 'venue', 'sale_price_cents', 'sale_date', 'source', 'source_url', 'tier', 'listing_type']);

interface ParsedSale { name: string; venue: string; price: number; date: string; source: string; url: string | null; tier: 'A' | 'B' | 'C' | 'D'; type: 'bin' | 'offer' | 'auction' | 'closeout' }

/** One reject reason per bad row. NameBio is refused in any spelling of the source (its terms ban automated use); a missing or unknown tier is refused. */
export function parseSale(raw: Record<string, unknown>, today: string): { ok: true; v: ParsedSale } | { ok: false; reason: string } {
  for (const k of Object.keys(raw)) if (!ROW_KEYS.has(k)) return { ok: false, reason: `UNKNOWN_FIELD:${k}` };
  const source = typeof raw.source === 'string' ? raw.source.trim() : '';
  if (source.length === 0 || source.length > 120) return { ok: false, reason: 'SOURCE_REQUIRED' };
  if (/namebio/i.test(source) || (typeof raw.source_url === 'string' && /namebio/i.test(raw.source_url))) return { ok: false, reason: 'SOURCE_NAMEBIO_FORBIDDEN' };
  if (typeof raw.tier !== 'string' || raw.tier === '') return { ok: false, reason: 'TIER_REQUIRED' };
  if (!(TIERS as readonly string[]).includes(raw.tier)) return { ok: false, reason: 'TIER_INVALID' };
  const name = typeof raw.name === 'string' ? normalizeName(raw.name) : null;
  if (name === null) return { ok: false, reason: 'NAME_INVALID' };
  const venue = typeof raw.venue === 'string' ? raw.venue.trim().toLowerCase() : '';
  if (!/^[a-z0-9_.-]{1,40}$/.test(venue)) return { ok: false, reason: 'VENUE_INVALID' };
  const price = raw.sale_price_cents;
  if (typeof price !== 'number' || !Number.isInteger(price) || price < 1 || price > 10_000_000_000) return { ok: false, reason: 'PRICE_NOT_INTEGER_CENTS' };
  const date = raw.sale_date;
  if (typeof date !== 'string' || !isRealDate(date) || date < '2000-01-01') return { ok: false, reason: 'DATE_INVALID' };
  if (date > today) return { ok: false, reason: 'DATE_IN_FUTURE' };
  const url = raw.source_url === undefined || raw.source_url === null ? null : typeof raw.source_url === 'string' && raw.source_url.length <= 500 ? raw.source_url : undefined;
  if (url === undefined) return { ok: false, reason: 'SOURCE_URL_INVALID' };
  const type = raw.listing_type === undefined ? 'bin' : raw.listing_type;
  if (typeof type !== 'string' || !(LISTING_TYPES as readonly string[]).includes(type)) return { ok: false, reason: 'LISTING_TYPE_INVALID' };
  return { ok: true, v: { name, venue, price, date, source, url, tier: raw.tier as ParsedSale['tier'], type: type as ParsedSale['type'] } };
}

export interface SalesResult { dry_run: boolean; received_n: number; accepted_n: number; duplicate_n: number; rejected_n: number; below_floor_n: number }

export async function loadSales(db: Kysely<Database>, rows: Record<string, unknown>[], ctx: { by: string; auditId: string | null; todayUtc: string; dryRun: boolean }): Promise<SalesResult> {
  const bad: { row: number; reason: string }[] = [];
  const good: { i: number; v: ParsedSale }[] = [];
  rows.forEach((r, i) => { const p = parseSale(r, ctx.todayUtc); if (p.ok) good.push({ i, v: p.v }); else bad.push({ row: i, reason: p.reason }); });
  if (bad.length > 0) throw new AppError(422, 'VALIDATION_ERROR', `${bad.length} row(s) rejected; nothing was stored`, { rejects: bad.slice(0, 200), rejected_n: bad.length });
  return db.transaction().execute(async (trx) => {
    await advisoryXactLock(trx, 'market_sales');
    const seen = new Map<string, number>();
    const conflicts: { row: number; name: string; venue: string; sale_date: string; source: string; stored_price_cents: number; sent_price_cents: number }[] = [];
    const fresh: ParsedSale[] = [];
    let duplicate = 0;
    for (const { i, v } of good) {
      const key = `${v.name}|${v.venue}|${v.date}|${v.source}`;
      let stored = seen.get(key);
      if (stored === undefined) {
        const old = await trx.selectFrom('market_sales').select('sale_price_cents').where('name', '=', v.name).where('venue', '=', v.venue).where('sale_date', '=', v.date).where('source', '=', v.source).executeTakeFirst();
        stored = old?.sale_price_cents;
        if (stored === undefined) { seen.set(key, v.price); fresh.push(v); continue; }
        seen.set(key, stored);
      }
      if (stored === v.price) duplicate++;
      else conflicts.push({ row: i, name: v.name, venue: v.venue, sale_date: v.date, source: v.source, stored_price_cents: stored, sent_price_cents: v.price });
    }
    if (conflicts.length > 0) throw new AppError(409, 'APPEND_ONLY', 'A sale report is add-only: the same name, venue, sale date and source was already stored with a different price; nothing was stored', { conflicts: conflicts.slice(0, 50), conflict_n: conflicts.length });
    if (!ctx.dryRun) {
      for (const v of fresh) {
        await trx.insertInto('market_sales').values({ name: v.name, venue: v.venue, sale_price_cents: v.price, sale_date: v.date, source: v.source, source_url: v.url, tier: v.tier, listing_type: v.type, by: ctx.by, audit_id: ctx.auditId }).execute();
      }
    }
    return { dry_run: ctx.dryRun, received_n: rows.length, accepted_n: fresh.length, duplicate_n: duplicate, rejected_n: 0, below_floor_n: fresh.filter((v) => v.price < MIN_CENTS).length };
  });
}
