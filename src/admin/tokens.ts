import type { Kysely } from 'kysely';
import { generateToken, hashToken } from '../auth/tokens.js';
import type { Database, Scope } from '../db/types.js';
import { newAuditId } from '../http/audit.js';

export async function createApiToken(
  db: Kysely<Database>,
  input: { name: string; scope: Scope },
): Promise<{ id: number; token: string }> {
  const token = generateToken();
  return db.transaction().execute(async (trx) => {
    const { id } = await trx
      .insertInto('api_tokens')
      .values({ name: input.name, scope: input.scope, token_sha256: hashToken(token) })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('audit_log')
      .values({
        id: newAuditId(),
        scope: 'admin',
        method: 'ADMIN',
        path: 'token create',
        request: JSON.stringify({ name: input.name, scope: input.scope }),
        status_code: 200,
        result_summary: `created token ${id}`,
      })
      .execute();
    return { id, token };
  });
}

export async function revokeApiToken(db: Kysely<Database>, id: number): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const r = await trx
      .updateTable('api_tokens')
      .set({ revoked_at: new Date() })
      .where('id', '=', id)
      .where('revoked_at', 'is', null)
      .returning('id')
      .executeTakeFirst();
    if (!r) return false;
    await trx
      .insertInto('audit_log')
      .values({
        id: newAuditId(),
        scope: 'admin',
        method: 'ADMIN',
        path: 'token revoke',
        request: JSON.stringify({ id }),
        status_code: 200,
        result_summary: `revoked token ${id}`,
      })
      .execute();
    return true;
  });
}

export async function listApiTokens(db: Kysely<Database>) {
  return db
    .selectFrom('api_tokens')
    .select(['id', 'name', 'scope', 'created_at', 'revoked_at', 'last_used_at', 'expires_at'])
    .orderBy('id')
    .execute();
}

/** Sets when a token stops working (CR-007 T-3). A time in the past expires it at once. Returns false when the token does not exist or is revoked. */
export async function expireApiToken(db: Kysely<Database>, id: number, at: Date): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const r = await trx
      .updateTable('api_tokens')
      .set({ expires_at: at })
      .where('id', '=', id)
      .where('revoked_at', 'is', null)
      .returning('id')
      .executeTakeFirst();
    if (!r) return false;
    await trx
      .insertInto('audit_log')
      .values({
        id: newAuditId(),
        scope: 'admin',
        method: 'ADMIN',
        path: 'token expire',
        request: JSON.stringify({ id, at: at.toISOString() }),
        status_code: 200,
        result_summary: `token ${id} expires ${at.toISOString()}`,
      })
      .execute();
    return true;
  });
}
