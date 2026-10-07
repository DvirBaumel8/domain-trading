// v2.10.0 (CR-011 part B): the block list. Text that would leave the service (the company document, a review packet, feedback notes,
// and later X posts) is refused with a category, never with the matched text.
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';

export type BlockCategory = 'secret' | 'email' | 'phone' | 'listed_term';
export type BlockResult = { ok: true } | { ok: false; category: BlockCategory };
export interface BlockOpts { secretValues?: readonly string[] }

/** A configured secret shorter than this is ignored (a short value would match ordinary words). */
export const MIN_SECRET_LENGTH = 8;

// A DOM bearer token: `dt_` + 32 random bytes in base64url (43 characters), see src/auth/tokens.ts.
const DOM_TOKEN = /(?<![A-Za-z0-9])dt_[A-Za-z0-9_-]{40,}/;
// Common key shapes (CR-013 F-4, listed in the contract): Porkbun pk1_/sk1_, Google AIza, GitHub ghp_ and github_pat_, OpenAI/Anthropic sk- (sk-proj-, sk-ant-),
// Slack xoxb-/xoxp-/xoxa-/xapp-, AWS AKIA + 16, Render rnd_, and a JWT (three base64url parts, the first starting eyJ).
const KEY_SHAPES = new RegExp([
  '(?<![A-Za-z0-9])(?:(?:pk1_|sk1_|ghp_|github_pat_)[A-Za-z0-9_]{4,}|AIza[0-9A-Za-z_-]{20,})',
  '(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}',
  '(?<![A-Za-z0-9])xox[abp]-[A-Za-z0-9-]{10,}',
  '(?<![A-Za-z0-9])xapp-[A-Za-z0-9-]{10,}',
  '(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}',
  '(?<![A-Za-z0-9])rnd_[A-Za-z0-9]{16,}',
  '(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}',
].join('|'));
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}/;
// Dates such as 2026-10-07 are blanked before the phone check.
const ISO_DATE = /\d{4}-\d{2}-\d{2}/g;
// A candidate run of digits with spaces, dashes and parentheses, not glued to letters or digits (so a hex hash never matches).
const PHONE_RUN = /(?<![\w])\+?\(?\d[\d ()-]{6,}\d\)?(?![\w])/g;

export const PHONE_MIN_DIGITS = 9;

function hasPhone(text: string): boolean {
  const t = text.replace(ISO_DATE, ' ');
  for (const m of t.matchAll(PHONE_RUN)) {
    const run = m[0];
    if (run.replace(/\D/g, '').length < PHONE_MIN_DIGITS) continue;
    if (/[ ()-]{3,}/.test(run)) continue; // at most 2 separators in a row
    return true;
  }
  return false;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole word for an alphanumeric term, also followed by s, es, 's or ’s (CR-013 F-8); plain substring otherwise; always case-insensitive. */
export function termMatches(text: string, term: string): boolean {
  const t = term.trim();
  if (t.length === 0) return false;
  if (/^[A-Za-z0-9]+$/.test(t)) return new RegExp(`(?<![A-Za-z0-9])${escapeRe(t)}(?:['\u2019]s|es|s)?(?![A-Za-z0-9])`, 'i').test(text);
  return text.toLowerCase().includes(t.toLowerCase());
}

export async function checkText(db: Kysely<Database>, text: string, opts: BlockOpts = {}): Promise<BlockResult> {
  for (const v of opts.secretValues ?? []) if (v.length >= MIN_SECRET_LENGTH && text.includes(v)) return { ok: false, category: 'secret' };
  if (DOM_TOKEN.test(text) || KEY_SHAPES.test(text)) return { ok: false, category: 'secret' };
  if (EMAIL.test(text)) return { ok: false, category: 'email' };
  if (hasPhone(text)) return { ok: false, category: 'phone' };
  const terms = await db.selectFrom('forbidden_terms as t').leftJoin('forbidden_term_retirements as r', 'r.term_id', 't.id').select('t.term').where('r.id', 'is', null).execute();
  for (const { term } of terms) if (termMatches(text, term)) return { ok: false, category: 'listed_term' };
  return { ok: true };
}
