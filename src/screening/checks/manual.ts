// G5 Web Risk (CAP-06), G7 US trademark (CAP-08) and G6 history (CAP-07, CR-002 Amendment B): no official automated source is enabled
// (CR-001 §11 P-2: DOM does not use undocumented website endpoints; Dvir, 6 Oct 2026: the Internet Archive is never automated), so the
// run answers MANUAL_REQUIRED and a human result is recorded with POST /screening/runs/{id}/manual. The record is turned into a status
// here, by the settings' rules.
import { z } from 'zod';
import type { SelectionValuesT } from '../settings.js';
import { outcome, type Check, type CheckOutcome, type ResultRow } from '../types.js';
import { nameTokens } from '../prior-business.js';
import { matchTerms } from './brand-lists.js';
import { formFieldsOf } from './form.js';

export const MANUAL_CHECKS = ['web_risk', 'tm_us', 'history'] as const;
export type ManualCheckId = (typeof MANUAL_CHECKS)[number];

export const WebRiskManual = z.object({ raw_status: z.number().int(), threat_types: z.array(z.string().max(80)).max(20).optional() }).strict();
const Mark = z.object({ mark: z.string().max(200), serial: z.string().max(40), owner: z.string().max(200), status: z.string().max(100) }).strict();
export const TmManual = z.object({
  phrases_queried: z.array(z.string().min(1).max(200)).min(1).max(30),
  control_ok: z.boolean(),
  exact_or_core_live: z.array(Mark).max(50),
  generic_live: z.array(Mark).max(50),
  dead_n: z.number().int().nonnegative().optional(),
  /** Live marks found for the PRIOR business name (required to be searched when the history check found one). */
  prior_name_live: z.array(Mark).max(50).optional(),
}).strict();

/** The phrase searched for a prior business name: uppercase letters, digits and single spaces. */
export const priorPhraseOf = (name: string): string => name.toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const phraseKey = (p: string): string => priorPhraseOf(p);

/** Phrases to search at USPTO for a name (CAP-08): the exact phrase, city + trade, the distinctive core, generic-head pairs. */
export function tmPhrases(tokens: string[], types: string[], city: string | null, trade: string | null): string[] {
  const up = (xs: string[]) => xs.join(' ').toUpperCase();
  const out: string[] = [];
  const add = (p: string) => { if (p && !out.includes(p)) out.push(p); };
  add(up(tokens));
  if (city && trade) add(up(tokens.filter((t) => t === city || t === trade)));
  add(up(tokens.filter((_, i) => types[i] !== 'generic_head')));
  tokens.forEach((t, i) => { if (types[i] === 'generic_head' && i > 0) add(up([tokens[i - 1]!, t])); });
  return out;
}

const HOW = 'Record the result with POST /screening/runs/{id}/manual';

export const webRiskCheck: Check = {
  id: 'web_risk',
  gate: 'G5',
  ruleIds: ['WEB-RISK-1'],
  lists: [],
  async run(ctx) {
    return outcome('MANUAL_REQUIRED', 'MANUAL_SOURCE', `Google Web Risk is not automated: look the name up and record it. ${HOW}`, {
      source: 'transparency_report_interim', lookup_name: ctx.item.domain, safe_statuses: ctx.settings.web_risk.safe_statuses,
      unsafe_statuses: ctx.settings.web_risk.unsafe_statuses, requires_clean_history: ctx.settings.web_risk.requires_clean_history,
    });
  },
};

export const tmUsCheck: Check = {
  id: 'tm_us',
  gate: 'G7',
  ruleIds: ['TM-1'],
  lists: ['trade', 'regime', 'tech', 'generic_head', 'state', 'legal', 'city_extra', 'dictionary_extra'],
  async run(ctx) {
    const f = formFieldsOf(ctx);
    const phrases = tmPhrases(f.tokens, f.token_types, f.city, f.trade);
    // CR-002 Amendment A1: when the history check found a prior business, CAP-08 also runs on ITS name (a live mark there is a TM-1 failure).
    const prior = ctx.latest('history')?.fields.prior_business_name;
    const priorName = typeof prior === 'string' && prior !== '' ? prior : null;
    const priorPhrase = priorName === null ? null : priorPhraseOf(priorName);
    if (priorPhrase && !phrases.includes(priorPhrase)) phrases.push(priorPhrase);
    return outcome('MANUAL_REQUIRED', 'MANUAL_SOURCE', `The USPTO wordmark search is not automated: search these phrases (plus the control query) and record it. ${HOW}`, {
      phrases_to_query: phrases, control_required: true, ...(priorName !== null && { prior_business_name: priorName, prior_business_phrase: priorPhrase }),
    });
  },
};

