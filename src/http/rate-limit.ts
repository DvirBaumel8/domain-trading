import type { FastifyInstance, FastifyRequest } from 'fastify';
import { isJobRoute } from './auth.js';
import { AppError } from './errors.js';
import { isMutating } from './methods.js';
import { requestHash } from './idempotency.js';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';

/** POST /jobs/run by a WRITE token: calls per hour per token (the job token keeps the general 10 per minute). */
export const WRITE_JOB_RUNS_PER_HOUR = 4;

/** POST /reviews/run: calls per hour per WRITE token (the outside review costs money and counts toward the monthly cap). */
export const REVIEW_RUNS_PER_HOUR = 3;

/**
 * POST /reviews/run counts toward its hourly limit only when the call reaches Google, and the slot is taken right BEFORE the Google call
 * (never given back), so two concurrent calls cannot both slip under the limit. The preHandler below registers the taker for the request.
 */
const reviewSlotTakers = new WeakMap<object, () => void>();
const reachedGoogle = new WeakSet<object>();
export const markReviewReachedGoogle = (req: object): void => {
  if (reachedGoogle.has(req)) return;
  reachedGoogle.add(req);
  reviewSlotTakers.get(req)?.();
};

/** In-memory sliding window. Fine for one Render instance; revisit if we ever scale out. */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Calls left in the window and seconds until the oldest counted call stops counting (after a `take`). */
  state(key: string): { remaining: number; resetSeconds: number } {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => x > t - this.windowMs);
    return { remaining: Math.max(0, this.limit - recent.length), resetSeconds: recent.length === 0 ? 0 : Math.max(1, Math.ceil((recent[0]! + this.windowMs - t) / 1000)) };
  }

  /** Seconds-in-ms to wait if the key is at its limit, without counting a call. */
  peek(key: string): number {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => x > t - this.windowMs);
    return recent.length >= this.limit ? recent[0]! + this.windowMs - t : 0;
  }

  take(key: string): number {
    const t = this.now();
    if (this.hits.size > 5000) {
      for (const [k, v] of this.hits) if (v.every((x) => x <= t - this.windowMs)) this.hits.delete(k);
    }
    const recent = (this.hits.get(key) ?? []).filter((x) => x > t - this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return recent[0]! + this.windowMs - t;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return 0;
  }
}

/**
 * v3.2.0 (N-5): is this request the replay of an already completed request (same Idempotency-Key, same request)? It then only replays the stored answer
 * (see http/idempotency.ts) and does not use a rate-limit slot. A stored 202 on POST /buy is re-run by the handler, so it does count.
 */
async function isIdempotentReplay(db: Kysely<Database>, req: FastifyRequest): Promise<boolean> {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length === 0 || key.length > 255) return false;
  try {
    const row = await db.selectFrom('idempotency_keys').select(['request_hash', 'state', 'status_code']).where('key', '=', key).executeTakeFirst();
    if (!row || row.state !== 'completed' || row.status_code === null) return false;
    if (row.request_hash !== requestHash(req.method, req.url, req.body)) return false;
    return !(row.status_code === 202 && req.routeOptions?.url === '/buy');
  } catch {
    return false;
  }
}

export function registerRateLimit(app: FastifyInstance, now: () => number = Date.now, db?: Kysely<Database>): void {
  const reads = new SlidingWindowLimiter(60, 60_000, now);
  const writes = new SlidingWindowLimiter(10, 60_000, now);
  const jobStarts = new SlidingWindowLimiter(WRITE_JOB_RUNS_PER_HOUR, 3_600_000, now);
  const reviewRuns = new SlidingWindowLimiter(REVIEW_RUNS_PER_HOUR, 3_600_000, now);
  app.addHook('onSend', async (req, reply, payload) => {
    if (!req.auth || !reachedGoogle.has(req)) return payload;
    const st = reviewRuns.state(String(req.auth.tokenId));
    reply.header('ratelimit-remaining', String(st.remaining));
    reply.header('ratelimit-reset', String(st.resetSeconds));
    return payload;
  });
  app.addHook('preHandler', async (req, reply) => {
    const key = req.auth ? String(req.auth.tokenId) : req.jobAuth && isJobRoute(req) ? 'job' : null;
    // v2.6.0 (N-4): POST /jobs/run by a token that is not WRITE is refused 401 by the scope hook; it never counts against (or reports) the WRITE limiter.
    if (req.auth && !req.jobAuth && isJobRoute(req) && req.auth.scope !== 'write') return;
    if (key === null) return; // public routes (/health) are not limited
    // CR-007 T-2: a WRITE token starting a job has its own, tighter limit (instead of the general write limit).
    const reviewRun = req.auth && req.routeOptions?.url === '/reviews/run' && req.method === 'POST' && req.auth.scope === 'write';
    const limiter = reviewRun ? reviewRuns : req.auth && isJobRoute(req) && isMutating(req.method) ? jobStarts : isMutating(req.method) ? writes : reads;
    // POST /reviews/run is counted only when the call reaches Google (the slot is taken just before the Google call); here it is only refused when the hour is already used up.
    const replay = db !== undefined && isMutating(req.method) && (await isIdempotentReplay(db, req));
    if (reviewRun && !replay) reviewSlotTakers.set(req, () => { reviewRuns.take(key); });
    const wait = replay ? 0 : reviewRun ? limiter.peek(key) : limiter.take(key);
    // CR-005 N-8a: the caller's own limit for this method class (GET vs POST), on every authenticated response, a 429 included.
    const st = limiter.state(key);
    reply.header('ratelimit-limit', String(limiter.limit));
    reply.header('ratelimit-remaining', String(st.remaining));
    reply.header('ratelimit-reset', String(st.resetSeconds));
    if (wait > 0) {
      const seconds = Math.ceil(wait / 1000);
      reply.header('retry-after', String(seconds));
      throw new AppError(429, 'RATE_LIMITED', 'Too many requests for this token', { retry_after_seconds: seconds });
    }
  });
}

