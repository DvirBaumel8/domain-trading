import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { jerusalemDate } from './dates.js';
import { DropJob } from './jobs/drop.js';
import { RegistrarCheckJob } from './jobs/registrar-check.js';
import { createAdapters } from './registrars/registry.js';
import { PriceScheduleJob } from './jobs/price-schedule.js';
import { BackupExporter } from './jobs/backup-export.js';
import { importBackup } from './jobs/backup-import.js';
import { buildApp } from './app.js';

const USAGE = `usage:
  npm run job -- tick | daily     (the same runner and steps as POST /jobs/run)
  npm run job -- price-schedule [--dry-run] [--today YYYY-MM-DD]
  npm run job -- drop [--dry-run] [--today YYYY-MM-DD]
  npm run job -- registrar-check [--dry-run]
  npm run job -- export-backup
  npm run job -- import-backup <dir containing backup/>`;

class UsageError extends Error {}

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { 'dry-run': { type: 'boolean' }, today: { type: 'string' } },
  });
  if (positionals[0] === 'tick' || positionals[0] === 'daily') {
    if (positionals.length !== 1) throw new UsageError(`wrong arguments for ${positionals[0]}`);
    if (values['dry-run'] || values.today !== undefined) throw new UsageError('--dry-run and --today do not apply to tick or daily');
    const config = loadConfig(process.env);
    const db = createDb(config.databaseUrl, { ssl: config.databaseSsl });
    const log = { warn: (m: string) => console.warn(`warning: ${m}`) };
    try {
      // The same app wiring as the server (never listening), so the runner has the server's adapters, locks and scrubbing.
      const app = await buildApp({ config, db, backupExport: new BackupExporter({ db, config, now: Date.now, log }) });
      try {
        const r = await app.jobRunner.run(positionals[0]);
        console.log(JSON.stringify(r, null, 2));
        return Object.values(r.steps).some((st) => !st.ok) ? 1 : 0;
      } finally {
        await app.close();
      }
    } finally {
      await db.destroy();
    }
  }
  const backupCmd = positionals[0] === 'export-backup' || positionals[0] === 'import-backup';
  if (backupCmd) {
    if (positionals[0] === 'export-backup' ? positionals.length !== 1 : positionals.length !== 2) throw new UsageError(`wrong arguments for ${positionals[0]}`);
    if (values['dry-run'] || values.today !== undefined) throw new UsageError('--dry-run and --today do not apply to backup commands');
    const config = loadConfig(process.env);
    const db = createDb(config.databaseUrl, { ssl: config.databaseSsl });
    try {
      if (positionals[0] === 'import-backup') {
        console.log(JSON.stringify({ imported: await importBackup(db, positionals[1]!) }, null, 2));
      } else {
        // A missing token or repo is a warning and a result of {skipped:true}, never a failure (BK-4).
        const log = { warn: (m: string) => console.warn(`warning: ${m}`) };
        console.log(JSON.stringify(await new BackupExporter({ db, config, now: Date.now, log }).runOnce(), null, 2));
      }
      return 0;
    } finally {
      await db.destroy();
    }
  }
  if ((positionals[0] !== 'price-schedule' && positionals[0] !== 'drop' && positionals[0] !== 'registrar-check') || positionals.length > 1) {
    throw new UsageError(`unknown command: ${positionals.join(' ') || '(none)'}`);
  }
  const today = values.today;
  if (today !== undefined) {
    const d = new Date(`${today}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(today) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== today) {
      throw new UsageError('--today must be a valid YYYY-MM-DD date');
    }
    if (!values['dry-run'] && today > jerusalemDate(new Date())) {
      throw new UsageError('--today in the future is only allowed with --dry-run');
    }
  }
  const config = loadConfig(process.env);
  const db = createDb(config.databaseUrl, { ssl: config.databaseSsl });
  try {
    if (positionals[0] === 'registrar-check') {
      if (today !== undefined) throw new UsageError('--today does not apply to registrar-check');
      const r = await new RegistrarCheckJob({ db, adapters: createAdapters(config), now: Date.now }).runOnce({ dryRun: values['dry-run'] ?? false });
      console.log(JSON.stringify(r, null, 2));
      return 0;
    }
    const job = positionals[0] === 'drop' ? new DropJob({ db, now: Date.now }) : new PriceScheduleJob({ db, now: Date.now });
    const result = await job.runOnce({ today, dryRun: values['dry-run'] ?? false });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } finally {
    await db.destroy();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const code = (err as { code?: unknown }).code;
    if (err instanceof UsageError || (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS_'))) {
      console.error(`${(err as Error).message}\n${USAGE}`);
      process.exitCode = 2;
      return;
    }
    console.error(`error: ${(err as Error).message}`);
    process.exitCode = 1;
  },
);