const iso = (d: Date) => d.toISOString();

/**
 * Turns a recorded Web Risk lookup into a result (CAP-06 interim rule; the history requirement is a setting). History is "final" when it
 * is anything but UNKNOWN, NOT_RUN or MANUAL_REQUIRED, and "clean" when it is not a FAIL: a FLAG history is final and clean here (the
 * FLAG still needs its own verdict; this record does not give it one). No history result at all is not final.
 */
export function webRiskFromManual(rec: z.infer<typeof WebRiskManual>, sel: SelectionValuesT, history: ResultRow | undefined, evidenceUrl: string, checkedAt: Date, note?: string): CheckOutcome {
  const final = history ? !['UNKNOWN', 'NOT_RUN', 'MANUAL_REQUIRED'].includes(history.status) : false;
  const clean = history ? history.status !== 'FAIL' : null;
  const fields = { source: 'transparency_report_interim', raw_status: rec.raw_status, threat_types: rec.threat_types ?? [], hist1_clean: history ? final && clean : null, history_status: history?.status ?? null, evidence_url: evidenceUrl, checked_at: iso(checkedAt), note: note ?? null };
  const extra = { dataAsOf: checkedAt };
  if (sel.web_risk.unsafe_statuses.includes(rec.raw_status)) return outcome('FAIL', 'UNSAFE', `Web Risk status ${rec.raw_status} is an unsafe status`, fields, extra);
  if (sel.web_risk.safe_statuses.includes(rec.raw_status)) {
    if (!sel.web_risk.requires_clean_history) return outcome('PASS', null, null, fields, extra);
    if (!final) return outcome('UNKNOWN', 'HISTORY_NOT_FINAL', 'Status is safe but the history check is not final yet (unknown or not run): record again once HIST is decided', fields, extra);
    if (!clean) return outcome('UNKNOWN', 'HISTORY_NOT_CLEAN', 'Status is safe but the history check FAILED: a clean Web Risk status does not clear a harmful history', fields, extra);
    return outcome('PASS', null, null, fields, extra);
  }
  return outcome('UNKNOWN', 'STATUS_UNRECOGNISED', `Web Risk status ${rec.raw_status} is neither a safe nor an unsafe status in the settings`, fields, extra);
}

/**
 * Turns a recorded USPTO search into a result (CAP-08). A failed control query is never a clear result. When this item's history result
 * found a prior business, the record must list that name's phrase in `phrases_queried` (else UNKNOWN `PRIOR_NAME_NOT_QUERIED`); a live
 * mark on it (`prior_name_live`) is FAIL `TM_LIVE_MARK`, a TM-1 failure on the prior name, not a HIST-2 one.
 */
export function tmFromManual(rec: z.infer<typeof TmManual>, evidenceUrl: string, checkedAt: Date, note?: string, history?: ResultRow): CheckOutcome {
  const priorName = typeof history?.fields.prior_business_name === 'string' && history.fields.prior_business_name !== '' ? history.fields.prior_business_name : null;
  const priorPhrase = priorName === null ? null : priorPhraseOf(priorName);
  const fields = { ...rec, evidence_url: evidenceUrl, checked_at: iso(checkedAt), note: note ?? null, ...(priorName !== null && { prior_business_name: priorName, prior_business_phrase: priorPhrase }) };
  const extra = { dataAsOf: checkedAt };
  if (!rec.control_ok) return outcome('UNKNOWN', 'CONTROL_FAILED', 'The control query returned nothing: the search is broken, so no result is clear', fields, extra);
  if (priorPhrase && !rec.phrases_queried.map(phraseKey).includes(priorPhrase)) {
    return outcome('UNKNOWN', 'PRIOR_NAME_NOT_QUERIED', `A prior business used this name ("${priorName}") but its phrase "${priorPhrase}" is not in phrases_queried: the trademark search must cover it`, fields, extra);
  }
  if (rec.exact_or_core_live.length > 0) return outcome('FAIL', 'TM_LIVE_MARK', `Live mark on the exact or core phrase: ${rec.exact_or_core_live.map((m) => `${m.mark} (${m.serial}, ${m.owner})`).join('; ')}`, fields, extra);
  if ((rec.prior_name_live ?? []).length > 0) return outcome('FAIL', 'TM_LIVE_MARK', `Live mark on the prior business name "${priorName ?? ''}": ${rec.prior_name_live!.map((m) => `${m.mark} (${m.serial}, ${m.owner})`).join('; ')}`, fields, extra);
  if (rec.generic_live.length > 0) return outcome('FLAG', 'TM_GENERIC_HITS', `Live marks only on a generic phrase: ${rec.generic_live.map((m) => `${m.mark} (${m.serial})`).join('; ')}`, fields, extra);
  return outcome('PASS', null, null, fields, extra);
}

