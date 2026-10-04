import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { TEST_DATABASE_URL } from '../helpers/env.js';

/** Refuse to wipe anything that isn't clearly a test database. */
export function assertTestDatabaseUrl(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to reset database "${name}": test DB names must end with _test`);
  }
}

export default async function setup(): Promise<void> {
  assertTestDatabaseUrl(TEST_DATABASE_URL);
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await client.end();
  await runner({
    databaseUrl: TEST_DATABASE_URL,
    dir: 'migrations',
    direction: 'up',
    migrationsTable: 'pgmigrations',
    count: Infinity,
    log: () => {},
  });
}
