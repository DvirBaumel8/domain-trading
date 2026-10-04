import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';

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

await app.listen({ port: config.port, host: config.host });
