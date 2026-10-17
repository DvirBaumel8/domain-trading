import { parseArgs } from 'node:util';
import { exitWith, UsageError, withDb } from './cli.js';
import { idtDay, isRealDate } from '../../core/dates.js';
import { DropJob } from './jobs/drop.js';
import { RegistrarCheckJob } from './jobs/registrar-check.js';
import { createAdapters } from '../registrars/index.js';
import { PriceScheduleJob } from './jobs/price-schedule.js';
import { BackupExporter } from './jobs/backup-export.js';
import { importBackup } from './jobs/backup-import.js';
import { buildApp } from '../../app.js';
import { writeJobAudit } from '../../http/audit.js';

const USAGE = `usage:
  npm run job -- tick | daily     (the same runner and steps as POST /jobs/run)
  npm run job -- price-schedule [--dry-run] [--today YYYY-MM-DD]
  npm run job -- drop [--dry-run] [--today YYYY-MM-DD]
  npm run job -- registrar-check [--dry-run]
  npm run job -- export-backup
  npm run job -- import-backup <dir containing backup/>`;

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { 'dry-run': { type: 'boolean' }, today: { type: 'string' } },
  });
  const cmd = positionals[0];
  if (cmd === 'tick' || cmd === 'daily') {
    if (positionals.length !== 1) throw new UsageError(`wrong arguments for ${cmd}`);
    if (values['dry-run'] || values.today !== undefined) throw new UsageError('--dry-run and --today do not apply to tick or daily');
    return withDb(async ({ config, db }) => {
      const log = { warn: (m: string) => console.warn(`warning: ${m}`) };
      // The same app wiring as the server (never listening), so the runner has the server's adapters, locks and scrubbing.
      const app = await buildApp({ config, db, backupExport: new BackupExporter({ db, config, now: Date.now, log }) });
      try {
        const r = await app.jobRunner.run(cmd, { trigger: 'cli' });
        const failed = Object.entries(r.steps).filter(([, st]) => !st.ok).map(([k]) => k);
        // The run-level audit row POST /jobs/run gets from the middleware (a skipped overlap is recorded too).
        await writeJobAudit(db, {
          method: 'CLI', path: `job ${cmd}`,
          request: { job: cmd, steps: Object.fromEntries(Object.entries(r.steps).map(([k, st]) => [k, st.ok ? (st.skipped ? 'skipped' : 'ok') : 'failed'])) },
          status: failed.length ? 500 : 200,
          summary: r.skipped ? `${cmd}: skipped` : failed.length ? `${cmd}: failed ${failed.join(',')}` : `${cmd}: ok`,
        });
        console.log(JSON.stringify(r, null, 2));
        return failed.length ? 1 : 0;
      } finally {
        await app.close();
      }
    });
  }
  if (cmd === 'export-backup' || cmd === 'import-backup') {
    if (cmd === 'export-backup' ? positionals.length !== 1 : positionals.length !== 2) throw new UsageError(`wrong arguments for ${cmd}`);
    if (values['dry-run'] || values.today !== undefined) throw new UsageError('--dry-run and --today do not apply to backup commands');
    return withDb(async ({ config, db }) => {
      if (cmd === 'import-backup') {
        console.log(JSON.stringify({ imported: await importBackup(db, positionals[1]!) }, null, 2));
      } else {
        // A missing token or repo is a warning and a result of {skipped:true}, never a failure (BK-4).
        const log = { warn: (m: string) => console.warn(`warning: ${m}`) };
        console.log(JSON.stringify(await new BackupExporter({ db, config, now: Date.now, log }).runOnce(), null, 2));
      }
      return 0;
    });
  }
  if ((cmd !== 'price-schedule' && cmd !== 'drop' && cmd !== 'registrar-check') || positionals.length > 1) {
    throw new UsageError(`unknown command: ${positionals.join(' ') || '(none)'}`);
  }
  const today = values.today;
  if (today !== undefined) {
    if (!isRealDate(today)) {
      throw new UsageError('--today must be a valid YYYY-MM-DD date');
    }
    if (!values['dry-run'] && today > idtDay(new Date())) {
      throw new UsageError('--today in the future is only allowed with --dry-run');
    }
  }
  return withDb(async ({ config, db }) => {
    if (cmd === 'registrar-check') {
      if (today !== undefined) throw new UsageError('--today does not apply to registrar-check');
      const r = await new RegistrarCheckJob({ db, adapters: createAdapters(config), now: Date.now }).runOnce({ dryRun: values['dry-run'] ?? false });
      console.log(JSON.stringify(r, null, 2));
      return 0;
    }
    const job = cmd === 'drop' ? new DropJob({ db, now: Date.now }) : new PriceScheduleJob({ db, now: Date.now });
    const result = await job.runOnce({ today, dryRun: values['dry-run'] ?? false });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  });
}

exitWith(main(process.argv.slice(2)), USAGE);
