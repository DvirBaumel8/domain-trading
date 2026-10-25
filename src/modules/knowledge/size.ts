// CR-078: the database size guard of the write routes (same rule as the engine uploads: 409 DB_SIZE_HIGH when size + payload would pass warnPercent of the limit).
import { sql, type Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { AppError } from '../../http/errors.js';

export interface DbSizeGuard { limitBytes: number; warnPercent: number; bytes?: () => Promise<number> }

export async function databaseBytes(db: Kysely<Database>): Promise<number> {
  return Number((await sql<{ n: string }>`select pg_database_size(current_database())::text as n`.execute(db)).rows[0]!.n);
}

export function payloadBytesOf(req: { headers: Record<string, unknown> }, rows: unknown): number {
  const h = req.headers['content-length'];
  const n = typeof h === 'string' && /^\d+$/.test(h) ? Number(h) : NaN;
  return Number.isFinite(n) ? n : Buffer.byteLength(JSON.stringify(rows));
}

/** Reads the size before a write; refuses (409 DB_SIZE_HIGH) when size + the payload would pass the ceiling. Returns the size read. */
export async function guardDbSize(db: Kysely<Database>, g: DbSizeGuard, payloadBytes: number): Promise<number> {
  const before = await (g.bytes ?? (() => databaseBytes(db)))();
  const ceiling = (g.limitBytes * g.warnPercent) / 100;
  if (before + payloadBytes > ceiling) {
    throw new AppError(409, 'DB_SIZE_HIGH', `The database is ${(before / 1024 ** 2).toFixed(0)} MB; this load (about ${(payloadBytes / 1024 ** 2).toFixed(1)} MB) would pass ${g.warnPercent}% of the ${(g.limitBytes / 1024 ** 2).toFixed(0)} MB limit`, {
      db_bytes_before: before, payload_bytes: payloadBytes, limit_bytes: g.limitBytes, warn_percent: g.warnPercent,
    });
  }
  return before;
}
