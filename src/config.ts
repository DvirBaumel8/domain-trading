import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { poolConfig } from './db/client.js';
import { REGISTRAR_ENV } from './modules/registrars/index.js';

/** The code repo. The backup token must never be able to touch it. */
const CODE_REPO = 'DvirBaumel8/domain-trading';

/** Where Buffer fetches post images from (GET /media/<token>). */
export const DEFAULT_PUBLIC_BASE_URL = 'https://domain-trading-api.onrender.com';

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
  JOB_TRIGGER_TOKEN: z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^\S{32,}$/, 'JOB_TRIGGER_TOKEN must be at least 32 non-space characters (openssl rand -hex 32)').optional()),
  GOOGLE_WEB_RISK_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
  GEMINI_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
  BUFFER_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
  BUFFER_CHANNEL_ID: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).max(100).optional()),
  PUBLIC_BASE_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().refine((v) => /^https?:\/\//.test(v), 'PUBLIC_BASE_URL must be http(s)').default(DEFAULT_PUBLIC_BASE_URL)),
  DATABASE_SSL: z.enum(['true', 'false']).default('false'),
  GITHUB_BACKUP_REPO: z.preprocess((v) => (v === '' ? undefined : v), z.string()
    .regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'GITHUB_BACKUP_REPO must be owner/name')
    .refine((v) => !v.split('/').some((x) => x === '.' || x === '..'), 'GITHUB_BACKUP_REPO must not contain . or .. segments')
    .refine((v) => v.toLowerCase() !== CODE_REPO.toLowerCase(), `GITHUB_BACKUP_REPO must be a separate private data repo, never the code repo ${CODE_REPO} (founder rule 11)`)
    .optional()),
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
  /** Bearer token for POST /jobs/run; undefined → the route answers 503 JOBS_DISABLED. */
  jobTriggerToken: string | undefined;
  databaseSsl: boolean;
  /** Gemini API key for the one outside review (header `x-goog-api-key`). undefined → the review step is skipped (NO_KEY). */
  geminiApiKey: string | undefined;
  /** Google Web Risk Lookup API key (header `x-goog-api-key`, never in a URL). undefined → the web_risk check stays MANUAL_REQUIRED. */
  webRiskApiKey: string | undefined;
  /** Buffer API key for X posting (founder rule 10: the company's own account only). undefined -> POST /posts answers 503 POSTING_NOT_CONFIGURED. */
  bufferApiKey: string | undefined;
  /** Optional Buffer channel id; else the single X channel of the account is used. */
  bufferChannelId: string | undefined;
  /** Public base URL of this service, without a trailing slash (image links for Buffer). */
  publicBaseUrl: string;
  /** Nightly data export target. token/repo undefined → the export is skipped with a warning (BK-4). */
  backup: { token: string | undefined; repo: string | undefined };
  version: string;
  /** Raw env (strings only). Read secrets from here; never log it. */
  env: Readonly<Record<string, string>>;
  /** Every non-empty secret value, for leak tests (AU-8) and log redaction. */
  secretValues: string[];
}

const SECRET_ENV = ['GITHUB_BACKUP_TOKEN', 'JOB_TRIGGER_TOKEN', 'GOOGLE_WEB_RISK_API_KEY', 'GEMINI_API_KEY', 'BUFFER_API_KEY', 'PORKBUN_SANDBOX_API_KEY', 'PORKBUN_SANDBOX_SECRET_API_KEY', ...Object.values(REGISTRAR_ENV).flat()];

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
  // v3.9.0 (G-89): Render sets RENDER on every service; a service there that is not APP_ENV=production would skip the production checks (verified TLS, direct DB URL)
  if (env.RENDER && e.APP_ENV !== 'production') {
    throw new Error(`Invalid environment: RENDER is set but APP_ENV is ${e.APP_ENV}; a Render service must run with APP_ENV=production`);
  }
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

  if (e.APP_ENV === 'production' && new URL(e.DATABASE_URL).hostname.includes('-pooler.')) {
    throw new Error(
      'Invalid environment: DATABASE_URL points at a pooled (-pooler) connection. The per-domain lock is a session advisory lock, '
      + 'which breaks behind a transaction-mode pooler. Use the direct (non-pooler) connection string.',
    );
  }

  if (e.APP_ENV === 'production') {
    // Production verifies the server certificate and says so in the URL. node-pg-migrate reads the URL's sslmode itself
    // (poolConfig strips it only for the app's pg pool), so verify-full here also makes migrations verify the certificate.
    const mode = /[?&]sslmode=([^&]*)/i.exec(e.DATABASE_URL)?.[1]?.toLowerCase();
    if (e.DATABASE_SSL !== 'true' || mode !== 'verify-full') {
      throw new Error(
        'Invalid environment: production requires DATABASE_SSL=true and sslmode=verify-full in DATABASE_URL '
        + `(got DATABASE_SSL=${e.DATABASE_SSL}, sslmode=${mode ?? 'none'}); use the Neon direct string with ?sslmode=verify-full`,
      );
    }
  }
  if (e.DATABASE_SSL === 'true') poolConfig(e.DATABASE_URL, { ssl: true }); // throws on a conflicting sslmode

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
    jobTriggerToken: e.JOB_TRIGGER_TOKEN ? e.JOB_TRIGGER_TOKEN : undefined,
    databaseSsl: e.DATABASE_SSL === 'true',
    geminiApiKey: e.GEMINI_API_KEY ? e.GEMINI_API_KEY : undefined,
    bufferApiKey: e.BUFFER_API_KEY ? e.BUFFER_API_KEY : undefined,
    bufferChannelId: e.BUFFER_CHANNEL_ID ? e.BUFFER_CHANNEL_ID : undefined,
    publicBaseUrl: e.PUBLIC_BASE_URL.replace(/\/+$/, ''),
    webRiskApiKey: e.GOOGLE_WEB_RISK_API_KEY ? e.GOOGLE_WEB_RISK_API_KEY : undefined,
    backup: { token: strings.GITHUB_BACKUP_TOKEN || undefined, repo: e.GITHUB_BACKUP_REPO },
    version: readVersion(),
    env: Object.freeze(strings),
    secretValues,
  };
}
