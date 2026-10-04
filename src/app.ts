import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Kysely } from 'kysely';
import { registerHealth } from './api/health.js';
import type { Config } from './config.js';
import type { Database } from './db/types.js';
import { registerAuth, registerScope } from './http/auth.js';
import { registerErrorHandling } from './http/errors.js';

declare module 'fastify' {
  interface FastifyInstance {
    routeTable: { method: string; url: string }[];
  }
}

export interface AppDeps {
  config: Config;
  db: Kysely<Database>;
  /** Clock in ms, for the rate limiter. */
  now?: () => number;
  audit?: unknown; // narrowed to AuditWriter in Task 5
  logger?: FastifyServerOptions['logger'];
  /** Test-only routes. Production never passes this. */
  registerExtraRoutes?: (app: FastifyInstance) => void;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ?? { level: deps.config.logLevel, redact: ['req.headers.authorization'] },
    trustProxy: true,
    bodyLimit: 64 * 1024,
  });

  const routeTable: { method: string; url: string }[] = [];
  app.decorate('routeTable', routeTable);
  app.addHook('onRoute', (r) => {
    for (const method of [r.method].flat()) routeTable.push({ method, url: r.url });
  });

  registerErrorHandling(app);
  registerAuth(app, deps.db); // onRequest
  registerScope(app); // preHandler
  // onRequest:  [Task 5] registerAuditId  →  [Task 4] registerAuth
  // preHandler: [Task 7] registerRateLimit →  [Task 4] registerScope  →  [Task 6] registerIdempotency (preHandler part)
  // onSend:     [Task 6] idempotency store →  [Task 5] registerAuditWrite

  registerHealth(app, deps.config, deps.db);
  deps.registerExtraRoutes?.(app);
  return app;
}
