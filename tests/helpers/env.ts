export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://dt:dt@localhost:5433/domain_trading_test';

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
    ...overrides,
  };
}
