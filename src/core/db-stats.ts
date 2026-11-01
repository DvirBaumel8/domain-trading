import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * v5.40.0 (G-125): a per-scope DB query counter. A scope is one API request or one job step. Every query Kysely executes inside it adds to
 * the count, the time and a per-shape counter. A shape is the SQL text only (Kysely already writes $1 placeholders, whitespace collapsed,
 * 200 characters at most). Query PARAMETERS are never read, so no domain, approval text or token hash can reach a log or a step record.
 * A query outside any scope is ignored. The cost of one query is a Map increment.
 */
export interface DbScope {
  label: string;
  queries: number;
  ms: number;
  errors: number;
  shapes: Map<string, number>;
}

export interface DbStats {
  queries: number;
  ms: number;
  errors: number;
  top: Array<{ sql: string; n: number }>;
}

/** Distinct shapes kept per scope; the rest still count in `queries`, only their shape is not tracked. */
const MAX_SHAPES = 500;
const SHAPE_CHARS = 200;

const als = new AsyncLocalStorage<DbScope>();

export function newDbScope(label: string): DbScope {
  return { label, queries: 0, ms: 0, errors: 0, shapes: new Map() };
}

/** Runs `fn` (and everything it awaits) inside `scope`. */
export function runInDbScope<T>(scope: DbScope, fn: () => T): T {
  return als.run(scope, fn);
}

/** Runs `fn` in a fresh scope and returns its value with the scope's stats. */
export async function withDbScope<T>(label: string, fn: () => Promise<T> | T): Promise<{ value: T; stats: DbStats }> {
  const scope = newDbScope(label);
  const value = await als.run(scope, fn);
  return { value, stats: dbStats(scope) };
}

export function currentDbScope(): DbScope | undefined {
  return als.getStore();
}

/** Called by the Kysely `log` hook for each executed query. `sqlText` is the compiled SQL (placeholders, never values). */
export function recordQuery(sqlText: string, durationMs: number, failed: boolean): void {
  const scope = als.getStore();
  if (!scope) return;
  scope.queries += 1;
  scope.ms += durationMs;
  if (failed) scope.errors += 1;
  const shape = sqlText.replace(/\s+/g, ' ').trim().slice(0, SHAPE_CHARS);
  const seen = scope.shapes.get(shape);
  if (seen !== undefined) scope.shapes.set(shape, seen + 1);
  else if (scope.shapes.size < MAX_SHAPES) scope.shapes.set(shape, 1);
}

export function dbStats(scope: DbScope, topN = 3): DbStats {
  const top = [...scope.shapes].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([sql, n]) => ({ sql, n }));
  return { queries: scope.queries, ms: Math.round(scope.ms), errors: scope.errors, top };
}

/** A step's `db` record: count, DB ms, errors (only when any), and from 50 queries its three most repeated shapes. */
export function stepDb(scope: DbScope, bytesIn?: number): { queries: number; ms: number; bytes_in?: number; errors?: number; top?: Array<{ sql: string; n: number }> } {
  const s = dbStats(scope);
  return { queries: s.queries, ms: s.ms, ...(bytesIn !== undefined ? { bytes_in: bytesIn } : {}), ...(s.errors ? { errors: s.errors } : {}), ...(s.queries >= 50 ? { top: s.top } : {}) };
}

/**
 * v6.1.0: bytes the database sent to this process (Neon counts them as data transfer out; the free plan allows 5 GB a month). Read from each pool client's
 * socket (`bytesRead`, TLS framing included), so it is a close upper bound. Process-wide: `dbBytesIn()` is the total since the process started; a job step
 * records the change across its run (other requests running at the same time add a little).
 */
interface Meterable { bytesRead: number }
const liveSockets = new Set<Meterable>();
let closedBytes = 0;
const startedAt = new Date();

export function meterDbSocket(sock: Meterable | undefined): void { if (sock) liveSockets.add(sock); }
export function unmeterDbSocket(sock: Meterable | undefined): void { if (sock && liveSockets.delete(sock)) closedBytes += sock.bytesRead; }
export function dbBytesIn(): number { let n = closedBytes; for (const s of liveSockets) n += s.bytesRead; return n; }
export const dbMeterSince = (): Date => startedAt;
