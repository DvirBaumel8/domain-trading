import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { BASE_TEST_DATABASE_URL, workerDatabaseUrl } from '../helpers/env.js';
import { TEST_WORKERS } from './workers.js';

/** Refuse to wipe anything that isn't clearly a test database. */
export function assertTestDatabaseUrl(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to reset database "${name}": test DB names must end with _test`);
  }
}

const dbName = (url: string): string => new URL(url).pathname.replace(/^\//, '');
const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/**
 * Migrate the configured test database once, then copy it (CREATE DATABASE ... TEMPLATE) into one database per vitest worker, so API test
 * files can run in parallel with the same isolation as before. The copies are dropped when the run ends.
 */
export default async function setup(): Promise<() => Promise<void>> {
  assertTestDatabaseUrl(BASE_TEST_DATABASE_URL);
  const client = new pg.Client({ connectionString: BASE_TEST_DATABASE_URL });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await client.end();
  await runner({
    databaseUrl: BASE_TEST_DATABASE_URL,
    dir: 'migrations',
    direction: 'up',
    migrationsTable: 'pgmigrations',
    count: Infinity,
    log: () => {},
  });
  // Connect to the base database for the CREATE/DROP statements (any database works; the server owns them all).
  const admin = new pg.Client({ connectionString: BASE_TEST_DATABASE_URL });
  const urls = Array.from({ length: TEST_WORKERS }, (_, i) => workerDatabaseUrl(BASE_TEST_DATABASE_URL, i + 1));
  urls.forEach(assertTestDatabaseUrl);
  const names = urls.map(dbName);
  await admin.connect();
  try {
    for (const n of names) {
      await admin.query(`DROP DATABASE IF EXISTS ${quote(n)} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${quote(n)} TEMPLATE ${quote(dbName(BASE_TEST_DATABASE_URL))}`);
    }
  } finally {
    await admin.end();
  }
  return async () => {
    const c = new pg.Client({ connectionString: BASE_TEST_DATABASE_URL });
    await c.connect();
    try {
      for (const n of names) await c.query(`DROP DATABASE IF EXISTS ${quote(n)} WITH (FORCE)`);
    } finally {
      await c.end();
    }
  };
}
