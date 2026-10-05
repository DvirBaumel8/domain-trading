import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { PriceScheduleJob } from './jobs/price-schedule.js';

const USAGE = `usage:
  npm run job -- price-schedule [--dry-run] [--today YYYY-MM-DD]`;

class UsageError extends Error {}

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { 'dry-run': { type: 'boolean' }, today: { type: 'string' } },
  });
  if (positionals[0] !== 'price-schedule' || positionals.length > 1) {
    throw new UsageError(`unknown command: ${positionals.join(' ') || '(none)'}`);
  }
  const today = values.today;
  if (today !== undefined) {
    const d = new Date(`${today}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(today) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== today) {
      throw new UsageError('--today must be a valid YYYY-MM-DD date');
    }
  }
  const config = loadConfig(process.env);
  const db = createDb(config.databaseUrl);
  try {
    const job = new PriceScheduleJob({ db, now: Date.now });
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
