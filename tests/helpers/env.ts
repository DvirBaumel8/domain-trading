import { tmpdir } from 'node:os';
import { join } from 'node:path';
/** The database the test run is configured with (globalSetup migrates it and uses it as the template for the worker databases). */
export const BASE_TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://dt:dt@localhost:5433/domain_trading_test';

/** `.../domain_trading_test` -> `.../domain_trading_w2_test` (still ends in `_test`, so the wipe guard accepts it). */
export function workerDatabaseUrl(base: string, worker: number): string {
  const u = new URL(base);
  u.pathname = u.pathname.replace(/_test$/, `_w${worker}_test`);
  return u.toString();
}

// Every vitest worker (VITEST_POOL_ID, 1-based) has its own database, so API test files run in parallel. The main process
// (globalSetup) and runs outside vitest have no pool id and use the base database.
const POOL_ID = Number(process.env.VITEST_POOL_ID ?? '');
export const TEST_DATABASE_URL = Number.isInteger(POOL_ID) && POOL_ID > 0 ? workerDatabaseUrl(BASE_TEST_DATABASE_URL, POOL_ID) : BASE_TEST_DATABASE_URL;

/** A complete, fake-valued env for tests. Never put real keys here. */
export function testEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: TEST_DATABASE_URL,
    APP_ENV: 'test',
    ENABLED_REGISTRARS: 'porkbun',
    PORKBUN_API_KEY: 'pk1_fake_test_key_000000000000',
    PORKBUN_SECRET_API_KEY: 'sk1_fake_test_secret_00000000',
    GODADDY_PAT: 'fake_godaddy_pat_0000000000',
    GITHUB_BACKUP_TOKEN: 'github_pat_fake_000000000000',
    PORKBUN_SANDBOX_API_KEY: 'pk1_sb_fake_test_key_0000000',
    PORKBUN_SANDBOX_SECRET_API_KEY: 'sk1_sb_fake_test_secret_00000',
    SNAPSHOT_DIR: join(tmpdir(), `dt-snapshots-test-${process.env.VITEST_POOL_ID ?? '0'}`),
    ...overrides,
  };
}
