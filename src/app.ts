import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { registerBooks } from './books.js';
import type { Config } from './config.js';
import { rdapStatus, type RdapFn } from './core/rdap.js';
import { PUBLIC_PATH, registerAuth } from './http/auth.js';
import { registerErrorHandling } from './http/errors.js';
import { ALLOWED_REGISTRARS, CheckService, createAdapters, registerCheck, type RegistrarAdapter } from './registrars/index.js';
import type { State } from './state.js';

export interface AppDeps {
  config: Config;
  state: State;
  now?: () => number;
  logger?: FastifyServerOptions['logger'];
  adapters?: RegistrarAdapter[];
  rdap?: RdapFn;
}

/** The whole app. It keeps nothing: it reads data/state.json once and asks Porkbun and the .com registry on demand. */
export function buildApp(deps: AppDeps): FastifyInstance {
  const { config, state } = deps;
  const now = deps.now ?? Date.now;
  const app = Fastify({
    logger: deps.logger ?? { level: config.logLevel, redact: ['req.headers.authorization'] },
    trustProxy: (_addr: string, hop: number) => hop < 1, // exactly one proxy hop (Render); more would trust a forged X-Forwarded-For
    bodyLimit: 1024,
  });
  registerErrorHandling(app);
  registerAuth(app, config.tokens, now);

  const adapters = deps.adapters ?? createAdapters(config);
  app.get(PUBLIC_PATH, async () => ({ status: 'ok', version: config.version, commit: config.commit }));
  app.get('/health', async () => ({
    status: 'ok', version: config.version, commit: config.commit, registrars: adapters.map((a) => a.name), domains: state.domains.length, ledger_rows: state.ledger.length,
  }));
  registerCheck(app, new CheckService({ allowed: ALLOWED_REGISTRARS, adapters, rdap: deps.rdap ?? rdapStatus, now, log: app.log }));
  registerBooks(app, state);
  return app;
}
