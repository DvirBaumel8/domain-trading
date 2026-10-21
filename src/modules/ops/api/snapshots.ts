import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { isRealDate } from '../../../core/dates.js';
import type { Database } from '../../../db/types.js';
import { AppError } from '../../../http/errors.js';
import { missingDays } from '../../reporting/index.js';
import { DYNADOT_MAX_PRICE_CENTS, DYNADOT_MAX_ROWS, DynadotBody, uploadDynadot } from '../jobs/datasave/dynadot-upload.js';

const day = z.string().refine(isRealDate, 'must be a real date (YYYY-MM-DD)');
const Query = z.object({
  date: day.optional(),
  source: z.enum(['godaddy_inventory', 'dynadot_closeouts', 'dynadot_aftermarket', 'dynadot_closed_auctions', 'godaddy_auction_end']).optional(),
  /** v5.22.0: with a Dynadot `source` and a `date`, also return up to this many stored rows. */
  rows: z.coerce.number().int().min(0).max(1000).optional(),
}).strict();
/** Body limit of the Dynadot upload, like the engine bulk routes. */
const UPLOAD_BODY_LIMIT = 8 * 1024 * 1024;
const MissingQuery = z.object({ from: day.optional(), to: day.optional() }).strict();

const bad = (p: { error: z.ZodError }) => new AppError(400, 'VALIDATION_ERROR', `Invalid query: ${p.error.issues.map((i) => `${i.path.join('.') || 'query'} ${i.message}`).join('; ')}`);
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

interface SnapshotsDeps { db: Kysely<Database>; now: () => number }

/**
 * v5.21.0 (CR-071). GET /snapshots (any bot token): the manifests of the daily saves with the parsed row counts; never raw contents.
 * GET /snapshots/missing: the days with no complete save of every configured file. Nothing here writes; there is no route to re-parse or re-download.
 */
export function registerSnapshots(app: FastifyInstance, deps: SnapshotsDeps): void {
  const { db } = deps;
  app.get('/snapshots', async (req) => {
    const p = Query.safeParse(req.query);
    if (!p.success) throw bad(p);
    const q = p.data;
    const today = new Date(deps.now()).toISOString().slice(0, 10);
    const from = q.date ?? new Date(deps.now() - 13 * 86_400_000).toISOString().slice(0, 10);
    const to = q.date ?? today;
    const wantAuctions = q.source === 'godaddy_auction_end';
    let sel = db.selectFrom('snapshot_manifests').selectAll().where('data_date', '>=', from).where('data_date', '<=', to).orderBy('data_date', 'desc').orderBy('file_name');
    if (q.source && q.source !== 'godaddy_auction_end') sel = sel.where('source', '=', q.source);
    const rows = wantAuctions ? [] : await sel.limit(500).execute();
    const pool = await sql<{ data_date: string; source: string; rows: string }>`
      select data_date::text as data_date, source, count(*)::text as rows from datasave_pool where data_date between ${from}::date and ${to}::date group by 1, 2 order by 1 desc`.execute(db);
    return {
      date: q.date ?? null, source: q.source ?? null,
      snapshots: rows.map((m) => ({
        source: m.source, data_date: m.data_date, file_name: m.file_name, status: m.status, bytes: m.bytes, sha256: m.sha256, last_modified: iso(m.last_modified),
        origin: m.origin, coverage: m.coverage ?? null, rows: m.rows, rows_total: m.rows_total, http_status: m.http_status, error: m.error, price_unit: m.rows === null ? null : 'cents',
        raw_available: m.raw_available, raw_deleted_at: iso(m.raw_deleted_at), raw_note: m.raw_note, sealed: m.sealed_at !== null, sealed_at: iso(m.sealed_at),
      })),
      pool: pool.rows.map((r) => ({ data_date: r.data_date, source: r.source, rows: Number(r.rows) })),
      ...(wantAuctions ? { auctions: await endedAuctions(db, from, to) } : {}),
      ...(q.source?.startsWith('dynadot_') && q.rows ? { rows: await storedRows(db, q.source, from, to, q.rows) } : {}),
    };
  });

  // v5.22.0 (CR-071 R-8, R-9): the bots upload the Dynadot rows they pulled; DOM stores and seals them (final: true). Non-money; dry_run validates and stores nothing.
  app.post('/snapshots/dynadot', { config: { openapiBody: DynadotBody }, bodyLimit: UPLOAD_BODY_LIMIT }, async (req, reply) => {
    const b = parseDynadot(req.body ?? {});
    const r = await uploadDynadot(db, b, deps.now());
    req.auditSummary = `dynadot ${r.kind} ${r.data_date}${r.dry_run ? ' (dry run)' : ''}: ${r.received_n} received, ${r.accepted_n} stored, ${r.duplicate_n} duplicate, ${r.dropped_under_500_n} under $500${r.sealed ? ', sealed' : ''}`;
    return reply.code(201).send({ ...r, audit_id: req.auditId ?? null });
  });

  app.get('/snapshots/missing', async (req) => {
    const p = MissingQuery.safeParse(req.query);
    if (!p.success) throw bad(p);
    const to = p.data.to ?? new Date(deps.now() - 16 * 3_600_000).toISOString().slice(0, 10);
    const from = p.data.from ?? new Date(Date.parse(`${to}T00:00:00Z`) - 13 * 86_400_000).toISOString().slice(0, 10);
    if (from > to) throw new AppError(400, 'VALIDATION_ERROR', 'from must not be after to');
    if (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 365 * 86_400_000) throw new AppError(400, 'VALIDATION_ERROR', 'the range may be at most 366 days');
    const r = await missingDays(db, from, to);
    return { source: 'godaddy_inventory', from, to, expected_files: r.expected_files, missing: r.missing };
  });
}