// ---- manual HIST-2 (CR-002 Amendment B) ----

export const HISTORY_RESULTS = ['PASS', 'REJECT_HARMFUL', 'FLAG_PRIOR_BUSINESS'] as const;
export const HISTORY_CATEGORIES = ['malware_phishing', 'spam', 'adult', 'scam', 'trademark_abuse'] as const;
/** A capture link of the Internet Archive: https://web.archive.org/web/<timestamp>[flags]/<original url>. */
export const ARCHIVE_URL_RE = /^https:\/\/web\.archive\.org\/web\/\d{4,14}[a-z_]{0,4}\/\S+$/;
const Year = z.number().int().min(1990).max(2100);

export const HistoryManual = z.object({
  result: z.enum(HISTORY_RESULTS),
  category: z.enum(HISTORY_CATEGORIES).optional(),
  prior_business_name: z.string().trim().min(1).max(200).optional(),
  first_capture_year: Year.optional(),
  last_capture_year: Year.optional(),
  evidence_urls: z.array(z.string().max(500).regex(ARCHIVE_URL_RE, 'a web.archive.org/web/<timestamp>/... capture link')).max(10).optional(),
  checked_by: z.string().trim().min(1).max(80),
}).strict().superRefine((r, ctx) => {
  if (r.result === 'REJECT_HARMFUL' && r.category === undefined) ctx.addIssue({ code: 'custom', path: ['category'], message: 'category is required for REJECT_HARMFUL' });
  if (r.result !== 'REJECT_HARMFUL' && r.category !== undefined) ctx.addIssue({ code: 'custom', path: ['category'], message: 'category is only for REJECT_HARMFUL' });
  if (r.result !== 'PASS' && (r.evidence_urls ?? []).length === 0) ctx.addIssue({ code: 'custom', path: ['evidence_urls'], message: `evidence_urls (at least one archive capture link) is required for ${r.result}` });
  if (r.first_capture_year !== undefined && r.last_capture_year !== undefined && r.last_capture_year < r.first_capture_year) ctx.addIssue({ code: 'custom', path: ['last_capture_year'], message: 'last_capture_year is before first_capture_year' });
});

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Turns a recorded HIST-2 into a history result with the SAME field shape as the automated check (derive, tier, ext_dates, source_lane
 * and tranche admission read it unchanged). PASS -> PASS; REJECT_HARMFUL -> FAIL HARMFUL_HISTORY with hist2_fail_class = category;
 * FLAG_PRIOR_BUSINESS -> FLAG PRIOR_BUSINESS_FLAGGED (a disclosed risk). The A1 guard runs on `prior_business_name` when given: a brand or
 * big-company hit FAILs (a BRAND-1 / BIGCO-1 failure, not a HIST-2 one), a missing list is UNKNOWN; the manual TM record must then
 * include that name's phrase (tmFromManual, PRIOR_NAME_NOT_QUERIED).
 *
 * prior_history: 1 when a capture year is given or the result is FLAG_PRIOR_BUSINESS (archive content existed before), otherwise null
 * (unknown, never 0: a human "no problem found" does not say the archive was empty). source_lane / com_prior_registration follow it:
 * prior_history 1 -> `expired_drop` / `yes`, otherwise `unknown`.
 */
