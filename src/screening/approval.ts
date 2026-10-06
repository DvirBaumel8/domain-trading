// One approval check for the selection actions that need Dvir's words (settings activation, census freeze):
// loads the age limit, validates the approval_ref and requires the text to NAME the thing approved (same boundary rule as /buy's domain check).
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { AppError } from '../http/errors.js';
import { checkTimedApproval, namesToken } from '../services/approval.js';

/** Returns the approval text. `names`: any one of them must appear in the text. */
export async function requireNamedApproval(
  db: Kysely<Database>, ref: unknown, now: Date, what: string, names: string[],
): Promise<{ text: string; approvedAt: Date }> {
  if (ref === undefined || ref === null) throw new AppError(422, 'APPROVAL_REQUIRED', `${what} needs approval_ref (Dvir's words)`);
  const lim = await db.selectFrom('settings').select('approval_max_age_hours').executeTakeFirstOrThrow();
  const a = checkTimedApproval(ref as { text?: unknown; approved_at?: unknown }, now, lim.approval_max_age_hours);
  if (!a.ok) throw new AppError(422, a.code, a.reason);
  const text = String((ref as { text: string }).text);
  if (!names.some((n) => namesToken(text, n))) {
    throw new AppError(422, 'APPROVAL_INVALID', `approval_ref.text must name ${names.map((n) => `"${n}"`).join(' or ')}`);
  }
  return { text, approvedAt: a.approvedAt };
}
