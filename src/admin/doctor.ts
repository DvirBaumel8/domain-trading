import { sql, type Kysely } from 'kysely';
import type { Config } from '../config.js';
import { pingDb } from '../db/client.js';
import type { Database } from '../db/types.js';
import { adapterStatus } from '../registrars/registry.js';

export async function runDoctor(config: Config, db: Kysely<Database>): Promise<string[]> {
  const lines = [`version: ${config.version}`, `env: ${config.appEnv}`];
  const dbOk = await pingDb(db);
  lines.push(`db: ${dbOk ? 'ok' : 'down'}`);
  if (dbOk) {
    const r = await sql<{ n: number }>`select count(*)::int as n from pgmigrations`.execute(db).catch(() => null);
    lines.push(r ? `migrations: ${r.rows[0]?.n ?? 0} applied` : 'migrations: table missing (run npm run migrate up)');
  }
  for (const a of adapterStatus(config)) {
    lines.push(`${a.name}: ${a.enabled ? 'enabled' : `disabled (${a.reason})`}`);
  }
  return lines;
}
