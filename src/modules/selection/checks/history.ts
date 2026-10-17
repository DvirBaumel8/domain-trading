// G6 history (CAP-07, HIST-2 + prior-business guard; CR-002 CAP-07 and Amendments A1/A2/A5/B1): what the Internet Archive says the name
// was used for BEFORE the current registration. Dvir, 6 Oct 2026 (and "Stop it", 14 Oct): the archive is never automated. The name waits
// for a human HIST-2 record (POST /screening/runs/{id}/manual, check "history", or a fresh kept record per CR-012 part E); without one it
// is MANUAL_REQUIRED and cannot join a tranche. Prior history is a positive signal; only harmful use rejects (manual.ts converts the record).
import { outcome, type Check } from '../types.js';
import { freshDomainRecord } from '../domain-records.js';
import { HistoryManual, historyFromManual } from './manual.js';
import { asOfOf } from './census.js';

const NUL = {
  prior_history: null, pre_caps: null, first_capture: null, last_capture: null, pre_cls: 'unknown', hist2: 'UNKNOWN', hist2_fail_class: null,
  prior_business_use: 'unknown', prior_business_name: null, prior_business_years: null, archive_span_yrs: null, source_lane: 'unknown',
  source_lane_inferred: true, com_prior_registration: 'unknown', forsale: null, parked_only: null, captures: [] as unknown[], evidence_urls: [] as string[],
};

export const historyCheck: Check = {
  id: 'history',
  gate: 'G6',
  ruleIds: ['HIST-2'],
  lists: ['brand', 'bigco'],
  async run(ctx) {
    const domain = ctx.item.domain;
    const { asOf } = asOfOf(ctx);
    // CR-012 part E: a fresh record kept for this name is used exactly as a manual HIST-2 record would be (same conversion and prior-business guard); stale = missing.
    // Not in a backtest.
    if (!ctx.run.backtest) {
      const rec = await freshDomainRecord(ctx.db, domain, 'history', ctx.now());
      const parsed = rec ? HistoryManual.safeParse(rec.record) : null;
      if (rec && parsed?.success) {
        const o = historyFromManual(parsed.data, { brand: ctx.lists.brand ?? null, bigco: ctx.lists.bigco ?? null }, parsed.data.evidence_urls?.[0] ?? rec.evidenceUrl ?? `manual:history:${domain}`, rec.checkedAt, rec.note ?? undefined);
        return { ...o, fields: { ...o.fields, domain_record_id: rec.id } };
      }
    }
    return outcome('MANUAL_REQUIRED', 'MANUAL_SOURCE', 'The Internet Archive is not automated: look the name up by hand and record HIST-2. Record the result with POST /screening/runs/{id}/manual (check "history")', {
      ...NUL, as_of: asOf.toISOString(), lookup_name: domain, results: ['PASS', 'REJECT_HARMFUL', 'FLAG_PRIOR_BUSINESS'], archive_url: `https://web.archive.org/web/*/${domain}`,
    });
  },
};
