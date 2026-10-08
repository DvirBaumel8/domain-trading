import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { hashToken } from '../core/tokens.js';
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

/** Only liveness is public (no DB), plus GET /media/<token> (MEDIA_PATH). Everything else, /health included, needs a bot token (Dvir, 6 Oct 2026: bots are the only customers). */
export const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/health/ping']);

/** v2.12.0: the one other public read. Buffer fetches post images from GET /media/<32 hex token> (unguessable, expires after 7 days). The whole /media/* path is public (v2.15.0): any unknown token is 404 NOT_FOUND. It writes nothing. */
export const MEDIA_PATH = /^\/media\/.+$/;

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

const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 100;

/** Recently verified bot credentials (sha256 -> auth). Consulted ONLY while the caller's IP is blocked, and a hit only permits the normal DB lookup (so revocation always bites); it never authenticates by itself. */
class RecentCredentials {
  private readonly m = new Map<string, { auth: AuthContext; at: number }>();
  constructor(private readonly now: () => number) {}
  get(hash: string): AuthContext | null {
    const e = this.m.get(hash);
    if (!e) return null;
    if (e.at <= this.now() - CACHE_TTL_MS) { this.m.delete(hash); return null; }
    return e.auth;
  }
  set(hash: string, auth: AuthContext): void {
    this.m.delete(hash);
    this.m.set(hash, { auth, at: this.now() });
    if (this.m.size > CACHE_MAX) this.m.delete(this.m.keys().next().value as string);
  }
  drop(hash: string): void { this.m.delete(hash); }
}

export function registerAuth(app: FastifyInstance, db: Kysely<Database>, jobTriggerToken?: string, now: () => number = Date.now): void {
  const failed = new FailedAuthLimiter(FAILED_AUTH_LIMIT, FAILED_AUTH_WINDOW_MS, now);
  const recent = new RecentCredentials(now);
  app.decorateRequest('auth', null);
  app.decorateRequest('jobAuth', false);
  app.addHook('onRequest', async (req, reply) => {
    const refuse = (): never => {
      failed.fail(req.ip);
      throw new AppError(401, 'UNAUTHORIZED', 'Missing or invalid bearer token');
    };
    if ((PUBLIC_PATHS.has(pathOf(req.url)) || MEDIA_PATH.test(pathOf(req.url))) && !isMutating(req.method)) return;
    const wait = failed.blockedFor(req.ip);
    const tooMany = (): never => {
      reply.header('retry-after', String(wait));
      throw new AppError(429, 'RATE_LIMITED', 'Too many failed authentication attempts', { retry_after_seconds: wait });
    };
    const jobRoute = isJobRoute(req) && req.method === 'POST';
    // POST /jobs/run: the dedicated job bearer (never an API token's scope), or else a WRITE API token (checked in registerScope).
    // A constant-time compare needs no DB, so the correct job bearer passes even a blocked IP.
    let jobsDisabled = false;
    if (jobRoute) {
      const jm = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '');
      if (jobTriggerToken && jm?.[1] && sameSecret(jm[1], jobTriggerToken)) {
        req.jobAuth = true;
        return;
      }
      jobsDisabled = !jobTriggerToken;
    }
    const unauthenticated = (): never => {
      if (jobsDisabled) throw new AppError(503, 'JOBS_DISABLED', 'The job endpoint is not configured');
      return refuse();
    };
    const m = BEARER.exec(req.headers.authorization ?? '');
    const hash = m?.[1] ? hashToken(m[1]) : null;
    // Blocked IP: only a recently verified token may proceed, and only to the normal DB lookup (revocation still bites).
    if (wait > 0 && (!hash || !recent.get(hash))) return tooMany();
    if (!hash) return unauthenticated();
    const row = await db
      .updateTable('api_tokens')
      .set({ last_used_at: new Date() })
      .where('token_sha256', '=', hash)
      .where('revoked_at', 'is', null)
      // An expired token is an unknown token: same 401, no hint (CR-007 T-3).
      .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', new Date(now()))]))
      .returning(['id', 'scope', 'name'])
      .executeTakeFirst();
    if (!row) {
      recent.drop(hash);
      return wait > 0 ? tooMany() : unauthenticated();
    }
    req.auth = { tokenId: row.id, scope: row.scope, name: row.name };
    recent.set(hash, req.auth);
  });
}

/** v2.14.0 (CR-012 T12-18): the only routes an `intake` token may call (all POST). Everything else, GETs included, is 403 SCOPE_FORBIDDEN. */
export const INTAKE_ROUTES: ReadonlySet<string> = new Set(['/candidates/intake', '/selection/drop-lists']);

const intakeForbidden = () => new AppError(403, 'SCOPE_FORBIDDEN', 'An intake token may only call POST /candidates/intake and POST /selection/drop-lists');

/** onRequest hook for a route that takes a big body (POST /posts): a token that cannot write is refused before the body is read or parsed (F12). */
export async function requireWriteBeforeBody(req: { auth: AuthContext | null; jobAuth: boolean }): Promise<void> {
  if (!req.auth || req.jobAuth) return; // unauthenticated requests were already refused 401 in the auth hook
  if (req.auth.scope === 'intake') throw intakeForbidden();
  if (req.auth.scope !== 'write') throw new AppError(403, 'SCOPE_FORBIDDEN', 'This token may only call GET endpoints');
}

export function registerScope(app: FastifyInstance): void {
  app.addHook('preHandler', async (req) => {
    if (req.auth?.scope === 'intake' && !req.jobAuth) {
      if (req.method !== 'POST' || !INTAKE_ROUTES.has(req.routeOptions?.url ?? '')) throw intakeForbidden();
      return;
    }
    // POST /jobs/run: the job-trigger bearer, or a WRITE token (CR-007 T-2). A READ token is refused like any other credential.
    if (isJobRoute(req) && !req.jobAuth && req.auth?.scope !== 'write') throw new AppError(401, 'UNAUTHORIZED', 'Missing or invalid bearer token');
    if (req.jobAuth) return; // authenticated by the job-trigger bearer, no API-token scope
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
