import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['tests/setup/network.ts'],
    fileParallelism: false,
    env: { APP_ENV: 'test' },
    projects: [
      { extends: true, test: { name: 'unit', include: ['tests/unit/**/*.test.ts'] } },
      {
        extends: true,
        test: {
          name: 'api',
          include: ['tests/api/**/*.test.ts'],
          globalSetup: ['tests/setup/global-db.ts'],
          setupFiles: ['tests/setup/api.ts'],
        },
      },
    ],
  },
});
