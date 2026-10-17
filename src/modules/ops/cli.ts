// Shared by the two command-line entries (`npm run admin`, `npm run job`): the config + database lifetime and the exit-code handling.
import type { Kysely } from 'kysely';
import { loadConfig, type Config } from '../../config.js';
import { createDb } from '../../db/client.js';
import type { Database } from '../../db/types.js';

export class UsageError extends Error {}

/** Loads the config from the environment, opens the database, runs `fn` and always closes the pool. */
export async function withDb<T>(fn: (c: { config: Config; db: Kysely<Database> }) => Promise<T>): Promise<T> {
  const config = loadConfig(process.env);
  const db = createDb(config.databaseUrl, { ssl: config.databaseSsl });
  try {
    return await fn({ config, db });
  } finally {
    await db.destroy();
  }
}

/** Sets the exit code from a command's result (no process.exit(): stdout flushes when piped); a usage error prints the usage and exits 2. */
export function exitWith(run: Promise<number>, usage: string): void {
  run.then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      const code = (err as { code?: unknown }).code;
      if (err instanceof UsageError || (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS_'))) {
        console.error(`${(err as Error).message}\n${usage}`);
        process.exitCode = 2;
        return;
      }
      console.error(`error: ${(err as Error).message}`);
      process.exitCode = 1;
    },
  );
}