export function historyFromManual(
  rec: z.infer<typeof HistoryManual>, lists: { brand: { version: number; terms: string[] } | null; bigco: { version: number; terms: string[] } | null },
  evidenceUrl: string, checkedAt: Date, note?: string,
): CheckOutcome {
  const flag = rec.result === 'FLAG_PRIOR_BUSINESS';
  const reject = rec.result === 'REJECT_HARMFUL';
  const priorHistory = rec.first_capture_year !== undefined || rec.last_capture_year !== undefined || flag ? 1 : null;
  const name = rec.prior_business_name ?? null;
  const years = rec.first_capture_year !== undefined && rec.last_capture_year !== undefined ? rec.last_capture_year - rec.first_capture_year : null;

  let guard: Record<string, unknown> | null = null;
  let guardIssue: { status: 'FAIL' | 'UNKNOWN'; code: string; reason: string } | null = null;
  if (name !== null) {
    const tokens = nameTokens(name);
    const none = tokens.map(() => false);
    const brand = lists.brand ? matchTerms(tokens, none, lists.brand.terms) : null;
    const bigco = lists.bigco ? matchTerms(tokens, none, lists.bigco.terms) : null;
    guard = { name, brand_hits: brand, bigco_hits: bigco, brand_list: lists.brand?.version ?? null, bigco_list: lists.bigco?.version ?? null, cap08_required: true, gate: 'G1', rules: ['BRAND-1', 'BIGCO-1'] };
    if (brand && brand.length > 0) guardIssue = { status: 'FAIL', code: 'PRIOR_BUSINESS_BRAND_HIT', reason: `The prior business name "${name}" is on the brand list (${brand.map((x) => x.term).join(', ')}); a BRAND-1 failure, not a HIST-2 one` };
    else if (bigco && bigco.length > 0) guardIssue = { status: 'FAIL', code: 'PRIOR_BUSINESS_BIGCO_HIT', reason: `The prior business name "${name}" is on the big-company list (${bigco.map((x) => x.term).join(', ')}); a BIGCO-1 failure, not a HIST-2 one` };
    else if (!brand || !bigco) guardIssue = { status: 'UNKNOWN', code: 'LIST_MISSING', reason: `No uploaded ${!brand ? 'brand' : 'bigco'} list: the prior business name cannot be checked (never a clean result)` };
  }

  const fields = {
    source: 'manual', manual: true, checked_by: rec.checked_by, checked_at: checkedAt.toISOString(), note: note ?? null, manual_result: rec.result,
    prior_history: priorHistory, pre_caps: null, first_capture: null, last_capture: null, first_capture_year: rec.first_capture_year ?? null, last_capture_year: rec.last_capture_year ?? null,
    pre_cls: reject ? 'harmful' : 'unknown', hist2: reject ? 'FAIL' : flag ? 'FLAG' : 'PASS', hist2_fail_class: reject ? rec.category ?? null : null,
    forsale: null, parked_only: null, captures: [] as unknown[], archive_span_yrs: years === null ? null : round1(years),
    prior_business_use: flag || name !== null ? 'yes' : 'unknown', prior_business_name: name, prior_business_years: name !== null && years !== null ? round1(years) : null,
    ...(guard && { prior_business_guard: guard }),
    source_lane: priorHistory === 1 ? 'expired_drop' : 'unknown', source_lane_inferred: true, com_prior_registration: priorHistory === 1 ? 'yes' : 'unknown',
    evidence_urls: rec.evidence_urls ?? (evidenceUrl ? [evidenceUrl] : []),
  };
  const extra = { dataAsOf: checkedAt };
  if (reject) return outcome('FAIL', 'HARMFUL_HISTORY', `Recorded by ${rec.checked_by}: harmful use of the name in the archive (${rec.category})`, fields, extra);
  if (guardIssue) return outcome(guardIssue.status, guardIssue.code, guardIssue.reason, fields, extra);
  if (flag) return outcome('FLAG', 'PRIOR_BUSINESS_FLAGGED', `Recorded by ${rec.checked_by}: a prior business used this name${name ? ` ("${name}")` : ''}; disclosed risk, the trademark search must cover it`, fields, extra);
  return outcome('PASS', null, null, fields, extra);
}
