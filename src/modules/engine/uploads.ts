// v5.4.0 (CR-056 part 1): uploads of sold and unsold names for the scoring engine. Each row is checked on its own: a bad row is rejected with a
// reason and the rest are stored. A whole upload is one transaction under one advisory lock, so two uploads never race on the duplicate check.
import type { Kysely } from 'kysely';
import { dayNumber, idtDay, isRealDate } from '../../core/dates.js';
import { advisoryXactLock } from '../../core/locks.js';
import type { Database } from '../../db/types.js';
import { normalizeDomain } from '../../domain-name.js';
import { AppError } from '../../http/errors.js';

export const ENGINE_MAX_ROWS = 20_000;
export const ENGINE_MAX_REJECTS = 200;
/** Two sales of one name within this many days (either way) are the same sale reported twice. */
export const SALE_DEDUPE_DAYS = 20;
export const ENGINE_EARLIEST_DATE = '2000-01-01';
export const UNSOLD_TYPES = ['dropped_after_held', 'registered_unsold'] as const;
export type UnsoldType = (typeof UNSOLD_TYPES)[number];

export interface Reject { row: number; domain: string | null; reason: string }
export interface UploadResult { upload_id: number; received_n: number; accepted_n: number; duplicate_n: number; rejected_n: number; rejects: Reject[] }
interface Ctx { by: string; auditId: string | null; now: number }

interface SaleRow { domain: string; price_cents: number; sale_date: string; venue: string; source: string; source_url: string | null }
interface UnsoldRow { domain: string; type: UnsoldType; observation_date: string; caught_by_catcher: boolean | null }
type Parsed<T> = { ok: true; value: T } | { ok: false; domain: string | null; reason: string };

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const rawDomain = (r: Record<string, unknown>): string | null => (typeof r.domain === 'string' ? r.domain.slice(0, 253) : null);

function domainOf(r: Record<string, unknown>): { domain: string } | { reason: string } {
  if (typeof r.domain !== 'string') return { reason: 'DOMAIN_INVALID' };
  try {
    return { domain: normalizeDomain(r.domain) };
  } catch (e) {
    return { reason: e instanceof AppError ? e.code : 'DOMAIN_INVALID' };
  }
}

/** A real calendar date from the earliest allowed one to today (IDT). */
function dateOf(v: unknown, today: string): { date: string } | { reason: string } {
  if (typeof v !== 'string' || !isRealDate(v) || v < ENGINE_EARLIEST_DATE) return { reason: 'DATE_INVALID' };
  if (v > today) return { reason: 'DATE_IN_FUTURE' };
  return { date: v };
}

function centsOf(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,9}(\.\d{1,2})?$/.test(v.trim()) ? Number(v.trim()) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > 100_000_000) return null;
  const cents = Math.round(n * 100);
  return cents >= 1 ? cents : null;
}

const textOf = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= max ? v.trim() : null);

export function parseSaleRow(raw: unknown, today: string): Parsed<SaleRow> {
  if (!isObj(raw)) return { ok: false, domain: null, reason: 'ROW_INVALID' };
  const d = domainOf(raw);
  if ('reason' in d) return { ok: false, domain: rawDomain(raw), reason: d.reason };
  const fail = (reason: string): Parsed<SaleRow> => ({ ok: false, domain: d.domain, reason });
  const cents = centsOf(raw.price_usd);
  if (cents === null) return fail('PRICE_INVALID');
  const date = dateOf(raw.sale_date, today);
  if ('reason' in date) return fail(date.reason);
  const venue = textOf(raw.venue, 60);
  if (venue === null) return fail('VENUE_INVALID');
  const source = textOf(raw.source, 200);
  if (source === null) return fail('SOURCE_INVALID');
  let sourceUrl: string | null = null;
  if (raw.source_url !== undefined && raw.source_url !== null && raw.source_url !== '') {
    sourceUrl = textOf(raw.source_url, 500);
    if (sourceUrl === null) return fail('SOURCE_URL_INVALID');
  }
  return { ok: true, value: { domain: d.domain, price_cents: cents, sale_date: date.date, venue, source, source_url: sourceUrl } };
}

export function parseUnsoldRow(raw: unknown, today: string): Parsed<UnsoldRow> {
  if (!isObj(raw)) return { ok: false, domain: null, reason: 'ROW_INVALID' };
  const d = domainOf(raw);
  if ('reason' in d) return { ok: false, domain: rawDomain(raw), reason: d.reason };
  const fail = (reason: string): Parsed<UnsoldRow> => ({ ok: false, domain: d.domain, reason });
  if (typeof raw.type !== 'string' || !(UNSOLD_TYPES as readonly string[]).includes(raw.type)) return fail('TYPE_INVALID');
  const date = dateOf(raw.observation_date, today);
  if ('reason' in date) return fail(date.reason);
  const c = raw.caught_by_catcher;
  if (c !== undefined && c !== null && typeof c !== 'boolean') return fail('CAUGHT_BY_CATCHER_INVALID');
  return { ok: true, value: { domain: d.domain, type: raw.type as UnsoldType, observation_date: date.date, caught_by_catcher: typeof c === 'boolean' ? c : null } };
}

