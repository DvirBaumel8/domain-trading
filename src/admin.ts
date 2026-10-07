import { parseArgs } from 'node:util';
import { createApiToken, expireApiToken, listApiTokens, revokeApiToken } from './admin/tokens.js';
import { newPricingSettings, showPricingSettings } from './admin/pricing-settings.js';
import { DropDateInputError, dropAtFirstExpiry } from './admin/drop-date.js';
import { runDoctor } from './admin/doctor.js';
import { ImportInputError, importDomain, type ImportInput } from './admin/import-domain.js';
import { createAdapters } from './registrars/registry.js';
import { readFileSync } from 'node:fs';
import { AppError } from './http/errors.js';
import { ISO_WITH_OFFSET } from './services/offers.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';

const USAGE = `usage:
  npm run admin -- token create --scope read|write|intake --name <name>
  npm run admin -- token revoke --id <id>
  npm run admin -- token expire --id <id> --at <ISO 8601 time with an offset>
  npm run admin -- token list
  npm run admin -- pricing-settings new [--from-current] --set key=value [--set ...] --approval-text "<words>" --approval-at <ISO> [--note <text>]
  npm run admin -- pricing-settings show [--version N]
  npm run admin -- drop-at-first-expiry --domain <d> --approval-text "<words>" --approval-at <ISO>
  npm run admin -- import-domain --domain <d> --registrar porkbun|godaddy|other --buy-date YYYY-MM-DD --cost 13.73 --category <c> [--grade strong|weaker]
      [--cost-note "<text>"] [--order <id>|none] [--deal D-NNN] [--listing-mode bin|hybrid|offer --bin N [--floor N --walkaway N --pricing-exception "<reason>"] [--min-offer N] [--override --override-reason "<why>"]]
      [--comps-file comps.json | --legacy-no-comps "<reason>"] [--approval-text "<words>" --approval-at <ISO>] [--manual --expiry YYYY-MM-DD] [--renewal-price N] [--dry-run]
  npm run admin -- doctor`;

