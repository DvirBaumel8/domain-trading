import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { BackupExporter } from './modules/ops/index.js';

const config = loadConfig(process.env);
// The pool's logger is attached after buildApp too (v3.9.0: an idle-connection drop is logged, not fatal).
const poolLog = { warn: (o: object, m: string) => console.warn(m, o) };
const db = createDb(config.databaseUrl, { ssl: config.databaseSsl, log: { warn: (o, m) => poolLog.warn(o, m) } });
// The exporter's logger is attached after buildApp (the app logger does not exist before it).
const backupLog = { warn: (m: string) => console.warn(m) };
const backupExport = new BackupExporter({ db, config, now: Date.now, log: backupLog });
const app = await buildApp({ config, db, backupExport });
backupLog.warn = (m: string) => app.log.warn(m);
poolLog.warn = (o: object, m: string) => app.log.warn(o, m);

const shutdown = async () => {
  await app.close();
  await db.destroy();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: config.port, host: config.host });
// Resume the runs a restart interrupted (steps left running or queued in job_steps).
await app.jobQueue.kickIfNeeded();
