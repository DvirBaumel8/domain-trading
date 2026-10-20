// v5.20.0 (CR-069): POST /tokens/bots/rotate, the one token-creation route. It can only make a `bots` token (the shared non-money token of all bots),
// and only a WRITE token or a bots token may call it (both already hold at least that power; a bots token rotating itself keeps the key alive once the WRITE token is retired).
// The raw value is returned ONCE. The idempotency store keeps a replay body without it (`idemReplayBody`), and it is never in the audit row.
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { toJerusalemIso } from '../../../core/dates.js';
import { generateToken, hashToken } from '../../../core/tokens.js';
import type { Database } from '../../../db/types.js';
import { AppError } from '../../../http/errors.js';

export const BOTS_TOKEN_NAME = 'bots-shared';
/** How long the previous shared token keeps working after a rotation. */
export const BOTS_ROTATE_GRACE_MS = 10 * 60_000;

export function registerTokens(app: FastifyInstance, deps: { db: Kysely<Database>; now: () => number }): void {
  app.post('/tokens/bots/rotate', { config: { openapiNoBody: true } }, async (req, reply) => {
    if (req.auth?.scope !== 'write' && req.auth?.scope !== 'bots') throw new AppError(403, 'SCOPE_FORBIDDEN', 'Only a WRITE or bots token may rotate the shared bots token');
    const now = deps.now();
    const oldUntil = new Date(now + BOTS_ROTATE_GRACE_MS);
    const token = generateToken();
    const expiredIds = await deps.db.transaction().execute(async (trx) => {
      // The live shared token stops in 10 minutes (an expiry that is already sooner stays). It is renamed because active token names are unique.
      const old = await trx.updateTable('api_tokens').set({ name: sql<string>`'bots-shared-old-' || id::text`, expires_at: sql<Date>`least(coalesce(expires_at, ${oldUntil}), ${oldUntil})` })
        .where('name', '=', BOTS_TOKEN_NAME).where('scope', '=', 'bots').where('revoked_at', 'is', null)
        .returning('id').execute();
      await trx.insertInto('api_tokens').values({ name: BOTS_TOKEN_NAME, scope: 'bots', token_sha256: hashToken(token) }).execute();
      return old.map((r) => r.id);
    });
    req.auditSummary = `rotated the shared bots token (old tokens expiring: ${expiredIds.length})`;
    const expiresOldAt = expiredIds.length > 0 ? toJerusalemIso(oldUntil) : null;
    req.idemReplayBody = JSON.stringify({ token: null, expires_old_at: expiresOldAt, note: 'already rotated; the token value is shown once, rotate again for a new one', audit_id: req.auditId ?? null });
    return reply.code(200).send({ token, expires_old_at: expiresOldAt, audit_id: req.auditId ?? null });
  });
}
