// v5.45.0 (G-127): runs the automatic pre-bid checks of one registered name and stores the answer in prebid_checks. Shared by POST /auctions/prebid (token and audit row of the caller)
// and the datasave step auctionShortlist (token_name 'datasave', audit null). The checks themselves are selection/prebid.ts `runPrebidChecks`.
import type { Kysely } from 'kysely';
import { toJerusalemIso } from '../../../core/dates.js';
import { pair } from '../../../core/money.js';
import type { Database } from '../../../db/types.js';
import { prebidVerdictOf, runPrebidChecks, type PrebidCheck, type ScreeningDeps } from '../../selection/index.js';

/** The exact strings of the manual checks (v5.44.0): the name as words, in quotes, its CamelCase form, and the company registers. No automation of Google: a human pastes them. */
export function manualSearches(domain: string, words: readonly string[]): { words: string; camel_case: string; queries: string[]; wayback: string } {
  const sld = domain.replace(/\.com$/, '');
  const parts = words.length > 0 ? [...words] : [sld];
  const spaced = parts.join(' ');
  const camel = parts.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  return {
    words: spaced, camel_case: camel, wayback: `https://web.archive.org/web/*/${domain}`,
    queries: [
      `"${spaced}"`, `"${camel}"`, `"${sld}"`,
      `site:opencorporates.com "${spaced}"`, `site:find-and-update.company-information.service.gov.uk "${spaced}"`, `site:companieshouse.gov.uk "${spaced}"`,
    ],
  };
}

/** What no program can check: said in every pre-bid answer, confirmed by the caller in the plan's `manual` block. */
export function manualRequired(domain: string, words: readonly string[]) {
  const s = manualSearches(domain, words);
  return [
    { id: 'EXACT_STRING_BUSINESS', what: 'Google exact phrase + company registries: an operating business called exactly this name kills a coined name', search_strings: s.queries, name_as_words: s.words, camel_case: s.camel_case },
    { id: 'HIST_WAYBACK', what: 'past harmful use, checked by hand', wayback_url: s.wayback },
  ];
}

export interface StoredPrebid { id: number; verdict: 'pass' | 'flag' | 'fail'; checks: PrebidCheck[]; answer: Record<string, unknown> }

export async function storePrebid(
  db: Kysely<Database>, screening: ScreeningDeps, domain: string, venue: 'godaddy' | 'dynadot', now: () => number,
  who: { tokenName: string | null; auditId: string | null }, budgetMs?: number,
): Promise<StoredPrebid> {
  const cfg = await db.selectFrom('settings').select('s8_max_price_cents').executeTakeFirstOrThrow();
  const out = await runPrebidChecks(db, screening, domain, now, budgetMs);
  const verdict = prebidVerdictOf(out.checks);
  const answer = {
    domain, venue, checked_at: toJerusalemIso(new Date(now())), verdict, checks: out.checks, manual_required: manualRequired(domain, out.words), endings: out.endings, ...pair('s8_max_price', cfg.s8_max_price_cents),
  };
  const row = await db.insertInto('prebid_checks').values({
    domain, venue, verdict, answer: JSON.stringify(answer), token_name: who.tokenName, audit_id: who.auditId, created_at: new Date(now()),
  }).returning('id').executeTakeFirstOrThrow();
  return { id: row.id, verdict, checks: out.checks, answer };
}
