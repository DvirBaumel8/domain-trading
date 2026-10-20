import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import type { Config } from '../../../config.js';
import { toJerusalemIso } from '../../../core/dates.js';
import { scrubSecrets } from '../../../core/redact.js';
import { pingDb } from '../../../db/client.js';
import type { Database } from '../../../db/types.js';
import { adapterStatus } from '../../registrars/index.js';
import { currentReviewSettings } from '../../outreach/index.js';
import { DB_SIZE_WARN_PERCENT, NEON_FREE_STORAGE_BYTES, dailyScheduleState, jobsOverdue, lastJobRunAt, tickOverdue } from '../../reporting/index.js';

export function registerHealth(app: FastifyInstance, config: Config, db: Kysely<Database>, now: () => number = Date.now, kickQueue?: () => Promise<void>, storageLimitBytes: number = NEON_FREE_STORAGE_BYTES): void {
  // Liveness only: the one public route; no auth, no DB (so Render's health checks never wake Neon).
  // v3.7.0 (CR-034): also the version and the deployed commit (Render sets RENDER_GIT_COMMIT), so the deploy-live workflow can tell a deploy is live without a token.
  app.get('/health/ping', async () => ({ status: 'ok', version: config.version, commit: process.env.RENDER_GIT_COMMIT ?? null }));

  // Needs any valid bot token (global auth hook).
  app.get('/health', async (_req, reply) => {
    const dbOk = await pingDb(db);
    if (dbOk) await kickQueue?.(); // resumes unfinished job steps when this process has no worker running (cheap check)
    // v5.14.0: the independent reads run together, and the review settings are read once for both the state and the model
    const [jobs, jobsLast, review, size] = await Promise.all([
      dbOk ? jobsState(db, now()) : Promise.resolve('unknown'),
      dbOk ? jobsLastRun(db) : Promise.resolve({ daily: null, tick: null }),
      reviewState(db, config),
      dbOk ? dbSize(db, storageLimitBytes) : Promise.resolve(null),
    ]);
    return reply.code(dbOk ? 200 : 503).send({
      status: dbOk ? 'ok' : 'degraded',
      db: dbOk ? 'ok' : 'down',
      jobs,
      // v5.20.0 (BUG-047): when the daily and the tick job last ran (ISO, Asia/Jerusalem offset); null = never
      jobs_last: jobsLast,
      review: review.state,
      ...(review.state === 'failed' ? { review_reason: review.reason } : {}),
      review_model: review.model,
      // v5.17.0 (loop 2026-10-18, Gavriel): the database size against Neon's free 1 GB, so it can be reported with a READ token
      db_size: size,
      version: config.version,
      adapters: adapterStatus(config).map(({ name, enabled }) => ({ name, enabled })),
    });
  });
}

/** The database size against the free-plan limit (the same numbers as /report's DB_SIZE_HIGH); null when it can't be read. */
async function dbSize(db: Kysely<Database>, limitBytes: number): Promise<{ bytes: number; limit_bytes: number; percent: number; warn_percent: number } | null> {
  try {
    const bytes = Number((await sql<{ n: string }>`select pg_database_size(current_database())::text as n`.execute(db)).rows[0]!.n);
    return { bytes, limit_bytes: limitBytes, percent: Math.round(bytes * 1000 / limitBytes) / 10, warn_percent: DB_SIZE_WARN_PERCENT };
  } catch {
    return null;
  }
}

async function jobsState(db: Kysely<Database>, nowMs: number): Promise<'ok' | 'overdue'> {
  const [sched, overdue, tick] = await Promise.all([dailyScheduleState(db, nowMs), jobsOverdue(db, nowMs), tickOverdue(db, nowMs)]);
  return overdue.overdue || tick.overdue || sched.missed || sched.stuck ? 'overdue' : 'ok';
}

async function jobsLastRun(db: Kysely<Database>): Promise<{ daily: string | null; tick: string | null }> {
  const [daily, tick] = await Promise.all([lastJobRunAt(db, 'daily'), lastJobRunAt(db, 'tick')]);
  return { daily: daily ? toJerusalemIso(daily) : null, tick: tick ? toJerusalemIso(tick) : null };
}

/**
 * The outside reviewer's state: the latest feedback decides (ok / failed), `not_configured` without a key, `unknown` before the first review,
 * `disabled` when the setting is off. One settings read and one feedback read; `model` is the setting (null when the database cannot be read).
 */
async function reviewState(db: Kysely<Database>, config: Config): Promise<{ state: 'ok' | 'not_configured' | 'failed' | 'unknown' | 'disabled'; reason: string | null; model: string | null }> {
  let settings: Awaited<ReturnType<typeof currentReviewSettings>>;
  try {
    settings = await currentReviewSettings(db);
  } catch {
    return { state: 'unknown', reason: null, model: null };
  }
  if (!settings.enabled) return { state: 'disabled', reason: null, model: settings.model };
  if (!config.geminiApiKey) return { state: 'not_configured', reason: null, model: settings.model };
  try {
    const last = await db.selectFrom('review_feedback').select(['status', 'reason']).where('provider', '=', 'gemini').orderBy('id', 'desc').limit(1).executeTakeFirst();
    const state = !last ? 'unknown' : last.status === 'ok' ? 'ok' : 'failed';
    return { state, reason: state === 'failed' && last?.reason ? shapeReviewReason(last.reason, [config.geminiApiKey]) : null, model: settings.model };
  } catch {
    return { state: 'unknown', reason: null, model: settings.model };
  }
}

/** v3.2.0 (N-4): `CODE: text` from the latest gemini feedback, CODE = Google's error status (UNAVAILABLE) or `HTTP <n>`; at most 200 characters, cut at a word with an ellipsis; never the key. */
const REVIEW_REASON_MAX = 200;
function shapeReviewReason(raw: string, secrets: string[]): string {
  const clean = scrubSecrets(raw, secrets).replace(/\s+/g, ' ').trim();
  // Stored form is `HTTP 503 UNAVAILABLE: text` (or `HTTP 429: text`, or free text).
  const m = /^HTTP (\d{3}|none) ([A-Za-z_]+)(?::\s*(.*))?$/s.exec(clean);
  let out = clean;
  if (m) {
    const status = m[2] !== 'none' ? m[2]! : null;
    const code = status ?? (m[1] !== 'none' ? `HTTP ${m[1]}` : 'UNKNOWN');
    out = m[3] ? `${code}: ${m[3]}` : code;
  }
  if (out.length <= REVIEW_REASON_MAX) return out;
  const cut = out.slice(0, REVIEW_REASON_MAX - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > 20 ? cut.slice(0, sp) : cut).replace(/[\s,.;:]+$/, '')}\u2026`;
}
