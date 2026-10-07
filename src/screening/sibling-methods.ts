// CR-008 C-2: the approval state of a frozen sibling method (one approval row per method and pools hash, append-only).
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { AppError } from '../http/errors.js';
import { normalizeDomain } from '../domain-name.js';
import { requireNamedApproval } from './approval.js';
import { analyzeForm } from './form.js';
import { buildLexicon, loadDataLexicon } from './lexicon.js';
import { currentLists } from './lists.js';
import type { SelectionValuesT } from './settings.js';
import { KNOWN_METHODS, isKnownMethod } from './siblings.js';

export interface MethodApproval { text: string; approvedAt: Date }

export const methodSha = (method: string): string => KNOWN_METHODS[method]!.sha256;

/** The approval of the method's current pools, or null. */
export async function methodApproval(db: Kysely<Database>, method: string): Promise<MethodApproval | null> {
  if (!isKnownMethod(method)) return null;
  const r = await db.selectFrom('sibling_method_approvals').select(['approval_text', 'approval_at']).where('method', '=', method).where('pools_sha256', '=', methodSha(method)).orderBy('id').limit(1).executeTakeFirst();
  return r ? { text: r.approval_text, approvedAt: r.approval_at } : null;
}

export async function approveMethod(
  db: Kysely<Database>, method: string, approvalRef: unknown, now: Date, by: { createdBy: string; auditId: string },
): Promise<MethodApproval> {
  if (!isKnownMethod(method)) throw new AppError(404, 'SIBLING_METHOD_NOT_FOUND', `No sibling method "${method}"`);
  if (await methodApproval(db, method)) throw new AppError(409, 'SIBLING_METHOD_ALREADY_APPROVED', `${method} is already approved`);
  const a = await requireNamedApproval(db, approvalRef, now, 'Approving a sibling method', [method]);
  try {
    await db.insertInto('sibling_method_approvals').values({
      method, pools_sha256: methodSha(method), approval_text: a.text, approval_at: a.approvedAt, audit_id: by.auditId, created_by: by.createdBy,
    }).execute();
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new AppError(409, 'SIBLING_METHOD_ALREADY_APPROVED', `${method} is already approved`);
    throw e;
  }
  return { text: a.text, approvedAt: a.approvedAt };
}

const FORM_LISTS = ['trade', 'regime', 'tech', 'generic_head', 'state', 'legal', 'city_extra', 'dictionary_extra'];

/** DOM's own word split of a .com (the `form` check's tokens, lane S7), from the current versioned word lists and the given settings. */
export async function splitOfDomain(db: Kysely<Database>, domain: string, values: SelectionValuesT): Promise<{ domain: string; tokens: string[] }> {
  const d = normalizeDomain(domain);
  const lists = await currentLists(db, FORM_LISTS);
  const lexicon = buildLexicon(loadDataLexicon(), lists, { cityOneToken: values.form.geo_city_one_token, cityWordAllowlist: values.form.city_word_allowlist });
  return { domain: d, tokens: analyzeForm(d, 'S7', lexicon, values.form).tokens };
}
