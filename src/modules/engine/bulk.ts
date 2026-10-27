// Bulk uploads of rows (the engine's sales and unsold names, and the CR-063 /data tables): one envelope, per-row reject reasons, one transaction under one
// advisory lock, and the route skeleton (DB_SIZE_HIGH guard, 8 MB body, audit summary, 201 with the byte counts). The data module (CR-063) reuses all of it.
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { isRealDate } from '../../core/dates.js';
import { advisoryXactLock } from '../../core/locks.js';
import type { Database } from '../../db/types.js';
import { normalizeDomain } from '../../domain-name.js';
import { AppError } from '../../http/errors.js';
import { databaseBytes, guardDbSize, payloadBytesOf, type DbSizeGuard } from './holdout.js';

export const ENGINE_MAX_ROWS = 20_000;
export const ENGINE_MAX_REJECTS = 200;
const ENGINE_EARLIEST_DATE = '2000-01-01';
/** Up to 20,000 rows of about 300 bytes each. */
const BULK_BODY_LIMIT = 8 * 1024 * 1024;

export interface Reject { row: number; domain: string | null; reason: string }
export type Parsed<T> = { ok: true; value: T } | { ok: false; domain: string | null; reason: string };

// ---- row validators ------------------------------------------------------------------------------------------------------------------------
export const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
export const rawDomain = (r: Record<string, unknown>): string | null => (typeof r.domain === 'string' ? r.domain.slice(0, 253) : null);

export function domainOf(r: Record<string, unknown>): { domain: string } | { reason: string } {
  if (typeof r.domain !== 'string') return { reason: 'DOMAIN_INVALID' };
  try {
    return { domain: normalizeDomain(r.domain) };
  } catch (e) {
    return { reason: e instanceof AppError ? e.code : 'DOMAIN_INVALID' };
  }
}

/** A real calendar date from the earliest allowed one to today (IDT). Since 5.41.0 there is no holdout date: a date is never rejected for being new. */
export function dateOf(v: unknown, today: string): { date: string } | { reason: string } {
  if (typeof v !== 'string' || !isRealDate(v) || v < ENGINE_EARLIEST_DATE) return { reason: 'DATE_INVALID' };
  if (v > today) return { reason: 'DATE_IN_FUTURE' };
  return { date: v };
}

export function centsOf(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,9}(\.\d{1,2})?$/.test(v.trim()) ? Number(v.trim()) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > 100_000_000) return null;
  const cents = Math.round(n * 100);
  return cents >= 1 ? cents : null;
}

export const textOf = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= max ? v.trim() : null);

// ---- the load skeleton ---------------------------------------------------------------------------------------------------------------------
/**
 * Checks each row on its own (a bad row is rejected with a reason, the rest are applied), all in one transaction under the `engine_upload` lock so two
 * uploads never race on the duplicate check. `apply` gets the valid rows and may add rejects of its own; the rejects come back sorted by row.
 */
export async function bulkLoad<T, R>(db: Kysely<Database>, rows: unknown[], o: {
  parse: (raw: unknown) => Parsed<T>;
  apply: (trx: Kysely<Database>, valid: { i: number; v: T }[], rejects: Reject[]) => Promise<R>;
}): Promise<{ result: R; rejects: Reject[] }> {
  if (rows.length < 1 || rows.length > ENGINE_MAX_ROWS) throw new AppError(422, 'VALIDATION_ERROR', `rows must hold 1 to ${ENGINE_MAX_ROWS} rows`);
  return db.transaction().execute(async (trx) => {
    await advisoryXactLock(trx, 'engine_upload');
    const rejects: Reject[] = [];
    const valid: { i: number; v: T }[] = [];
    rows.forEach((raw, i) => {
      const p = o.parse(raw);
      if (p.ok) valid.push({ i, v: p.value });
      else rejects.push({ row: i, domain: p.domain, reason: p.reason });
    });
    const result = await o.apply(trx, valid, rejects);
    rejects.sort((a, b) => a.row - b.row);
    return { result, rejects };
  });
}

/**
 * POST `path` (WRITE or data scope, Idempotency-Key, `{ rows, dry_run? }`): the size guard, the load, then 201 with the load's answer, the db byte
 * counts before and after, `extend`'s fields and the audit id. `doc` is the body schema shown in the OpenAPI document.
 */
export function registerBulkRoute<R extends object>(app: FastifyInstance, deps: { db: Kysely<Database>; now: () => number; dbSize: DbSizeGuard }, o: {
  path: string; doc: z.ZodType; dryRun: boolean;
  load: (rows: unknown[], ctx: { by: string; auditId: string | null; now: number; dryRun: boolean }) => Promise<R>;
  summary: (r: R, before: number, after: number) => string;
  extend?: () => Promise<object>;
  /** Rows allowed per call (default ENGINE_MAX_ROWS); CR-083 card evidence allows 500. */
  maxRows?: number;
}): void {
  const body = z.object({ rows: z.array(z.unknown()).min(1).max(o.maxRows ?? ENGINE_MAX_ROWS), ...(o.dryRun ? { dry_run: z.boolean().optional() } : {}) }).strict();
  app.post(o.path, { config: { openapiBody: o.doc }, bodyLimit: BULK_BODY_LIMIT }, async (req, reply) => {
    const b = body.parse(req.body ?? {}) as { rows: unknown[]; dry_run?: boolean };
    const before = await guardDbSize(deps.db, deps.dbSize, payloadBytesOf(req, b.rows));
    const r = await o.load(b.rows, { by: req.auth?.name ?? 'unknown', auditId: req.auditId ?? null, now: deps.now(), dryRun: b.dry_run === true });
    const after = await (deps.dbSize.bytes ?? (() => databaseBytes(deps.db)))();
    const more = o.extend ? await o.extend() : {};
    req.auditSummary = o.summary(r, before, after);
    return reply.code(201).send({ ...r, db_bytes_before: before, db_bytes_after: after, ...more, audit_id: req.auditId ?? null });
  });
}
