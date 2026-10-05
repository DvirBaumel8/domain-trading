import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { hashToken } from '../auth/tokens.js';
import type { Database, Scope } from '../db/types.js';
import { AppError } from './errors.js';
import { isMutating } from './methods.js';

export interface AuthContext {
  tokenId: number;
  scope: Scope;
  name: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
    /** True when the request passed the dedicated job-trigger bearer (POST /jobs/run only). */
    jobAuth: boolean;
  }
}

/** Only liveness is public (no DB). Everything else, /health included, needs a bot token (Dvir, 6 Oct 2026: bots are the only customers). */
export const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/health/ping']);

export const FAILED_AUTH_LIMIT = 20;
export const FAILED_AUTH_WINDOW_MS = 10 * 60_000;
const MAX_TRACKED_IPS = 10_000;

/** In-memory per-IP failed-auth counter (rolling window). Consulted before any DB access. */
export class FailedAuthLimiter {
  private readonly fails = new Map<string, number[]>();
  constructor(
    private readonly limit = FAILED_AUTH_LIMIT,
    private readonly windowMs = FAILED_AUTH_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  private recent(ip: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.fails.get(ip) ?? []).filter((t) => t > cutoff);
    if (list.length === 0) this.fails.delete(ip);
    else this.fails.set(ip, list);
    return list;
  }

  /** Seconds to wait if the IP is blocked, else 0. */
  blockedFor(ip: string): number {
    const list = this.recent(ip);
    if (list.length < this.limit) return 0;
    return Math.max(1, Math.ceil((list[list.length - this.limit]! + this.windowMs - this.now()) / 1000));
  }

  fail(ip: string): void {
    const list = this.recent(ip);
    list.push(this.now());
    this.fails.delete(ip); // re-insert so Map order = most recently active last
    this.fails.set(ip, list);
    if (this.fails.size > MAX_TRACKED_IPS) {
      const oldest = this.fails.keys().next().value;
      if (oldest !== undefined) this.fails.delete(oldest);
    }
  }
}
export const JOB_PATH = '/jobs/run';

/** True when the request MATCHED the job route. Uses the routed (decoded) pattern, never the raw URL, so /jobs/%72un cannot slip past. */
export function isJobRoute(req: { routeOptions?: { url?: string } }): boolean {
  return req.routeOptions?.url === JOB_PATH;
}
const BEARER = /^Bearer ([A-Za-z0-9_-]+)$/i;

export function pathOf(url: string): string {
  return url.split('?')[0] ?? url;
}

function sameSecret(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function registerAuth(app: FastifyInstance, db: Kysely<Database>, jobTriggerToken?: string, now: () => number = Date.now): void {
  const failed = new FailedAuthLimiter(FAILED_AUTH_LIMIT, FAILED_AUTH_WINDOW_MS, now);
  app.decorateRequest('auth', null);
  app.decorateRequest('jobAuth', false);
  app.addHook('onRequest', async (req) => {
    const refuse = (): never => {
      failed.fail(req.ip);
      throw new AppError(401, 'UNAUTHORIZED', 'Missing or invalid bearer token');
    };
    if (PUBLIC_PATHS.has(pathOf(req.url)) && !isMutating(req.method)) return;
    const wait = failed.blockedFor(req.ip);
    if (wait > 0) throw new AppError(429, 'RATE_LIMITED', 'Too many failed authentication attempts', { retry_after_seconds: wait });
    if (isJobRoute(req) && req.method === 'POST') {
      // Dedicated bearer, never a READ/WRITE API token.
      if (!jobTriggerToken) throw new AppError(503, 'JOBS_DISABLED', 'The job endpoint is not configured');
      const jm = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '');
      if (!jm?.[1] || !sameSecret(jm[1], jobTriggerToken)) return refuse();
      req.jobAuth = true;
      return;
    }
    const m = BEARER.exec(req.headers.authorization ?? '');
    if (!m?.[1]) return refuse();
    const row = await db
      .updateTable('api_tokens')
      .set({ last_used_at: new Date() })
      .where('token_sha256', '=', hashToken(m[1]))
      .where('revoked_at', 'is', null)
      .returning(['id', 'scope', 'name'])
      .executeTakeFirst();
    if (!row) return refuse();
    req.auth = { tokenId: row.id, scope: row.scope, name: row.name };
  });
}

export function registerScope(app: FastifyInstance): void {
  app.addHook('preHandler', async (req) => {
    if (isJobRoute(req) && !req.jobAuth) throw new AppError(401, 'UNAUTHORIZED', 'Missing or invalid bearer token');
    if (req.jobAuth) return; // POST /jobs/run: authenticated by the job-trigger bearer, no API-token scope
    if (!req.auth) {
      // Only public GET/HEAD/OPTIONS routes reach here without auth; fail closed for mutations.
      if (isMutating(req.method)) throw new AppError(401, 'UNAUTHORIZED', 'Missing or invalid bearer token');
      return;
    }
    if (isMutating(req.method) && req.auth.scope !== 'write') {
      throw new AppError(403, 'SCOPE_FORBIDDEN', 'This token may only call GET endpoints');
    }
  });
}
