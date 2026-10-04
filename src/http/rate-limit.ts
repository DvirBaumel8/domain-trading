import type { FastifyInstance } from 'fastify';
import { AppError } from './errors.js';
import { isMutating } from './methods.js';

/** In-memory sliding window. Fine for one Render instance; revisit if we ever scale out. */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

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
  app.addHook('preHandler', async (req, reply) => {
    if (!req.auth) return; // public routes (/health) are not limited
    const wait = (isMutating(req.method) ? writes : reads).take(String(req.auth.tokenId));
    if (wait > 0) {
      const seconds = Math.ceil(wait / 1000);
      reply.header('retry-after', String(seconds));
      throw new AppError(429, 'RATE_LIMITED', 'Too many requests for this token', { retry_after_seconds: seconds });
    }
  });
}