/** The GoDaddy auctions whose final state was recorded on a data date in [from, to] (they left the inventory files; last bid count and price are final). */
async function endedAuctions(db: Kysely<Database>, from: string, to: string) {
  const rs = await db.selectFrom('godaddy_auctions').selectAll().where('ended', '=', true).where('final_state_at', '>=', from).where('final_state_at', '<=', to)
    .orderBy('final_state_at', 'desc').orderBy('domain').limit(1000).execute();
  return rs.map((a) => ({
    domain: a.domain, end_time: a.end_time.toISOString(), auction_type: a.auction_type, first_seen: a.first_seen, last_seen: a.last_seen, final_state_at: a.final_state_at,
    bid_count: a.last_bid_count, final_price_cents: a.last_price_cents, max_price_cents: a.max_price_cents, price_unit: 'cents',
  }));
}

async function storedRows(db: Kysely<Database>, source: string, from: string, to: string, limit: number) {
  const kind = source.slice('dynadot_'.length) as 'aftermarket' | 'closed_auctions' | 'closeouts';
  const rs = await db.selectFrom('dynadot_rows').selectAll().where('kind', '=', kind).where('data_date', '>=', from).where('data_date', '<=', to).orderBy('data_date', 'desc').orderBy('domain').limit(limit).execute();
  return rs.map((r) => ({
    data_date: r.data_date, domain: r.domain,
    ...(kind === 'aftermarket' ? { listing_id: r.listing_id, price_cents: r.price_cents } : {}),
    ...(kind === 'closed_auctions' ? { end_time: r.end_time?.toISOString() ?? null, bid_count: r.bid_count, final_price_cents: r.final_price_cents } : {}),
    ...(kind === 'closeouts' ? { price_cents: r.price_cents, ends_at: r.ends_at?.toISOString() ?? null } : {}),
  }));
}

/** v5.32.0 (BUG-051): the row limit and the price cap get their own 422 codes (ROWS_LIMIT first); every other issue stays VALIDATION_ERROR (thrown by zod). */
function parseDynadot(body: unknown): DynadotBody {
  const p = DynadotBody.safeParse(body);
  if (p.success) return p.data;
  const rows = (body as { rows?: unknown }).rows;
  const received = Array.isArray(rows) ? rows.length : 0;
  if (p.error.issues.some((i) => i.code === 'too_big' && i.path.length === 1 && i.path[0] === 'rows')) {
    throw new AppError(422, 'ROWS_LIMIT', `At most ${DYNADOT_MAX_ROWS} rows per call (got ${received}); send several calls with the same kind and data_date. Nothing was stored`, { max_rows: DYNADOT_MAX_ROWS, received_n: received });
  }
  const over = [...new Set(p.error.issues.filter((i) => i.code === 'too_big' && i.path[0] === 'rows' && typeof i.path[1] === 'number' && (i.path[2] === 'price_cents' || i.path[2] === 'final_price_cents')).map((i) => i.path[1] as number))].sort((a, c) => a - c);
  if (over.length > 0) {
    throw new AppError(422, 'PRICE_CAP', `${over.length} row(s) have a price above ${DYNADOT_MAX_PRICE_CENTS} cents; leave them out. Nothing was stored`, { max_cents: DYNADOT_MAX_PRICE_CENTS, rows: over.slice(0, 20), over_n: over.length });
  }
  throw p.error;
}
