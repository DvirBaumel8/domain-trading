// v5.22.0 (CR-071 R-8, R-9): POST /snapshots/dynadot. The bots pull Dynadot's data (the server has no Dynadot key) and upload the rows; DOM stores them in
// `dynadot_rows` and seals the day at `final: true` with a manifest (source `dynadot_<kind>`, file `bot_upload`, origin `bot_upload`) like a GoDaddy file.
//   - one manifest per (kind, data_date): open (status partial) while parts arrive, sealed (status complete, sha256) by the part with `final: true`;
//   - a sealed (kind, data_date) takes no more rows: 409 SNAPSHOT_SEALED, nothing changes;
//   - aftermarket rows under $500 are dropped and counted; duplicates (listing_id for aftermarket, domain for the others) are counted, the first one wins;
//   - sha256 = SHA-256 of the UTF-8 JSON array of the day's stored rows, sorted by domain then listing_id (bytewise), each row an object with the keys of its kind
//     in the order below (absent optional values as null, timestamps as `toISOString()`).
import { createHash } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { z } from 'zod';
import { isRealDate } from '../../../../core/dates.js';
import { advisoryXactLock } from '../../../../core/locks.js';
import type { Database, SnapshotSource } from '../../../../db/types.js';
import { AppError } from '../../../../http/errors.js';

export const DYNADOT_KINDS = ['aftermarket', 'closed_auctions', 'closeouts'] as const;
export type DynadotKind = (typeof DYNADOT_KINDS)[number];
export const dynadotSource = (kind: DynadotKind): SnapshotSource => `dynadot_${kind}` as SnapshotSource;
export const BOT_UPLOAD_FILE = 'bot_upload';
/** Aftermarket rows under this price are dropped ($500). */
export const AFTERMARKET_MIN_CENTS = 50_000;
export const DYNADOT_MAX_ROWS = 50_000;
/** The highest price a row may carry (BUG-051: refused with 422 PRICE_CAP, never clamped). */
export const DYNADOT_MAX_PRICE_CENTS = 2_000_000_000;
const BATCH = 5_000;

const domain = z.string().trim().min(3).max(253).transform((s) => s.toLowerCase().replace(/\.$/, '')).refine((s) => /^(?!-)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/.test(s), 'must be a domain name');
const cents = z.number().int().min(0).max(DYNADOT_MAX_PRICE_CENTS);
const iso = z.string().refine((s) => /^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(Date.parse(s)), 'must be an ISO 8601 date-time');
const page = z.number().int().min(1).max(100_000);
/** v5.24.0 (CR-071 R-8b): how complete a bot's pull was; a day is sealed even when some pages failed. Stored on the manifest, shown by GET /snapshots. */
export const Coverage = z.object({
  partial: z.boolean(), calls_n: z.number().int().min(0).max(1_000), pages_planned: z.array(page).max(1_000),
  pages_ok: z.array(page).max(1_000), pages_failed: z.array(page).max(1_000), rows_received_n: z.number().int().min(0).max(100_000_000),
}).strict().superRefine((c, ctx) => {
  const planned = new Set(c.pages_planned);
  for (const key of ['pages_ok', 'pages_failed'] as const) {
    if (c[key].some((p) => !planned.has(p))) ctx.addIssue({ code: 'custom', path: [key], message: 'must be a subset of pages_planned' });
  }
});
export type Coverage = z.infer<typeof Coverage>;
const common = { data_date: z.string().refine(isRealDate, 'must be a real date (YYYY-MM-DD)'), final: z.boolean().optional(), dry_run: z.boolean().optional(), coverage: Coverage.optional() };
const rows = <T extends z.ZodType>(row: T) => z.array(row).max(DYNADOT_MAX_ROWS);

export const DynadotBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('aftermarket'), ...common, rows: rows(z.object({ domain, listing_id: z.string().trim().min(1).max(100), price_cents: cents }).strict()) }).strict(),
  z.object({ kind: z.literal('closed_auctions'), ...common, rows: rows(z.object({ domain, end_time: iso, bid_count: z.number().int().min(0).max(1_000_000), final_price_cents: cents }).strict()) }).strict(),
  z.object({ kind: z.literal('closeouts'), ...common, rows: rows(z.object({ domain, price_cents: cents, ends_at: iso.optional() }).strict()) }).strict(),
]);
export type DynadotBody = z.infer<typeof DynadotBody>;

interface Insert { data_date: string; kind: DynadotKind; domain: string; listing_id: string | null; price_cents: number | null; bid_count: number | null; end_time: Date | null; final_price_cents: number | null; ends_at: Date | null }

export interface DynadotResult {
  kind: DynadotKind; data_date: string; dry_run: boolean; final: boolean; sealed: boolean; status: 'partial' | 'complete';
  received_n: number; accepted_n: number; duplicate_n: number; dropped_under_500_n: number; dropped_below_floor_n: number; rows_stored_n: number; sha256: string | null;
}

class DryRunRollback extends Error { constructor(readonly result: DynadotResult) { super('dry run'); } }

