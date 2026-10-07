import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { Config } from '../config.js';
import { pingDb } from '../db/client.js';
import type { Database } from '../db/types.js';
import { adapterStatus } from '../registrars/registry.js';
import { jobsOverdue } from '../services/job-runs.js';

export function registerHealth(app: FastifyInstance, config: Config, db: Kysely<Database>, now: () => number = Date.now): void {
  // Liveness only: the one public route; no auth, no DB (so Render's health checks never wake Neon).
  app.get('/health/ping', async () => ({ status: 'ok' }));

  // Needs any valid bot token (global auth hook).
  app.get('/health', async (_req, reply) => {
    const dbOk = await pingDb(db);
    const jobs = dbOk ? ((await jobsOverdue(db, now())).overdue ? 'overdue' : 'ok') : 'unknown';
    return reply.code(dbOk ? 200 : 503).send({
      status: dbOk ? 'ok' : 'degraded',
      db: dbOk ? 'ok' : 'down',
      jobs,
      review: await reviewHealth(db, config),
      version: config.version,
      adapters: adapterStatus(config).map(({ name, enabled }) => ({ name, enabled })),
    });
  });
}

/** The outside reviewer's state: the latest feedback decides (ok / failed), `not_configured` without a key, `unknown` before the first review. */
async function reviewHealth(db: Kysely<Database>, config: Config): Promise<'ok' | 'not_configured' | 'failed' | 'unknown'> {
  if (!config.geminiApiKey) return 'not_configured';
  try {
    const last = await db.selectFrom('review_feedback').select('status').where('provider', '=', 'gemini').orderBy('id', 'desc').limit(1).executeTakeFirst();
    return !last ? 'unknown' : last.status === 'ok' ? 'ok' : 'failed';
  } catch {
    return 'unknown';
  }
}
