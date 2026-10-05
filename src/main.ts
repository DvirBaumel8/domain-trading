import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { scheduleDailyUtc } from './jobs/daily-timer.js';

const config = loadConfig(process.env);
const db = createDb(config.databaseUrl);
const app = await buildApp({ config, db });

const shutdown = async () => {
  await app.close();
  await db.destroy();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const runReconciler = () =>
  app.reconciler.runOnce().catch((e: unknown) => app.log.error({ errMessage: (e as Error).message }, 'reconciler failed'));
void runReconciler(); // at startup
setInterval(runReconciler, 10 * 60_000).unref(); // and every 10 minutes

const runNsVerifier = () =>
  app.nsVerifier.runOnce().catch((e: unknown) => app.log.error({ errMessage: (e as Error).message }, 'ns verifier failed'));
void runNsVerifier(); // at startup
setInterval(runNsVerifier, 24 * 3_600_000).unref(); // and every 24 hours

const runDaily = async () => {
  await app.priceJob.runOnce().catch((e: unknown) => app.log.error({ errMessage: (e as Error).message }, 'price job failed'));
  await app.dropJob.runOnce().catch((e: unknown) => app.log.error({ errMessage: (e as Error).message }, 'drop job failed'));
};
void runDaily(); // at startup (catches up after downtime; idempotent)
scheduleDailyUtc(runDaily, 0, 30); // and daily at 00:30 UTC: price job, then drop job

await app.listen({ port: config.port, host: config.host });
