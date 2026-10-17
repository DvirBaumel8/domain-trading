// Number of parallel vitest workers, and so of per-worker test databases (tests/setup/global-db.ts). Override with DT_TEST_WORKERS.
export const TEST_WORKERS = Math.max(1, Number(process.env.DT_TEST_WORKERS ?? '4') || 4);
