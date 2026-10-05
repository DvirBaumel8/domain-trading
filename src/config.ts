import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { REGISTRAR_ENV } from './registrars/registry.js';

const EnvSchema = z.object({
  DATABASE_URL: z
    .string({ error: 'DATABASE_URL is required' })
    .refine((v) => /^postgres(ql)?:\/\//.test(v), 'DATABASE_URL must be a postgres:// URL'),
  APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),
  ENABLED_REGISTRARS: z.string().default(''),
  SEDO_TEMPLATE_PATH: z.string().default('templates/sedo_template.json'),
  DNS_NS_SERVER: z.string().default('192.5.6.30'),
});

export interface Config {
  databaseUrl: string;
  appEnv: 'development' | 'test' | 'production';
  port: number;
  host: string;
  logLevel: string;
  enabledRegistrars: string[];
  sedoTemplatePath: string;
  dnsNsServer: string;
  version: string;
  /** Raw env (strings only). Read secrets from here; never log it. */
  env: Readonly<Record<string, string>>;
  /** Every non-empty secret value, for leak tests (AU-8) and log redaction. */
  secretValues: string[];
}

const SECRET_ENV = ['GITHUB_BACKUP_TOKEN', 'PORKBUN_SANDBOX_API_KEY', 'PORKBUN_SANDBOX_SECRET_API_KEY', ...Object.values(REGISTRAR_ENV).flat()];

function readVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return pkg.version;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${msg}`);
  }
  const e = parsed.data;
  const pbUrl = env.PORKBUN_BASE_URL;
  if (pbUrl && e.APP_ENV !== 'test' && !pbUrl.startsWith('https://')) {
    throw new Error('Invalid environment: PORKBUN_BASE_URL must be https');
  }
  const gdUrl = env.GODADDY_BASE_URL;
  if (gdUrl && e.APP_ENV !== 'test' && !gdUrl.startsWith('https://')) {
    throw new Error('Invalid environment: GODADDY_BASE_URL must be https');
  }
  const strings: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') strings[k] = v;

  const enabledRegistrars = e.ENABLED_REGISTRARS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (enabledRegistrars.includes('cloudflare')) {
    throw new Error('Invalid environment: ENABLED_REGISTRARS: cloudflare is never supported (no third-party nameservers)');
  }
  const unknown = enabledRegistrars.filter((n) => !Object.hasOwn(REGISTRAR_ENV, n));
  if (unknown.length > 0) {
    throw new Error(`Invalid environment: ENABLED_REGISTRARS: unknown registrar(s) ${unknown.join(', ')}`);
  }

  const secretValues = SECRET_ENV.map((k) => strings[k] ?? '').filter((v) => v.length > 0);
  const dbPassword = decodeURIComponent(new URL(e.DATABASE_URL).password);
  if (dbPassword) secretValues.push(dbPassword);

  return {
    databaseUrl: e.DATABASE_URL,
    appEnv: e.APP_ENV,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    enabledRegistrars,
    sedoTemplatePath: e.SEDO_TEMPLATE_PATH,
    dnsNsServer: e.DNS_NS_SERVER,
    version: readVersion(),
    env: Object.freeze(strings),
    secretValues,
  };
}
