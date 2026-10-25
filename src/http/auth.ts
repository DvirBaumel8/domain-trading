import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { hashToken } from '../core/tokens.js';
import type { Database, Scope } from '../db/types.js';
import { AppError } from './errors.js';
import { isMutating } from './methods.js';

/** M9: how often `api_tokens.last_used_at` is refreshed. */
const LAST_USED_EVERY_MS = 60_000;

interface AuthContext {
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

const FAILED_AUTH_LIMIT = 20;
const FAILED_AUTH_WINDOW_MS = 10 * 60_000;
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

function pathOf(url: string): string {
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
    if (PUBLIC_PATHS.has(pathOf(req.url)) && !isMutating(req.method, req.routeOptions?.url)) return;
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
      .selectFrom('api_tokens')
      .select(['id', 'scope', 'name', 'last_used_at'])
      .where('token_sha256', '=', hash)
      .where('revoked_at', 'is', null)
      // An expired token is an unknown token: same 401, no hint (CR-007 T-3).
      .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', new Date(now()))]))
      .executeTakeFirst();
    // M9: last_used_at is written at most once a minute per token, not on every request (one dead row version per call otherwise).
    if (row && (row.last_used_at === null || Date.now() - row.last_used_at.getTime() >= LAST_USED_EVERY_MS)) {
      await db.updateTable('api_tokens').set({ last_used_at: new Date() }).where('id', '=', row.id).execute();
    }
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

/** v5.10.0 (CR-061): the routes a `data` token may call (all POST): intake, the two engine uploads, and every route under `/data/` (CR-063). Everything else, GETs included, is 403 SCOPE_FORBIDDEN. */
export const DATA_ROUTES: ReadonlySet<string> = new Set(['/candidates/intake', '/engine/sales', '/engine/unsold', '/visits/import']);
export const DATA_PREFIX = '/data/';
/** v5.43.0 (CR-078): the knowledge base writes are data too (a data token may POST under /kb/, never GET). */
export const KB_PREFIX = '/kb/';
const isDataRoute = (routeUrl: string): boolean => DATA_ROUTES.has(routeUrl) || routeUrl.startsWith(DATA_PREFIX) || routeUrl.startsWith(KB_PREFIX);

const dataForbidden = () => new AppError(403, 'SCOPE_FORBIDDEN', 'A data token may only call POST /candidates/intake, POST /engine/sales, POST /engine/unsold, POST /visits/import, POST /data/* and POST /kb/*');

/** v5.18.0 (CR-068): the one route a `visits` token may call, and the only scope that may call it (WRITE, READ and data tokens are 403). */
export const VISITS_HIT_ROUTE = '/visits/hit';
const visitsForbidden = () => new AppError(403, 'SCOPE_FORBIDDEN', 'A visits token may only call POST /visits/hit, and only a visits token may call it');

/**
 * v5.20.0 (CR-069): every mutating route, classified for a `bots` token. A route missing here counts as `money` (fail closed), and a guard test
 * (tests/modules/http/bots-scope.test.ts, B520-8) fails when a registered mutating route is not listed, so a future route cannot slip through.
 *  - `allowed`: no money, no price, no listing, no registrar call: always open to a bots token.
 *  - `money`: spends, prices, lists, renews, approves or activates: open to a bots token ONLY with `dry_run: true` in the JSON body, else 403 SCOPE_FORBIDDEN.
 *  - `write_only`: refused to a bots token whatever the body (the job runner has its own rule).
 * `POST /visits/hit` is not here: only a visits token may call it. `/score` is read-only (not mutating).
 */
export type BotsClass = 'allowed' | 'money' | 'write_only';
export const BOTS_ROUTES: Readonly<Record<string, BotsClass>> = {
  // money
  'POST /buy': 'money',
  'POST /portfolio/import': 'money',
  'POST /list/{domain}': 'money',
  'POST /listings/{domain}/venue': 'money',
  'POST /export/{venue}/uploaded': 'money',
  'POST /offers': 'money',
  'POST /offers/{id}/outcome': 'money',
  'POST /sold/{domain}': 'money',
  'POST /portfolio/{domain}/horizon': 'money',
  'POST /engine/holdout-date': 'money',
  'POST /quotes/manual': 'money',
  'POST /reviews/run': 'money',
  'POST /reviews/settings': 'money',
  'POST /selection/settings/{label}/activate': 'money',
  'POST /selection/sibling-methods/{method}/approve': 'money',
  'POST /visits/forward/{domain}': 'allowed', // a URL forward at the registrar moves no money (CR-069 item 1 lists the visits routes)
  // write only (the job runner: the daily job applies prices and drops)
  'POST /jobs/run': 'write_only',
  'POST /auctions/plans': 'write_only', // v5.39.0 (CR-077): Dvir's approved maximum bid; Gavriel (WRITE) only
  'POST /auctions/plans/{id}/result': 'write_only', // v5.39.0 (CR-077): the real outcome of a bid plan
  // allowed
  'POST /tokens/bots/rotate': 'allowed',
  'POST /auctions/prebid': 'allowed', // v5.39.0 (CR-077): stores a safety check (a fact about a public name); no money, price or listing
  'POST /listings/{domain}/observed': 'allowed', // v5.27.0 (CR-076 R-2): a public sighting, stored as observed_public; touches no listing, price or export
  'POST /portfolio/{domain}/display-name': 'allowed', // v5.27.0 (CR-076 R-5): capitalisation of the name only
  'POST /portfolio/{domain}/renewal-price': 'allowed',
  'POST /portfolio/{domain}/stats': 'allowed',
  'POST /ledger/costs': 'allowed', // v5.25.0 (CR-070 R-1): records tool, ai and adjustment costs only; no money moves
  'PUT /portfolio/{domain}/forward-costs': 'allowed', // v5.25.0 (CR-070 R-2): a planned-cost note, nothing is spent
  'POST /candidates/{domain}/records': 'allowed',
  'POST /candidates/daily/rebuild': 'allowed',
  'POST /candidates/intake': 'allowed',
  'POST /candidates/screen': 'allowed',
  'POST /company/document': 'allowed',
  'POST /company/forbidden-terms': 'allowed',
  'POST /company/forbidden-terms/{id}/retire': 'allowed',
  'POST /data/bigco-names': 'allowed',
  'POST /data/live-checks': 'allowed',
  'POST /data/rdap': 'allowed',
  'POST /pickproof/{date}/picks': 'allowed', // v5.28.0 (CR-073): the Buyer's daily picks (arm A); a list of names, no money, no listing
  'POST /data/sales': 'allowed', // v5.23.0 (CR-075 R-4): add-only sale reports, no money
  'PUT /data/sales': 'allowed', // answers 405 APPEND_ONLY
  'PUT /data/sales/{id}': 'allowed', // answers 405 APPEND_ONLY
  'PATCH /data/sales': 'allowed', // answers 405 APPEND_ONLY
  'PATCH /data/sales/{id}': 'allowed', // answers 405 APPEND_ONLY
  'DELETE /data/sales': 'allowed', // answers 405 APPEND_ONLY
  'DELETE /data/sales/{id}': 'allowed', // answers 405 APPEND_ONLY
  'POST /data/sales-comps': 'allowed',
  'POST /data/tm-kills': 'allowed',
  'POST /kb/sources': 'allowed', // v5.43.0 (CR-078): evidence base writes, no money
  'POST /kb/authors': 'allowed',
  'POST /kb/claims': 'allowed',
  'POST /kb/evidence': 'allowed',
  'POST /kb/links': 'allowed',
  'POST /kb/questions': 'allowed',
  'POST /demand/keywords': 'allowed',
  'POST /engine/sales': 'allowed',
  'POST /engine/unsold': 'allowed',
  'POST /engine/train': 'allowed',
  'POST /jobs/preview': 'allowed',
  'POST /lessons': 'allowed',
  'PATCH /lessons/{id}': 'allowed',
  'POST /outreach/emails': 'allowed',
  'POST /patterns/sales': 'allowed',
  'POST /reviews/{packet_id}/feedback': 'allowed',
  'POST /reviews/items/{id}/status': 'allowed',
  'POST /reviews/packet': 'allowed',
  'POST /screening/packs': 'allowed',
  'POST /screening/runs': 'allowed',
  'POST /screening/runs/{id}/cancel': 'allowed',
  'POST /screening/runs/{id}/manual': 'allowed',
  'POST /screening/runs/{id}/verdicts': 'allowed',
  'POST /selection/cohorts': 'allowed',
  'POST /selection/drop-lists': 'allowed',
  'POST /selection/evaluate': 'allowed',
  'POST /selection/holdout-suites': 'allowed',
  'POST /selection/labelled-names': 'allowed',
  'POST /selection/lists/{name}': 'allowed',
  'POST /selection/replays': 'allowed',
  'POST /selection/settings': 'allowed',
  'POST /selection/sibling-scan': 'allowed',
  'POST /selection/test-sets': 'allowed',
  'POST /selection/test-sets/{name}/cancel': 'allowed',
  'POST /selection/test-sets/{name}/seal': 'allowed',
  'POST /snapshots/dynadot': 'allowed', // v5.22.0 (CR-071 R-8, R-9): stores public Dynadot rows the bot pulled; no money
  'POST /visits/import': 'allowed',
  'POST /visits/settings': 'allowed',
  'POST /tranches/{id}/members': 'allowed',
  'POST /tranches/{id}/close': 'allowed',
  'POST /tranches': 'allowed',
};

/** The Fastify route pattern (`/list/:domain`) in the `{domain}` form the table and the OpenAPI document use. */
const toBraces = (url: string): string => url.replace(/:([A-Za-z_]+)/g, '{$1}');

const botsForbidden = () => new AppError(403, 'SCOPE_FORBIDDEN', 'A bots token cannot do this: money, price, listing and renewal actions need "dry_run": true or a WRITE token');

/**
 * v5.29.0 (CR-076 note): a body that cannot be parsed (not JSON, too large, wrong media type) never reaches the scope hook. For a bots token on a route that is not
 * `allowed` the answer is still 403 SCOPE_FORBIDDEN (the body cannot carry `dry_run: true`), so a bots token learns nothing about the body before it learns it may not write.
 * Called by the error handler; returns null when the request is not such a case.
 */
export function botsBodyRefusal(req: FastifyRequest): AppError | null {
  if (req.auth?.scope !== 'bots' || req.jobAuth) return null;
  const url = req.routeOptions?.url ?? '';
  if (!isMutating(req.method, url)) return null;
  return (BOTS_ROUTES[`${req.method} ${toBraces(url)}`] ?? 'money') === 'allowed' ? null : botsForbidden();
}

export function registerScope(app: FastifyInstance): void {
  app.addHook('preHandler', async (req) => {
    if (req.auth?.scope === 'intake' && !req.jobAuth) {
      if (req.method !== 'POST' || !INTAKE_ROUTES.has(req.routeOptions?.url ?? '')) throw intakeForbidden();
      return;
    }
    if (req.auth?.scope === 'visits' && !req.jobAuth) {
      if (req.method !== 'POST' || req.routeOptions?.url !== VISITS_HIT_ROUTE) throw visitsForbidden();
      return;
    }
    if (req.routeOptions?.url === VISITS_HIT_ROUTE && !req.jobAuth && req.auth) throw visitsForbidden();
    if (req.auth?.scope === 'data' && !req.jobAuth) {
      if (req.method !== 'POST' || !isDataRoute(req.routeOptions?.url ?? '')) throw dataForbidden();
      return;
    }
    // POST /jobs/run: the job-trigger bearer, or a WRITE token (CR-007 T-2). A READ token is refused like any other credential.
    if (isJobRoute(req) && !req.jobAuth && req.auth?.scope !== 'write') throw new AppError(401, 'UNAUTHORIZED', 'Missing or invalid bearer token');
    if (req.jobAuth) return; // authenticated by the job-trigger bearer, no API-token scope
    if (!req.auth) {
      // Only public GET/HEAD/OPTIONS routes reach here without auth; fail closed for mutations.
      if (isMutating(req.method, req.routeOptions?.url)) throw new AppError(401, 'UNAUTHORIZED', 'Missing or invalid bearer token');
      return;
    }
    if (req.auth.scope === 'bots') {
      const url = req.routeOptions?.url ?? '';
      if (!isMutating(req.method, url)) return; // every GET (and the read-only POSTs /score, /rdap/batch)
      const cls = BOTS_ROUTES[`${req.method} ${toBraces(url)}`] ?? 'money';
      if (cls === 'allowed') return;
      if (cls === 'money' && (req.body as { dry_run?: unknown } | null | undefined)?.dry_run === true) return;
      throw botsForbidden();
    }
    if (isMutating(req.method, req.routeOptions?.url) && req.auth.scope !== 'write') {
      throw new AppError(403, 'SCOPE_FORBIDDEN', 'This token may only call GET endpoints');
    }
  });
}
