import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import type { Database } from './types.js';

// bigint ids fit comfortably in a JS number here; dates stay 'YYYY-MM-DD' strings (no timezone shifts).
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

/** v3.9.0: a connect that hangs fails after 10 s; an idle client is closed after 30 s (before Neon drops it). */
export const POOL_CONNECTION_TIMEOUT_MS = 10_000;
export const POOL_IDLE_TIMEOUT_MS = 30_000;
const POOL_LIMITS = { max: 10, connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS, idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS };

const SSLMODE = /([?&])sslmode=([^&]*)(&|$)/i;

/**
 * With ssl on, pg lets a sslmode in the URL override the ssl config, so we validate it and strip it:
 * absent / require / verify-full are accepted (all mean verified TLS here); anything else is refused.
 */
export function poolConfig(url: string, opts: { ssl?: boolean } = {}): pg.PoolConfig {
  if (!opts.ssl) return { connectionString: url, ...POOL_LIMITS };
  const m = SSLMODE.exec(url);
  if (m && !['require', 'verify-full'].includes(m[2]!.toLowerCase())) {
    throw new Error(`DATABASE_SSL=true requires sslmode=verify-full (or require, or none) in DATABASE_URL; got sslmode=${m[2]}`);
  }
  const clean = url.replace(SSLMODE, (_x, pre: string, _v: string, post: string) => (post === '&' ? pre : '')).replace(/[?&]$/, '');
  return { connectionString: clean, ...POOL_LIMITS, ssl: { rejectUnauthorized: true } };
}

/** v3.9.0: pg emits 'error' when an idle client's connection drops (Neon does this); without a listener that is an uncaught exception and the process exits. */
export function attachPoolErrorHandler(pool: pg.Pool, log?: { warn(o: object, m: string): void }): void {
  pool.on('error', (e) => {
    const o = { errMessage: e.message };
    if (log) log.warn(o, 'db pool: idle client error (connection dropped); the pool replaces it');
    else console.warn('db pool: idle client error (connection dropped); the pool replaces it', o);
  });
}

export function createDb(url: string, opts: { ssl?: boolean; log?: { warn(o: object, m: string): void } } = {}): Kysely<Database> {
  const pool = new pg.Pool(poolConfig(url, opts));
  attachPoolErrorHandler(pool, opts.log);
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

export async function pingDb(db: Kysely<Database>, timeoutMs = 2000): Promise<boolean> {
  const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs).unref());
  const ping = sql`select 1`.execute(db).then(
    () => true,
    () => false,
  );
  return Promise.race([ping, timeout]);
}
