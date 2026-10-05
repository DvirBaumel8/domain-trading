import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { BackupExporter } from './jobs/backup-export.js';
import { startJobScheduling } from './jobs/schedule.js';

const config = loadConfig(process.env);
const db = createDb(config.databaseUrl, { ssl: config.databaseSsl });
// The exporter's logger is attached after buildApp (the app logger does not exist before it).
const backupLog = { warn: (m: string) => console.warn(m) };
const backupExport = new BackupExporter({ db, config, now: Date.now, log: backupLog });
const app = await buildApp({ config, db, backupExport });
backupLog.warn = (m: string) => app.log.warn(m);

const shutdown = async () => {
  await app.close();
  await db.destroy();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

startJobScheduling(app, config);

await app.listen({ port: config.port, host: config.host });
