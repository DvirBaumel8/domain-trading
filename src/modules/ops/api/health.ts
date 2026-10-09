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
  // v3.7.0 (CR-034): also the version and the deployed commit (Render sets RENDER_GIT_COMMIT), so the deploy-live workflow can tell a deploy is live without a token.
  app.get('/health/ping', async () => ({ status: 'ok', version: config.version, commit: process.env.RENDER_GIT_COMMIT ?? null }));

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

/** v3.2.0 (N-4): `CODE: text` from the latest gemini feedback, CODE = Google's error status (UNAVAILABLE) or `HTTP <n>`; at most 200 characters, cut at a word with an ellipsis; never the key. */
export const REVIEW_REASON_MAX = 200;
export function shapeReviewReason(raw: string, secrets: string[]): string {
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

async function reviewReason(db: Kysely<Database>, config: Config): Promise<string | null> {
  try {
    const last = await db.selectFrom('review_feedback').select('reason').where('provider', '=', 'gemini').orderBy('id', 'desc').limit(1).executeTakeFirst();
    return last?.reason ? shapeReviewReason(last.reason, config.geminiApiKey ? [config.geminiApiKey] : []) : null;
  } catch {
    return null;
  }
}
