import { readFileSync } from 'node:fs';
import { z } from 'zod';

const optional = (s: z.ZodString) => z.preprocess((v) => (v === '' ? undefined : v), s.optional());

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),
  /** `name:sha256` pairs, comma separated. Hashes only: the server never holds a token. Empty = every request is 401. */
  API_TOKENS: z.string().default(''),
  PORKBUN_API_KEY: optional(z.string()),
  PORKBUN_SECRET_API_KEY: optional(z.string()),
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
  commit: string | null;
  version: string;
}

function parseTokens(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of text.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^([a-z0-9_-]{1,40}):([0-9a-f]{64})$/.exec(pair);
    // the value is never shown: a token pasted here by mistake must not reach the log
    if (!m || out.has(m[2]!) || [...out.values()].includes(m[1]!)) throw new Error('Invalid environment: API_TOKENS must be unique name:sha256 pairs (64 lowercase hex characters), comma separated');
    out.set(m[2]!, m[1]!);
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid environment: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const e = parsed.data;
  if (Boolean(e.PORKBUN_API_KEY) !== Boolean(e.PORKBUN_SECRET_API_KEY)) throw new Error('Invalid environment: set both PORKBUN_API_KEY and PORKBUN_SECRET_API_KEY, or neither');
  return {
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    tokens: parseTokens(e.API_TOKENS),
    porkbun: e.PORKBUN_API_KEY && e.PORKBUN_SECRET_API_KEY ? { apiKey: e.PORKBUN_API_KEY, secretKey: e.PORKBUN_SECRET_API_KEY } : null,
    commit: e.RENDER_GIT_COMMIT ?? null,
    version: (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version,
  };
}
