// G5 Web Risk (CAP-06) and G7 US trademark (CAP-08): no official automated source is enabled (CR-001 §11 P-2: DOM does not use
// undocumented website endpoints), so the run answers MANUAL_REQUIRED and a human result is recorded with
// POST /screening/runs/{id}/manual. The record is turned into a status here, by the settings' rules.
import { z } from 'zod';
import type { SelectionValuesT } from '../settings.js';
import { outcome, type Check, type CheckOutcome, type ResultRow } from '../types.js';
import { formFieldsOf } from './form.js';

export const MANUAL_CHECKS = ['web_risk', 'tm_us'] as const;
export type ManualCheckId = (typeof MANUAL_CHECKS)[number];

export const WebRiskManual = z.object({ raw_status: z.number().int(), threat_types: z.array(z.string().max(80)).max(20).optional() }).strict();
const Mark = z.object({ mark: z.string().max(200), serial: z.string().max(40), owner: z.string().max(200), status: z.string().max(100) }).strict();
export const TmManual = z.object({
  phrases_queried: z.array(z.string().min(1).max(200)).min(1).max(30),
  control_ok: z.boolean(),
  exact_or_core_live: z.array(Mark).max(50),
  generic_live: z.array(Mark).max(50),
  dead_n: z.number().int().nonnegative().optional(),
}).strict();

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
    const priorPhrase = priorName === null ? null : priorName.toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (priorPhrase && !phrases.includes(priorPhrase)) phrases.push(priorPhrase);
    return outcome('MANUAL_REQUIRED', 'MANUAL_SOURCE', `The USPTO wordmark search is not automated: search these phrases (plus the control query) and record it. ${HOW}`, {
      phrases_to_query: phrases, control_required: true, ...(priorName !== null && { prior_business_name: priorName, prior_business_phrase: priorPhrase }),
    });
  },
};

const iso = (d: Date) => d.toISOString();

/** Turns a recorded Web Risk lookup into a result (CAP-06 interim rule; the history requirement is a setting). */
export function webRiskFromManual(rec: z.infer<typeof WebRiskManual>, sel: SelectionValuesT, history: ResultRow | undefined, evidenceUrl: string, checkedAt: Date, note?: string): CheckOutcome {
  const histClean = history ? history.status === 'PASS' || history.status === 'PASS_WITH_NOTE' : null;
  const fields = { source: 'transparency_report_interim', raw_status: rec.raw_status, threat_types: rec.threat_types ?? [], hist1_clean: histClean, evidence_url: evidenceUrl, checked_at: iso(checkedAt), note: note ?? null };
  const extra = { dataAsOf: checkedAt };
  if (sel.web_risk.unsafe_statuses.includes(rec.raw_status)) return outcome('FAIL', 'UNSAFE', `Web Risk status ${rec.raw_status} is an unsafe status`, fields, extra);
  if (sel.web_risk.safe_statuses.includes(rec.raw_status)) {
    if (!sel.web_risk.requires_clean_history || histClean) return outcome('PASS', null, null, fields, extra);
    return outcome('UNKNOWN', 'HISTORY_NOT_FINAL', 'Status is safe but the history check is not a final PASS yet: record again once HIST is decided', fields, extra);
  }
  return outcome('UNKNOWN', 'STATUS_UNRECOGNISED', `Web Risk status ${rec.raw_status} is neither a safe nor an unsafe status in the settings`, fields, extra);
}

/** Turns a recorded USPTO search into a result (CAP-08). A failed control query is never a clear result. */
export function tmFromManual(rec: z.infer<typeof TmManual>, evidenceUrl: string, checkedAt: Date, note?: string): CheckOutcome {
  const fields = { ...rec, evidence_url: evidenceUrl, checked_at: iso(checkedAt), note: note ?? null };
  const extra = { dataAsOf: checkedAt };
  if (!rec.control_ok) return outcome('UNKNOWN', 'CONTROL_FAILED', 'The control query returned nothing: the search is broken, so no result is clear', fields, extra);
  if (rec.exact_or_core_live.length > 0) return outcome('FAIL', 'TM_LIVE_MARK', `Live mark on the exact or core phrase: ${rec.exact_or_core_live.map((m) => `${m.mark} (${m.serial}, ${m.owner})`).join('; ')}`, fields, extra);
  if (rec.generic_live.length > 0) return outcome('FLAG', 'TM_GENERIC_HITS', `Live marks only on a generic phrase: ${rec.generic_live.map((m) => `${m.mark} (${m.serial})`).join('; ')}`, fields, extra);
  return outcome('PASS', null, null, fields, extra);
}

