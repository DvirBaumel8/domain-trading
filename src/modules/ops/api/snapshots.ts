import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { isRealDate } from '../../../core/dates.js';
import type { Database } from '../../../db/types.js';
import { AppError } from '../../../http/errors.js';
import { missingDays } from '../../reporting/index.js';

const day = z.string().refine(isRealDate, 'must be a real date (YYYY-MM-DD)');
const Query = z.object({
  date: day.optional(),
  source: z.enum(['godaddy_inventory', 'dynadot_closeouts', 'dynadot_aftermarket']).optional(),
}).strict();
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
    let sel = db.selectFrom('snapshot_manifests').selectAll().where('data_date', '>=', from).where('data_date', '<=', to).orderBy('data_date', 'desc').orderBy('file_name');
    if (q.source) sel = sel.where('source', '=', q.source);
    const rows = await sel.limit(500).execute();
    const pool = await sql<{ data_date: string; source: string; rows: string }>`
      select data_date::text as data_date, source, count(*)::text as rows from datasave_pool where data_date between ${from}::date and ${to}::date group by 1, 2 order by 1 desc`.execute(db);
    return {
      date: q.date ?? null, source: q.source ?? null,
      snapshots: rows.map((m) => ({
        source: m.source, data_date: m.data_date, file_name: m.file_name, status: m.status, bytes: m.bytes, sha256: m.sha256, last_modified: iso(m.last_modified),
        rows: m.rows, rows_total: m.rows_total, http_status: m.http_status, error: m.error, price_unit: m.rows === null ? null : 'cents',
        raw_available: m.raw_available, raw_deleted_at: iso(m.raw_deleted_at), raw_note: m.raw_note, sealed: m.sealed_at !== null, sealed_at: iso(m.sealed_at),
      })),
      pool: pool.rows.map((r) => ({ data_date: r.data_date, source: r.source, rows: Number(r.rows) })),
    };
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
