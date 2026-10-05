import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { startJobScheduling } from './jobs/schedule.js';

const config = loadConfig(process.env);
const db = createDb(config.databaseUrl, { ssl: config.databaseSsl });
const app = await buildApp({ config, db });

const shutdown = async () => {
  await app.close();
  await db.destroy();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

startJobScheduling(app, config);

await app.listen({ port: config.port, host: config.host });
