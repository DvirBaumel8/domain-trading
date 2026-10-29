// v5.10.0 (CR-061): the holdout date (engine.sales_max_date) and the database-size guard of the engine uploads.
// 5.41.0: the holdout date is deprecated and blocks nothing (the trainer keeps the newest full quarter as its test file); the date is only stored and shown.
import { sql, type Kysely } from 'kysely';
import { checkApproval } from '../../core/approval.js';
import { advisoryXactLock } from '../../core/locks.js';
import type { Database } from '../../db/types.js';
import { AppError } from '../../http/errors.js';

/** Reject reasons that are no longer returned but stay in the contract's code list (5.41.0: HOLDOUT_SEALED). */
export const RETIRED_REJECT_CODES = ['HOLDOUT_SEALED'] as const;

/** The stored holdout date (IDT day). Deprecated since 5.41.0: no row is rejected for it. */
export async function salesMaxDate(db: Kysely<Database>): Promise<string> {
  const r = await db.selectFrom('settings').select('engine_sales_max_date').executeTakeFirstOrThrow();
  return r.engine_sales_max_date;
}

export interface HoldoutChange { previous: string; date: string; approved_at: string }

/** POST /engine/holdout-date: the approval text must name the date; same age and future rules as every approval (settings.approval_max_age_hours). */
export async function setSalesMaxDate(db: Kysely<Database>, date: string, ref: { text?: unknown; approved_at?: unknown } | null | undefined, now: Date): Promise<HoldoutChange> {
  return db.transaction().execute(async (trx) => {
    await advisoryXactLock(trx, 'engine_upload'); // M4: waits for an upload in flight; later uploads read the new date under the same lock
    const s = await trx.selectFrom('settings').select(['engine_sales_max_date', 'approval_max_age_hours']).forUpdate().executeTakeFirstOrThrow();
    const a = checkApproval(ref, date, now, s.approval_max_age_hours);
    if (!a.ok) throw new AppError(422, a.code, a.reason.replace('name the domain', 'name the date'));
    await trx.updateTable('settings').set({ engine_sales_max_date: date, updated_at: now }).execute();
    return { previous: s.engine_sales_max_date, date, approved_at: a.approvedAt.toISOString() };
  });
}

/** The size of a request body for the size guard: the Content-Length header when the client sent one, else the rows serialised (the 8 MB body limit is checked by Fastify either way). */
export function payloadBytesOf(req: { headers: Record<string, unknown> }, rows: unknown): number {
  const h = req.headers['content-length'];
  const n = typeof h === 'string' && /^\d+$/.test(h) ? Number(h) : NaN;
  return Number.isFinite(n) ? n : Buffer.byteLength(JSON.stringify(rows));
}

export async function databaseBytes(db: Kysely<Database>): Promise<number> {
  return Number((await sql<{ n: string }>`select pg_database_size(current_database())::text as n`.execute(db)).rows[0]!.n);
}

/** v5.77.0 (CR-097): a request of at most smallWriteBytes is refused only at hardStopPercent (both optional; without them every write stops at warnPercent, as bulk feeds do). */
export interface DbSizeGuard { limitBytes: number; warnPercent: number; bytes?: () => Promise<number>; smallWriteBytes?: number; hardStopPercent?: number }

/** Reads the size before a load; refuses (409 DB_SIZE_HIGH) when size + the payload would pass warnPercent of the limit. Returns the size read. */
export async function guardDbSize(db: Kysely<Database>, g: DbSizeGuard, payloadBytes: number): Promise<number> {
  const before = await (g.bytes ?? (() => databaseBytes(db)))();
  const small = g.smallWriteBytes !== undefined && g.hardStopPercent !== undefined && payloadBytes <= g.smallWriteBytes;
  const percent = small ? g.hardStopPercent! : g.warnPercent;
  const ceiling = (g.limitBytes * percent) / 100;
  if (before + payloadBytes > ceiling) {
    throw new AppError(409, 'DB_SIZE_HIGH', `The database is ${(before / 1024 ** 2).toFixed(0)} MB; this load (about ${(payloadBytes / 1024 ** 2).toFixed(1)} MB) would pass ${percent}% of the ${(g.limitBytes / 1024 ** 2).toFixed(0)} MB limit`, {
      db_bytes_before: before, payload_bytes: payloadBytes, limit_bytes: g.limitBytes, warn_percent: g.warnPercent, stop_percent: percent,
    });
  }
  return before;
}
