import { readFileSync } from 'node:fs';
import { z } from 'zod';

const optional = (s: z.ZodString) => z.preprocess((v) => (v === '' ? undefined : v), s.optional());

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),
  PORKBUN_API_KEY: optional(z.string()),
  PORKBUN_SECRET_API_KEY: optional(z.string()),
  GOOGLE_WEB_RISK_API_KEY: optional(z.string().trim()),
  GODADDY_DOMAINS_PAT: optional(z.string().trim()),
  GODADDY_API_KEY: optional(z.string().trim()),
  GODADDY_API_SECRET: optional(z.string().trim()),
  AFTERNIC_API_KEY: optional(z.string().trim()),
  AFTERNIC_API_SECRET: optional(z.string().trim()),
  USPTO_API_KEY: optional(z.string().trim()),
  /** The commit this build was made from (Render sets it). */
  RENDER_GIT_COMMIT: optional(z.string()),
});

export interface Config {
  port: number;
  host: string;
  logLevel: string;
  tokens: ReadonlyMap<string, string>;
  /** null = no keys: /check answers without quotes. */
  porkbun: { apiKey: string; secretKey: string } | null;
  /** null = no key: the route says so. Half of a pair counts as no key, so keys can be added one at a time. */
  sources: {
    webRisk: string | null; godaddyPat: string | null; uspto: string | null;
    godaddyAuctions: { key: string; secret: string } | null; afternic: { key: string; secret: string } | null;
  };
  commit: string | null;
  version: string;
}

const ssoPair = (key?: string, secret?: string) => (key && secret ? { key, secret } : null);

const Access = z.record(z.string().regex(/^[a-z0-9_-]{1,40}$/), z.string().regex(/^[0-9a-f]{64}$/));

/** data/access.json: who may read, name -> sha256 of a long random token. Hashes only. Returns hash -> name. */
export function parseAccess(json: string): Map<string, string> {
  // the content is never shown: a token put here by mistake must not reach the log
  const bad = new Error('data/access.json must map names to sha256 hashes (64 lowercase hex characters), each used once');
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { throw bad; }
  const parsed = Access.safeParse(raw);
  if (!parsed.success) throw bad;
  const out = new Map(Object.entries(parsed.data).map(([name, hash]) => [hash, name]));
  if (out.size !== Object.keys(parsed.data).length) throw bad;
  return out;
}

const accessFile = (): string => readFileSync(new URL('../data/access.json', import.meta.url), 'utf8');

export function loadConfig(env: NodeJS.ProcessEnv, access: string = accessFile()): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid environment: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const e = parsed.data;
  if (Boolean(e.PORKBUN_API_KEY) !== Boolean(e.PORKBUN_SECRET_API_KEY)) throw new Error('Invalid environment: set both PORKBUN_API_KEY and PORKBUN_SECRET_API_KEY, or neither');
  return {
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    tokens: parseAccess(access),
    porkbun: e.PORKBUN_API_KEY && e.PORKBUN_SECRET_API_KEY ? { apiKey: e.PORKBUN_API_KEY, secretKey: e.PORKBUN_SECRET_API_KEY } : null,
    sources: {
      webRisk: e.GOOGLE_WEB_RISK_API_KEY || null, godaddyPat: e.GODADDY_DOMAINS_PAT || null, uspto: e.USPTO_API_KEY || null,
      godaddyAuctions: ssoPair(e.GODADDY_API_KEY, e.GODADDY_API_SECRET), afternic: ssoPair(e.AFTERNIC_API_KEY, e.AFTERNIC_API_SECRET),
    },
    commit: e.RENDER_GIT_COMMIT ?? null,
    version: (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version,
  };
}
