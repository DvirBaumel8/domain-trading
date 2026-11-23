import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { AppError } from './errors.js';

/** The only route without a token (Render's health check uses it). */
export const PUBLIC_PATH = '/health/ping';
/** 20 failures from one address in 10 minutes, then refused until they age out. */
const MAX_FAILURES = 20;
const FAILURE_WINDOW_MS = 10 * 60_000;
const MAX_TRACKED = 10_000;
/** Requests one token may make in a minute (a `/check` costs a call to the registrar). */
const MAX_PER_MINUTE = 60;

export const hashToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

/** Times per key within a rolling window. */
class Window {
  private readonly times = new Map<string, number[]>();
  constructor(private readonly max: number, private readonly ms: number, private readonly now: () => number) {}
  private recent(key: string): number[] {
    const list = (this.times.get(key) ?? []).filter((t) => t > this.now() - this.ms);
    if (list.length === 0) this.times.delete(key); else this.times.set(key, list);
    return list;
  }
  /** Seconds to wait when the key is at its limit, else 0. */
  wait(key: string): number {
    const list = this.recent(key);
    return list.length < this.max ? 0 : Math.max(1, Math.ceil((list[list.length - this.max]! + this.ms - this.now()) / 1000));
  }
  add(key: string): void {
    const list = this.recent(key);
    list.push(this.now());
    this.times.delete(key); // re-insert: the first key is the one idle longest
    this.times.set(key, list);
    if (this.times.size > MAX_TRACKED) this.times.delete(this.times.keys().next().value!);
  }
}

/** `tokens`: sha256 of a bearer token -> its name. Every token may read; nothing can be written through the API. */
export function registerAuth(app: FastifyInstance, tokens: ReadonlyMap<string, string>, now: () => number = Date.now): void {
  const failures = new Window(MAX_FAILURES, FAILURE_WINDOW_MS, now);
  const calls = new Window(MAX_PER_MINUTE, 60_000, now);
  app.addHook('onRequest', async (req, reply) => {
    if (req.routeOptions.url === PUBLIC_PATH) return;
    const limited = (seconds: number, message: string): AppError => {
      reply.header('retry-after', String(seconds));
      return new AppError(429, 'RATE_LIMITED', message, { retry_after_seconds: seconds });
    };
    const token = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
    const name = token === undefined ? undefined : tokens.get(hashToken(token));
    if (name === undefined) {
      const wait = failures.wait(req.ip);
      if (wait > 0) throw limited(wait, 'Too many failed authentication attempts');
      failures.add(req.ip);
      throw new AppError(401, 'UNAUTHORIZED', 'Missing or invalid bearer token');
    }
    const wait = calls.wait(name);
    if (wait > 0) throw limited(wait, `More than ${MAX_PER_MINUTE} requests in a minute`);
    calls.add(name);
  });
}
