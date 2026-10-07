import type { FastifyInstance } from 'fastify';
import { isJobRoute } from './auth.js';
import { AppError } from './errors.js';
import { isMutating } from './methods.js';

/** POST /jobs/run by a WRITE token: calls per hour per token (the job token keeps the general 10 per minute). */
export const WRITE_JOB_RUNS_PER_HOUR = 4;

/** POST /reviews/run: calls per hour per WRITE token (the outside review costs money and counts toward the monthly cap). */
export const REVIEW_RUNS_PER_HOUR = 3;

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

  take(key: string): number {
    const t = this.now();
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

export function registerRateLimit(app: FastifyInstance, now: () => number = Date.now): void {
  const reads = new SlidingWindowLimiter(60, 60_000, now);
  const writes = new SlidingWindowLimiter(10, 60_000, now);
  const jobStarts = new SlidingWindowLimiter(WRITE_JOB_RUNS_PER_HOUR, 3_600_000, now);
  const reviewRuns = new SlidingWindowLimiter(REVIEW_RUNS_PER_HOUR, 3_600_000, now);
  app.addHook('preHandler', async (req, reply) => {
    const key = req.auth ? String(req.auth.tokenId) : req.jobAuth && isJobRoute(req) ? 'job' : null;
    // v2.6.0 (N-4): POST /jobs/run by a token that is not WRITE is refused 401 by the scope hook; it never counts against (or reports) the WRITE limiter.
    if (req.auth && !req.jobAuth && isJobRoute(req) && req.auth.scope !== 'write') return;
    if (key === null) return; // public routes (/health) are not limited
    // CR-007 T-2: a WRITE token starting a job has its own, tighter limit (instead of the general write limit).
    const reviewRun = req.auth && req.routeOptions?.url === '/reviews/run' && req.method === 'POST' && req.auth.scope === 'write';
    const limiter = reviewRun ? reviewRuns : req.auth && isJobRoute(req) && isMutating(req.method) ? jobStarts : isMutating(req.method) ? writes : reads;
    const wait = limiter.take(key);
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
