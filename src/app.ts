import Fastify, { type FastifyInstance, type FastifyReply, type FastifyServerOptions } from 'fastify';
import type { Kysely } from 'kysely';
import { registerHealth } from './api/health.js';
import type { Config } from './config.js';
import type { Database } from './db/types.js';
import { isMutating } from './http/methods.js';
import { dbAuditWriter, newAuditId, registerAuditId, registerAuditWrite, type AuditWriter } from './http/audit.js';
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
    // Framework errors (bad URL encoding, param too long) bypass all hooks and our error handler,
    // so answer with the envelope and write the audit row for mutating requests right here.
    frameworkErrors: (err, req, reply) => {
      const r = reply as FastifyReply;
      const status = err.statusCode ?? 400;
      const send = (code: number, body: unknown) =>
        void r.code(code).type('application/json; charset=utf-8').send(JSON.stringify(body));
      if (!isMutating(req.method)) return send(status, errorBody('INVALID_REQUEST', err.message));
      auditWriter
        .write({
          id: newAuditId(),
          token_id: null,
          scope: null,
          method: req.method,
          path: req.url,
          idempotency_key: null,
          approval_text: null,
          approval_at: null,
          request: null,
          status_code: status,
          result_summary: 'INVALID_REQUEST',
          client_ip: req.ip,
        })
        .then(() => send(status, errorBody('INVALID_REQUEST', err.message)))
        .catch(() =>
          send(500, errorBody('AUDIT_WRITE_FAILED', 'The request was refused but could not be audited.')),
        );
    },
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
