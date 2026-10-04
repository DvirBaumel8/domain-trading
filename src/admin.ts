import { parseArgs } from 'node:util';
import { createApiToken, listApiTokens, revokeApiToken } from './admin/tokens.js';
import { runDoctor } from './admin/doctor.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';

const USAGE = `usage:
  npm run admin -- token create --scope read|write --name <name>
  npm run admin -- token revoke --id <id>
  npm run admin -- token list
  npm run admin -- doctor`;

class UsageError extends Error {}

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { scope: { type: 'string' }, name: { type: 'string' }, id: { type: 'string' } },
  });
  const [cmd, sub] = positionals;
  const config = loadConfig(process.env);
  const db = createDb(config.databaseUrl);
  try {
    if (cmd === 'doctor') {
      for (const line of await runDoctor(config, db)) console.log(line);
      return 0;
    }
    if (cmd === 'token' && sub === 'create') {
      const scope = values.scope;
      if (scope !== 'read' && scope !== 'write') throw new UsageError('--scope must be read or write');
      if (!values.name) throw new UsageError('--name is required');
      const { id, token } = await createApiToken(db, { name: values.name, scope });
      console.log(`Created token ${id} (${scope}, "${values.name}"). It is shown ONCE; store it now:`);
      console.log(token);
      return 0;
    }
    if (cmd === 'token' && sub === 'revoke') {
      const id = Number(values.id);
      if (!Number.isInteger(id) || id <= 0) throw new UsageError('--id must be a positive integer');
      const ok = await revokeApiToken(db, id);
      console.log(ok ? `Revoked token ${id}` : `No active token with id ${id}`);
      return ok ? 0 : 1;
    }
    if (cmd === 'token' && sub === 'list') {
      for (const t of await listApiTokens(db)) {
        console.log(
          [t.id, t.name, t.scope, `created ${t.created_at.toISOString()}`,
           t.revoked_at ? `REVOKED ${t.revoked_at.toISOString()}` : 'active',
           `last used ${t.last_used_at?.toISOString() ?? 'never'}`].join('  '),
        );
      }
      return 0;
    }
    throw new UsageError(`unknown command: ${positionals.join(' ') || '(none)'}`);
  } finally {
    await db.destroy();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code; // no process.exit(): lets stdout flush when piped
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
