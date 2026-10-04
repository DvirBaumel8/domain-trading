import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import type { Database } from './types.js';

// bigint ids fit comfortably in a JS number here; dates stay 'YYYY-MM-DD' strings (no timezone shifts).
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export function createDb(url: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url, max: 10 }) }),
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
