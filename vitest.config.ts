import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    env: { APP_ENV: 'test' },
    projects: [
      // tests/contract/contract-doc.test.ts is offline (no DB, no network): it checks docs/contract/ against the code, so it runs here.
      { extends: true, test: { name: 'unit', include: ['tests/unit/**/*.test.ts', 'tests/contract/contract-doc.test.ts'], setupFiles: ['tests/setup/network.ts'] } },
      {
        extends: true,
        test: {
          name: 'api',
          include: ['tests/api/**/*.test.ts'],
          globalSetup: ['tests/setup/global-db.ts'],
          setupFiles: ['tests/setup/network.ts', 'tests/setup/api.ts'],
          // Several API tests spawn the admin/job CLI as a subprocess (tsx start-up); CI runners need more than 5 s.
          testTimeout: 30_000,
        },
      },
      // Opt-in network projects: present only when VITEST_CONTRACT is set (the npm scripts set it), so plain
      // `npx vitest run` never runs them and never touches the network.
      ...(process.env.VITEST_CONTRACT
        ? [
            {
              extends: true as const,
              test: {
                name: 'porkbun-mock',
                env: { CONTRACT_MOCK_ONLY: '1' },
                include: ['tests/contract/porkbun-mock*.test.ts'],
                setupFiles: ['tests/contract/setup.ts'],
                testTimeout: 60_000,
              },
            },
            {
              extends: true as const,
              test: {
                name: 'porkbun-sandbox',
                include: ['tests/contract/porkbun-sandbox*.test.ts'],
                // Same DB bootstrap as the api project (B-26 runs /buy against the local test DB); no per-test reset here.
                globalSetup: ['tests/setup/global-db.ts'],
                // The guard wraps fetch for every sandbox test file (idempotent if a file also calls it).
                setupFiles: ['tests/contract/setup.ts', 'tests/contract/sandbox-guard-setup.ts'],
                testTimeout: 60_000,
              },
            },
          ]
        : []),
    ],
  },
});
