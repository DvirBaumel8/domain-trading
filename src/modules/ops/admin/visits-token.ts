// v5.18.0 (CR-068): the hand-off of the visit-counter token from the Mac host to the GitHub secret, so no person sees it.
// Flow: POST /visits/settings {token: "request"} sets settings.visits_token_request = 'requested'; the host's visits-token.sh runs `admin visits-token-handoff`,
// pipes the printed token into `gh secret set`, then runs `--done` (or `--failed` when gh failed: the newest token is revoked and the request stays open).
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types.js';
import { newAuditId } from '../../../http/audit.js';
import { createApiToken, revokeApiToken } from './tokens.js';

export const VISITS_TOKEN_NAME = 'visit-counter';

const active = (db: Kysely<Database>) =>
  db.selectFrom('api_tokens').select(['id']).where('name', '=', VISITS_TOKEN_NAME).where('scope', '=', 'visits').where('revoked_at', 'is', null).orderBy('id', 'desc');

async function audit(db: Kysely<Database>, path: string, summary: string): Promise<void> {
  await db.insertInto('audit_log').values({ id: newAuditId(), scope: 'admin', method: 'ADMIN', path, status_code: 200, result_summary: summary }).execute();
}

/** When a token is requested: revokes every older active visit-counter token and creates a new one. Returns the raw token, or null when nothing is requested. */
export async function issueVisitsToken(db: Kysely<Database>): Promise<string | null> {
  const s = await db.selectFrom('settings').select('visits_token_request').executeTakeFirstOrThrow();
  if (s.visits_token_request !== 'requested') return null;
  for (const t of await active(db).execute()) await revokeApiToken(db, t.id);
  return (await createApiToken(db, { name: VISITS_TOKEN_NAME, scope: 'visits' })).token;
}

/** The token reached the secret store: the request is 'issued'. False when no request was open. */
export async function markVisitsTokenIssued(db: Kysely<Database>, now: Date): Promise<boolean> {
  const r = await db.updateTable('settings').set({ visits_token_request: 'issued', visits_token_issued_at: now, updated_at: now }).where('visits_token_request', '=', 'requested').returning('id').executeTakeFirst();
  if (r) await audit(db, 'visits-token-handoff --done', 'visits token handed to the secret store');
  return r !== undefined;
}

/** The hand-off failed: the newest visit-counter token is revoked (nobody holds it), the request stays 'requested' for the next tick. */
export async function failVisitsTokenHandoff(db: Kysely<Database>): Promise<boolean> {
  const newest = await active(db).limit(1).executeTakeFirst();
  if (!newest) return false;
  const ok = await revokeApiToken(db, newest.id);
  if (ok) await audit(db, 'visits-token-handoff --failed', `revoked token ${newest.id}; the request stays open`);
  return ok;
}
