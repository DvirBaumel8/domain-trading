import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { Config } from '../../../config.js';
import { scrubSecrets } from '../../../core/redact.js';
import { pingDb } from '../../../db/client.js';
import type { Database } from '../../../db/types.js';
import { adapterStatus } from '../../registrars/index.js';
import { currentReviewSettings, postingHealth, type PostingDeps } from '../../outreach/index.js';
import { dailyScheduleState, jobsOverdue } from '../../reporting/index.js';

export function registerHealth(app: FastifyInstance, config: Config, db: Kysely<Database>, now: () => number = Date.now, posting?: PostingDeps, kickQueue?: () => Promise<void>): void {
  // Liveness only: the one public route; no auth, no DB (so Render's health checks never wake Neon).
  app.get('/health/ping', async () => ({ status: 'ok' }));

  // Needs any valid bot token (global auth hook).
  app.get('/health', async (_req, reply) => {
    const dbOk = await pingDb(db);
    if (dbOk) await kickQueue?.(); // resumes unfinished job steps when this process has no worker running (cheap check)
    let jobs = 'unknown';
    if (dbOk) {
      const sched = await dailyScheduleState(db, now());
      jobs = (await jobsOverdue(db, now())).overdue || sched.missed || sched.stuck ? 'overdue' : 'ok';
    }
    const review = await reviewHealth(db, config);
    return reply.code(dbOk ? 200 : 503).send({
      status: dbOk ? 'ok' : 'degraded',
      db: dbOk ? 'ok' : 'down',
      jobs,
      review,
      ...(review === 'failed' ? { review_reason: await reviewReason(db, config) } : {}),
      review_model: await reviewModel(db),
      ...(await postingHealth({ db, buffer: posting?.buffer ?? null })),
      version: config.version,
      adapters: adapterStatus(config).map(({ name, enabled }) => ({ name, enabled })),
    });
  });
}

/** The outside reviewer's state: the latest feedback decides (ok / failed), `not_configured` without a key, `unknown` before the first review. */
async function reviewHealth(db: Kysely<Database>, config: Config): Promise<'ok' | 'not_configured' | 'failed' | 'unknown' | 'disabled'> {
  try {
    if (!(await currentReviewSettings(db)).enabled) return 'disabled';
  } catch {
    return 'unknown';
  }
  if (!config.geminiApiKey) return 'not_configured';
  try {
    const last = await db.selectFrom('review_feedback').select('status').where('provider', '=', 'gemini').orderBy('id', 'desc').limit(1).executeTakeFirst();
    return !last ? 'unknown' : last.status === 'ok' ? 'ok' : 'failed';
  } catch {
    return 'unknown';
  }
}

/** The model the review uses now (the setting; null when the database cannot be read). */
async function reviewModel(db: Kysely<Database>): Promise<string | null> {
  try {
    return (await currentReviewSettings(db)).model;
  } catch {
    return null;
  }
}

/** Google's short status and reason from the latest gemini feedback (e.g. `HTTP 503 UNAVAILABLE: ...`), at most 120 characters. The reason was scrubbed of the key when it was stored. */
async function reviewReason(db: Kysely<Database>, config: Config): Promise<string | null> {
  try {
    const last = await db.selectFrom('review_feedback').select('reason').where('provider', '=', 'gemini').orderBy('id', 'desc').limit(1).executeTakeFirst();
    return last?.reason ? scrubSecrets(last.reason, config.geminiApiKey ? [config.geminiApiKey] : []).slice(0, 120) : null;
  } catch {
    return null;
  }
}