function toInserts(b: DynadotBody): { inserts: Insert[]; duplicates: number; dropped: number } {
  const seen = new Set<string>();
  const inserts: Insert[] = [];
  let duplicates = 0;
  let dropped = 0;
  for (const r of b.rows) {
    let ins: Insert;
    let key: string;
    if (b.kind === 'aftermarket') {
      const x = r as { domain: string; listing_id: string; price_cents: number };
      if (x.price_cents < AFTERMARKET_MIN_CENTS) { dropped++; continue; }
      key = x.listing_id;
      ins = { data_date: b.data_date, kind: b.kind, domain: x.domain, listing_id: x.listing_id, price_cents: x.price_cents, bid_count: null, end_time: null, final_price_cents: null, ends_at: null };
    } else if (b.kind === 'closed_auctions') {
      const x = r as { domain: string; end_time: string; bid_count: number; final_price_cents: number };
      key = x.domain;
      ins = { data_date: b.data_date, kind: b.kind, domain: x.domain, listing_id: null, price_cents: null, bid_count: x.bid_count, end_time: new Date(x.end_time), final_price_cents: x.final_price_cents, ends_at: null };
    } else {
      const x = r as { domain: string; price_cents: number; ends_at?: string };
      key = x.domain;
      ins = { data_date: b.data_date, kind: b.kind, domain: x.domain, listing_id: null, price_cents: x.price_cents, bid_count: null, end_time: null, final_price_cents: null, ends_at: x.ends_at ? new Date(x.ends_at) : null };
    }
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key);
    inserts.push(ins);
  }
  return { inserts, duplicates, dropped };
}

const iso3 = (d: Date | null): string | null => (d ? d.toISOString() : null);

async function canonicalSha(trx: Transaction<Database>, kind: DynadotKind, dataDate: string): Promise<string> {
  const rs = await trx.selectFrom('dynadot_rows').selectAll().where('data_date', '=', dataDate).where('kind', '=', kind)
    .orderBy(sql`domain collate "C"`).orderBy(sql`listing_id collate "C"`).execute();
  const canon = rs.map((r) => (kind === 'aftermarket' ? { domain: r.domain, listing_id: r.listing_id, price_cents: r.price_cents }
    : kind === 'closed_auctions' ? { domain: r.domain, end_time: iso3(r.end_time), bid_count: r.bid_count, final_price_cents: r.final_price_cents }
      : { domain: r.domain, price_cents: r.price_cents, ends_at: iso3(r.ends_at) }));
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

export async function uploadDynadot(db: Kysely<Database>, b: DynadotBody, nowMs: number): Promise<DynadotResult> {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  if (b.data_date > today) throw new AppError(422, 'VALIDATION_ERROR', 'data_date must not be in the future (UTC)', { data_date: b.data_date });
  const final = b.final === true;
  if (b.rows.length === 0 && !final) throw new AppError(422, 'VALIDATION_ERROR', 'rows must hold at least one row unless final is true');
  const { inserts, duplicates: dupInRequest, dropped } = toInserts(b);
  const source = dynadotSource(b.kind);
  const now = new Date(nowMs);
  try {
    return await db.transaction().execute(async (trx) => {
      await advisoryXactLock(trx, `dynadot_upload:${source}:${b.data_date}`);
      const existing = await trx.selectFrom('snapshot_manifests').select(['sealed_at', 'sha256', 'rows']).where('source', '=', source).where('data_date', '=', b.data_date).where('file_name', '=', BOT_UPLOAD_FILE).executeTakeFirst();
      if (existing?.sealed_at) throw new AppError(409, 'SNAPSHOT_SEALED', 'This kind and data_date are sealed; nothing was changed', { kind: b.kind, data_date: b.data_date, sha256: existing.sha256, rows: existing.rows });
      let accepted = 0;
      for (let i = 0; i < inserts.length; i += BATCH) {
        const res = await trx.insertInto('dynadot_rows').values(inserts.slice(i, i + BATCH)).onConflict((oc) => oc.doNothing()).executeTakeFirst();
        accepted += Number(res.numInsertedOrUpdatedRows ?? 0);
      }
      const duplicate_n = dupInRequest + (inserts.length - accepted);
      const stored = Number((await trx.selectFrom('dynadot_rows').select((eb) => eb.fn.countAll<string>().as('n')).where('data_date', '=', b.data_date).where('kind', '=', b.kind).executeTakeFirstOrThrow()).n);
      if (final && stored === 0) throw new AppError(422, 'VALIDATION_ERROR', 'cannot seal an empty snapshot: no rows were stored for this kind and data_date');
      const sha256 = final ? await canonicalSha(trx, b.kind, b.data_date) : null;
      const status = final ? 'complete' : 'partial';
      const values = {
        source, data_date: b.data_date, file_name: BOT_UPLOAD_FILE, bytes: null, sha256, last_modified: now, rows: stored, rows_total: b.rows.length,
        status: status as 'complete' | 'partial', http_status: null, error: null, raw_path: null, raw_available: false, raw_note: 'rows uploaded by a bot; no raw file',
        sealed_at: final ? now : null, created_at: now, updated_at: now, origin: 'bot_upload' as const, coverage: b.coverage ? JSON.stringify(b.coverage) : null,
      };
      await trx.insertInto('snapshot_manifests').values(values).onConflict((oc) => oc.columns(['source', 'data_date', 'file_name']).doUpdateSet({
        sha256: values.sha256, last_modified: now, rows: stored, status: values.status, sealed_at: values.sealed_at, updated_at: now,
        coverage: sql`coalesce(excluded.coverage, snapshot_manifests.coverage)`, // the latest part that sends coverage wins
        rows_total: sql`coalesce(snapshot_manifests.rows_total, 0) + ${b.rows.length}`,
      }).where('snapshot_manifests.sealed_at', 'is', null)).execute();
      const result: DynadotResult = {
        kind: b.kind, data_date: b.data_date, dry_run: b.dry_run === true, final, sealed: final && b.dry_run !== true, status, received_n: b.rows.length, accepted_n: accepted,
        duplicate_n, dropped_under_500_n: dropped, dropped_below_floor_n: dropped, rows_stored_n: stored, sha256,
      };
      if (b.dry_run === true) throw new DryRunRollback(result);
      return result;
    });
  } catch (e) {
    if (e instanceof DryRunRollback) return e.result;
    throw e;
  }
}
