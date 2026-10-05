import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import type { Database } from './types.js';

// bigint ids fit comfortably in a JS number here; dates stay 'YYYY-MM-DD' strings (no timezone shifts).
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

const SSLMODE = /([?&])sslmode=([^&]*)(&|$)/i;

/**
 * With ssl on, pg lets a sslmode in the URL override the ssl config, so we validate it and strip it:
 * absent / require / verify-full are accepted (all mean verified TLS here); anything else is refused.
 */
export function poolConfig(url: string, opts: { ssl?: boolean } = {}): pg.PoolConfig {
  if (!opts.ssl) return { connectionString: url, max: 10 };
  const m = SSLMODE.exec(url);
  if (m && !['require', 'verify-full'].includes(m[2]!.toLowerCase())) {
    throw new Error(`DATABASE_SSL=true requires sslmode=verify-full (or require, or none) in DATABASE_URL; got sslmode=${m[2]}`);
  }
  const clean = url.replace(SSLMODE, (_x, pre: string, _v: string, post: string) => (post === '&' ? pre : '')).replace(/[?&]$/, '');
  return { connectionString: clean, max: 10, ssl: { rejectUnauthorized: true } };
}

export function createDb(url: string, opts: { ssl?: boolean } = {}): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool(poolConfig(url, opts)) }),
  });
}

export async function pingDb(db: Kysely<Database>, timeoutMs = 2000): Promise<boolean> {
  const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs).unref());
  const ping = sql`select 1`.execute(db).then(
    () => true,
    () => false,
  );
  return Promise.race([ping, timeout]);
}
