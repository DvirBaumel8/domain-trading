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
  }
}

export const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/health']);
const BEARER = /^Bearer ([A-Za-z0-9_-]+)$/i;

export function pathOf(url: string): string {
  return url.split('?')[0] ?? url;
}

export function registerAuth(app: FastifyInstance, db: Kysely<Database>): void {
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    if (PUBLIC_PATHS.has(pathOf(req.url))) return;
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
    if (!req.auth) return; // public route
    if (isMutating(req.method) && req.auth.scope !== 'write') {
      throw new AppError(403, 'SCOPE_FORBIDDEN', 'This token may only call GET endpoints');
    }
  });
}
