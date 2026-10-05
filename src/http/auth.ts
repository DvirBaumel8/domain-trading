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

export const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/health', '/health/ping']);
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

export function registerAuth(app: FastifyInstance, db: Kysely<Database>, jobTriggerToken?: string): void {
  app.decorateRequest('auth', null);
  app.decorateRequest('jobAuth', false);
  app.addHook('onRequest', async (req) => {
    if (isJobRoute(req) && req.method === 'POST') {
      // Dedicated bearer, never a READ/WRITE API token.
      if (!jobTriggerToken) throw new AppError(503, 'JOBS_DISABLED', 'The job endpoint is not configured');
      const jm = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '');
      if (!jm?.[1] || !sameSecret(jm[1], jobTriggerToken)) throw new AppError(401, 'UNAUTHORIZED', 'Missing or invalid bearer token');
      req.jobAuth = true;
      return;
    }
    if (PUBLIC_PATHS.has(pathOf(req.url)) && !isMutating(req.method)) return;
    const m = BEARER.exec(req.headers.authorization ?? '');
    if (!m?.[1]) throw new AppError(401, 'UNAUTHORIZED', 'Missing or invalid bearer token');
    const row = await db
      .updateTable('api_tokens')
      .set({ last_used_at: new Date() })
      .where('token_sha256', '=', hashToken(m[1]))
      .where('revoked_at', 'is', null)
      .returning(['id', 'scope', 'name'])
      .executeTakeFirst();
    if (!row) throw new AppError(401, 'UNAUTHORIZED', 'Missing or invalid bearer token');
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
