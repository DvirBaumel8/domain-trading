import type { FastifyInstance } from 'fastify';
import { dbStats, newDbScope, runInDbScope, type DbScope } from '../core/db-stats.js';

/** A request that makes at least this many queries also logs its three most repeated query shapes. */
const TOP_FROM_QUERIES = 20;

declare module 'fastify' {
  interface FastifyRequest {
    dbScope?: DbScope;
  }
}

/**
 * v5.40.0 (G-125), part 1: onRequest, registered FIRST. The rest of the request (later hooks and the handler) runs inside the scope
 * (the callback form of the hook keeps the AsyncLocalStorage context for the whole chain).
 */
export function registerDbScope(app: FastifyInstance): void {
  app.decorateRequest('dbScope', undefined);
  app.addHook('onRequest', (req, _reply, done) => {
    const scope = newDbScope(`${req.method} ${req.routeOptions?.url ?? req.url.split('?')[0]}`);
    req.dbScope = scope;
    runInDbScope(scope, done);
  });
}

/**
 * Part 2: onSend, registered LAST (after the audit write, so its insert is counted). Fastify logs "request completed" with `reply.log`;
 * a child logger carries `db_queries`, `db_ms` and, from 20 queries, `db_top` onto that line. No response body changes.
 */
export function registerDbStatsLog(app: FastifyInstance): void {
  app.addHook('onSend', async (req, reply, payload) => {
    const scope = req.dbScope;
    if (scope && scope.queries > 0) {
      const s = dbStats(scope);
      reply.log = reply.log.child({ db_queries: s.queries, db_ms: s.ms, ...(s.queries >= TOP_FROM_QUERIES ? { db_top: s.top } : {}) });
    }
    return payload;
  });
}
