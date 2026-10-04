import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Kysely } from 'kysely';
import { registerHealth } from './api/health.js';
import type { Config } from './config.js';
import type { Database } from './db/types.js';
import { dbAuditWriter, auditFrameworkError, registerAuditId, registerAuditWrite, type AuditWriter } from './http/audit.js';
import { registerAuth, registerScope } from './http/auth.js';
import { errorBody, registerErrorHandling } from './http/errors.js';

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
  audit?: AuditWriter;
  logger?: FastifyServerOptions['logger'];
  /** Test-only routes. Production never passes this. */
  registerExtraRoutes?: (app: FastifyInstance) => void;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const auditWriter = deps.audit ?? dbAuditWriter(deps.db);
  const app = Fastify({
    logger: deps.logger ?? { level: deps.config.logLevel, redact: ['req.headers.authorization'] },
    trustProxy: true,
    bodyLimit: 64 * 1024,
    // Framework errors bypass all hooks; see auditFrameworkError.
    frameworkErrors: (err, req, reply) => auditFrameworkError(auditWriter, err, req, reply),
  });

  const routeTable: { method: string; url: string }[] = [];
  app.decorate('routeTable', routeTable);
  app.addHook('onRoute', (r) => {
    for (const method of [r.method].flat()) routeTable.push({ method, url: r.url });
  });

  registerErrorHandling(app);
  registerAuditId(app); // onRequest (first)
  registerAuth(app, deps.db); // onRequest
  registerScope(app); // preHandler
  // preHandler: [Task 7] registerRateLimit →  registerScope  →  [Task 6] registerIdempotency (preHandler part)
  // [Task 6] registerIdempotency(app, deps.db) goes here (preHandler + onSend)
  registerAuditWrite(app, auditWriter); // onSend (last)

  registerHealth(app, deps.config, deps.db);
  deps.registerExtraRoutes?.(app);
  return app;
}
