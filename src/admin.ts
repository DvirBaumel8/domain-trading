import { parseArgs } from 'node:util';
import { createApiToken, listApiTokens, revokeApiToken } from './admin/tokens.js';
import { newPricingSettings, showPricingSettings } from './admin/pricing-settings.js';
import { dropAtFirstExpiry } from './admin/drop-date.js';
import { runDoctor } from './admin/doctor.js';
import { AppError } from './http/errors.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';

const USAGE = `usage:
  npm run admin -- token create --scope read|write --name <name>
  npm run admin -- token revoke --id <id>
  npm run admin -- token list
  npm run admin -- pricing-settings new [--from-current] --set key=value [--set ...] --approval-text "<words>" --approval-at <ISO> [--note <text>]
  npm run admin -- pricing-settings show [--version N]
  npm run admin -- drop-at-first-expiry --domain <d> --approval-text "<words>" --approval-at <ISO>
  npm run admin -- doctor`;

class UsageError extends Error {}

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      scope: { type: 'string' }, name: { type: 'string' }, id: { type: 'string' },
      set: { type: 'string', multiple: true }, 'from-current': { type: 'boolean' },
      'approval-text': { type: 'string' }, domain: { type: 'string' }, 'approval-at': { type: 'string' },
      note: { type: 'string' }, version: { type: 'string' },
    },
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
    if (cmd === 'drop-at-first-expiry') {
      if (!values.domain) throw new UsageError('--domain is required');
      if (!values['approval-text']?.trim()) throw new UsageError('--approval-text is required');
      if (!values['approval-at']) throw new UsageError('--approval-at is required');
      let r;
      try {
        r = await dropAtFirstExpiry(db, { domain: values.domain, approvalText: values['approval-text'], approvalAt: values['approval-at'], now: new Date() });
      } catch (e) {
        if (!(e instanceof AppError)) throw new UsageError((e as Error).message);
        console.error(`${e.code}: ${e.message}`);
        return 1;
      }
      console.log(`drop_date for ${r.domain}: ${r.from ?? '(none)'} -> ${r.dropDate}`);
      for (const e of r.schedule) console.log(`  ${e.event} ${e.due_on} ${e.status}${e.bin_cents === null ? '' : ` ${e.bin_cents / 100}/${e.floor_cents! / 100}/${e.walkaway_cents! / 100}`}`);
      return 0;
    }
    if (cmd === 'pricing-settings' && sub === 'new') {
      if (!values.set?.length) throw new UsageError('at least one --set is required');
      if (!values['approval-text']?.trim()) throw new UsageError('--approval-text is required');
      if (!values['approval-at']) throw new UsageError('--approval-at is required');
      const set: Record<string, string> = {};
      for (const kv of values.set ?? []) {
        const i = kv.indexOf('=');
        if (i <= 0) throw new UsageError(`--set expects key=value, got: ${kv}`);
        set[kv.slice(0, i)] = kv.slice(i + 1);
      }
      const { version } = await newPricingSettings(db, {
        set, approvalText: values['approval-text'], approvalAt: values['approval-at'], note: values.note, now: new Date(),
      });
      console.log(`Created pricing_settings version ${version}`);
      return 0;
    }
    if (cmd === 'pricing-settings' && sub === 'show') {
      let version: number | undefined;
      if (values.version !== undefined) {
        version = Number(values.version);
        if (!Number.isInteger(version) || version <= 0) throw new UsageError('--version must be a positive integer');
      }
      console.log(JSON.stringify(await showPricingSettings(db, version), null, 2));
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
