// v5.4.0 (CR-056 part 1): uploads of sold and unsold names for the scoring engine. Each row is checked on its own: a bad row is rejected with a
// reason and the rest are stored. A whole upload is one transaction under one advisory lock, so two uploads never race on the duplicate check.
import type { Kysely } from 'kysely';
import { chunks } from '../../core/chunks.js';
import { dayNumber, idtDay } from '../../core/dates.js';
import type { Database } from '../../db/types.js';
import { bulkLoad, centsOf, ENGINE_MAX_REJECTS, dateOf, domainOf, isObj, rawDomain, textOf, type Parsed, type Reject } from './bulk.js';

export { ENGINE_MAX_ROWS } from './bulk.js';
/** Two sales of one name within this many days (either way) are the same sale reported twice. */
const SALE_DEDUPE_DAYS = 20;
export const UNSOLD_TYPES = ['dropped_after_held', 'registered_unsold'] as const;
type UnsoldType = (typeof UNSOLD_TYPES)[number];

export interface UploadResult { upload_id: number; received_n: number; accepted_n: number; duplicate_n: number; rejected_n: number; rejects: Reject[] }
interface Ctx { by: string; auditId: string | null; now: number }

interface SaleRow { domain: string; price_cents: number; sale_date: string; venue: string; source: string; source_url: string | null }
interface UnsoldRow { domain: string; type: UnsoldType; observation_date: string; caught_by_catcher: boolean | null }

function parseSaleRow(raw: unknown, today: string): Parsed<SaleRow> {
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
  // v5.41.0: NameBio's terms forbid training models on its data without written permission (round-2 research, 25 Oct 2026); same rule as POST /data/sales
  if ([venue, source, sourceUrl ?? ''].some((t) => /namebio/i.test(t))) return fail('SOURCE_NAMEBIO_FORBIDDEN');
  return { ok: true, value: { domain: d.domain, price_cents: cents, sale_date: date.date, venue, source, source_url: sourceUrl } };
}

function parseUnsoldRow(raw: unknown, today: string): Parsed<UnsoldRow> {
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

async function store<T extends { domain: string }>(
  db: Kysely<Database>, kind: 'sales' | 'unsold', rows: unknown[], ctx: Ctx,
  parse: (raw: unknown, today: string) => Parsed<T>,
  isDuplicate: (trx: Kysely<Database>, valid: T[]) => Promise<(r: T) => boolean>,
  insert: (trx: Kysely<Database>, uploadId: number, accepted: T[]) => Promise<void>,
): Promise<UploadResult> {
  const today = idtDay(ctx.now);
  const { result, rejects } = await bulkLoad(db, rows, {
    parse: (raw) => parse(raw, today),
    apply: async (trx, valid, rejected) => {
      const dup = await isDuplicate(trx, valid.map((x) => x.v));
      const accepted: T[] = [];
      let duplicates = 0;
      for (const { v } of valid) {
        if (dup(v)) duplicates += 1;
        else accepted.push(v);
      }
      const up = await trx.insertInto('engine_uploads').values({
        kind, received_n: rows.length, accepted_n: accepted.length, duplicate_n: duplicates, rejected_n: rejected.length,
        rejects: JSON.stringify(rejected.slice(0, ENGINE_MAX_REJECTS)), by: ctx.by, audit_id: ctx.auditId, created_at: new Date(ctx.now),
      }).returning('id').executeTakeFirstOrThrow();
      await insert(trx, up.id, accepted);
      return { upload_id: up.id, accepted_n: accepted.length, duplicate_n: duplicates };
    },
  });
  return { upload_id: result.upload_id, received_n: rows.length, accepted_n: result.accepted_n, duplicate_n: result.duplicate_n, rejected_n: rejects.length, rejects: rejects.slice(0, ENGINE_MAX_REJECTS) };
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