class UsageError extends Error {}

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      scope: { type: 'string' }, name: { type: 'string' }, id: { type: 'string' }, at: { type: 'string' },
      set: { type: 'string', multiple: true }, 'from-current': { type: 'boolean' },
      'approval-text': { type: 'string' }, domain: { type: 'string' }, 'approval-at': { type: 'string' },
      note: { type: 'string' }, version: { type: 'string' },
      registrar: { type: 'string' }, 'buy-date': { type: 'string' }, cost: { type: 'string' }, 'cost-note': { type: 'string' }, order: { type: 'string' },
      deal: { type: 'string' }, category: { type: 'string' }, grade: { type: 'string' }, 'listing-mode': { type: 'string' }, bin: { type: 'string' },
      floor: { type: 'string' }, walkaway: { type: 'string' }, 'min-offer': { type: 'string' }, 'pricing-exception': { type: 'string' },
      override: { type: 'boolean' }, 'override-reason': { type: 'string' }, 'comps-file': { type: 'string' }, 'legacy-no-comps': { type: 'string' },
      manual: { type: 'boolean' }, expiry: { type: 'string' }, 'renewal-price': { type: 'string' }, 'dry-run': { type: 'boolean' },
    },
  });
  const [cmd, sub] = positionals;
  const config = loadConfig(process.env);
  const db = createDb(config.databaseUrl, { ssl: config.databaseSsl });
  try {
    if (cmd === 'doctor') {
      for (const line of await runDoctor(config, db)) console.log(line);
      return 0;
    }
    if (cmd === 'token' && sub === 'create') {
      const scope = values.scope;
      if (scope !== 'read' && scope !== 'write' && scope !== 'intake') throw new UsageError('--scope must be read, write or intake');
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
    if (cmd === 'token' && sub === 'expire') {
      const id = Number(values.id);
      if (!Number.isInteger(id) || id <= 0) throw new UsageError('--id must be a positive integer');
      const at = values.at;
      if (!at || !ISO_WITH_OFFSET.test(at) || Number.isNaN(Date.parse(at))) throw new UsageError('--at must be an ISO 8601 time with an offset, e.g. 2026-12-31T23:59:00+02:00');
      const ok = await expireApiToken(db, id, new Date(at));
      console.log(ok ? `Token ${id} expires ${new Date(at).toISOString()}` : `No active token with id ${id}`);
      return ok ? 0 : 1;
    }
    if (cmd === 'token' && sub === 'list') {
      for (const t of await listApiTokens(db)) {
        console.log(
          [t.id, t.name, t.scope, `created ${t.created_at.toISOString()}`,
           t.revoked_at ? `REVOKED ${t.revoked_at.toISOString()}` : 'active',
           `last used ${t.last_used_at?.toISOString() ?? 'never'}`,
           t.expires_at ? `expires ${t.expires_at.toISOString()}` : 'no expiry'].join('  '),
        );
      }
      return 0;
    }
    if (cmd === 'import-domain') {
      for (const f of ['domain', 'registrar', 'buy-date', 'cost'] as const) if (!values[f]) throw new UsageError(`--${f} is required`);
      let evidence: ImportInput['evidence'];
      if (values['comps-file'] !== undefined) {
        let raw: unknown;
        try {
          raw = JSON.parse(readFileSync(values['comps-file'], 'utf8'));
        } catch {
          throw new UsageError('--comps-file must be a readable JSON file');
        }
        evidence = Array.isArray(raw) ? { comps: raw } : (raw as ImportInput['evidence']);
      }
      const input: ImportInput = {
        domain: values.domain!, registrar: values.registrar!, buyDate: values['buy-date']!, cost: values.cost!, costNote: values['cost-note'], order: values.order,
        deal: values.deal, category: values.category, grade: values.grade, listingMode: values['listing-mode'], bin: values.bin, floor: values.floor,
        walkaway: values.walkaway, minOffer: values['min-offer'], pricingException: values['pricing-exception'], override: values.override,
        overrideReason: values['override-reason'], evidence, legacyNoComps: values['legacy-no-comps'], approvalText: values['approval-text'],
        approvalAt: values['approval-at'], manual: values.manual, expiry: values.expiry, renewalPrice: values['renewal-price'], dryRun: values['dry-run'],
      };
      try {
        const r = await importDomain(db, input, { adapters: createAdapters(config), now: new Date() });
        console.log(JSON.stringify(r, null, 2));
        return 0;
      } catch (e) {
        if (e instanceof ImportInputError) throw new UsageError(e.message);
        if (!(e instanceof AppError)) throw e;
        console.error(`${e.code}: ${e.message}`);
        return 1;
      }
    }
    if (cmd === 'drop-at-first-expiry') {
      if (!values.domain) throw new UsageError('--domain is required');
      if (!values['approval-text']?.trim()) throw new UsageError('--approval-text is required');
      if (!values['approval-at']) throw new UsageError('--approval-at is required');
      let r;
      try {
        r = await dropAtFirstExpiry(db, { domain: values.domain, approvalText: values['approval-text'], approvalAt: values['approval-at'], now: new Date() });
      } catch (e) {
        if (e instanceof DropDateInputError) throw new UsageError(e.message);
        if (!(e instanceof AppError)) throw e;
        console.error(`${e.code}: ${e.message}`);
        return 1;
      }
      console.log(`drop_date for ${r.domain}: ${r.from ?? '(none)'} -> ${r.dropDate}`);
      for (const w of r.warnings) console.log(`warning: ${w}`);
      for (const e of r.schedule ?? []) console.log(`  ${e.event} ${e.due_on} ${e.status}${e.bin_cents === null ? '' : ` ${e.bin_cents / 100}/${e.floor_cents! / 100}/${e.walkaway_cents! / 100}`}`);
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