const CHUNK = 2_000;
const chunks = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));

async function store<T extends { domain: string }>(
  db: Kysely<Database>, kind: 'sales' | 'unsold', rows: unknown[], ctx: Ctx,
  parse: (raw: unknown, today: string) => Parsed<T>,
  isDuplicate: (trx: Kysely<Database>, valid: T[]) => Promise<(r: T) => boolean>,
  insert: (trx: Kysely<Database>, uploadId: number, accepted: T[]) => Promise<void>,
): Promise<UploadResult> {
  if (rows.length < 1 || rows.length > ENGINE_MAX_ROWS) throw new AppError(422, 'VALIDATION_ERROR', `rows must hold 1 to ${ENGINE_MAX_ROWS} rows`);
  const today = idtDay(ctx.now);
  const rejects: Reject[] = [];
  const valid: { i: number; v: T }[] = [];
  rows.forEach((raw, i) => {
    const p = parse(raw, today);
    if (p.ok) valid.push({ i, v: p.value });
    else rejects.push({ row: i, domain: p.domain, reason: p.reason });
  });
  return db.transaction().execute(async (trx) => {
    await advisoryXactLock(trx, 'engine_upload');
    const dup = await isDuplicate(trx, valid.map((x) => x.v));
    const accepted: T[] = [];
    let duplicates = 0;
    for (const { v } of valid) {
      if (dup(v)) duplicates += 1;
      else accepted.push(v);
    }
    const up = await trx.insertInto('engine_uploads').values({
      kind, received_n: rows.length, accepted_n: accepted.length, duplicate_n: duplicates, rejected_n: rejects.length,
      rejects: JSON.stringify(rejects.slice(0, ENGINE_MAX_REJECTS)), by: ctx.by, audit_id: ctx.auditId, created_at: new Date(ctx.now),
    }).returning('id').executeTakeFirstOrThrow();
    await insert(trx, up.id, accepted);
    return { upload_id: up.id, received_n: rows.length, accepted_n: accepted.length, duplicate_n: duplicates, rejected_n: rejects.length, rejects: rejects.slice(0, ENGINE_MAX_REJECTS) };
  });
}

export function storeSales(db: Kysely<Database>, rows: unknown[], ctx: Ctx): Promise<UploadResult> {
  return store<SaleRow>(db, 'sales', rows, ctx, parseSaleRow,
    async (trx, valid) => {
      // Dates of the stored sales of every name in the upload; accepted rows are added as the loop goes, so a repeat inside one upload is a duplicate too.
      const dates = new Map<string, number[]>();
      for (const part of chunks([...new Set(valid.map((r) => r.domain))], 5_000)) {
        const found = await trx.selectFrom('engine_sales').select(['domain', 'sale_date']).where('domain', 'in', part).execute();
        for (const f of found) (dates.get(f.domain) ?? dates.set(f.domain, []).get(f.domain)!).push(dayNumber(f.sale_date));
      }
      return (r) => {
        const n = dayNumber(r.sale_date);
        const have = dates.get(r.domain) ?? dates.set(r.domain, []).get(r.domain)!;
        if (have.some((x) => Math.abs(x - n) <= SALE_DEDUPE_DAYS)) return true;
        have.push(n);
        return false;
      };
    },
    async (trx, uploadId, accepted) => {
      for (const part of chunks(accepted, CHUNK)) await trx.insertInto('engine_sales').values(part.map((r) => ({ ...r, upload_id: uploadId }))).execute();
    });
}

export function storeUnsold(db: Kysely<Database>, rows: unknown[], ctx: Ctx): Promise<UploadResult> {
  return store<UnsoldRow>(db, 'unsold', rows, ctx, parseUnsoldRow,
    async (trx, valid) => {
      const seen = new Set<string>();
      for (const part of chunks([...new Set(valid.map((r) => r.domain))], 5_000)) {
        const found = await trx.selectFrom('engine_unsold').select(['domain', 'observation_date']).where('domain', 'in', part).execute();
        for (const f of found) seen.add(`${f.domain}|${f.observation_date}`);
      }
      return (r) => {
        const k = `${r.domain}|${r.observation_date}`;
        if (seen.has(k)) return true;
        seen.add(k);
        return false;
      };
    },
    async (trx, uploadId, accepted) => {
      for (const part of chunks(accepted, CHUNK)) await trx.insertInto('engine_unsold').values(part.map((r) => ({ ...r, upload_id: uploadId }))).execute();
    });
}
