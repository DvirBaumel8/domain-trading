// G8 other-extension creation dates (CAP-12, CR-002): how many other extensions of the same name were created strictly before the
// .com's creation date (re-registration / drop-catch signal; leakage rule: a later extension never counts). An extension whose RDAP
// is missing or fails is UNKNOWN for that extension, never "not registered".
import { lookupCached, rdapBaseFor, sharedPacer, type CachedLookup } from '../rdap-batch.js';
import { outcome, type Check } from '../types.js';
import { asOfOf } from './census.js';

interface ExtRow { tld: string; status: 'registered' | 'not_registered' | 'unknown'; created_at: string | null; reason_code?: string; counted?: boolean }

export const extDatesCheck: Check = {
  id: 'ext_dates',
  gate: 'G8',
  ruleIds: ['CAP-12'],
  lists: [],
  async run(ctx) {
    const nul = { alt_tld_before_n: null, com_prior_registration: 'unknown', n_unknown_ext: null };
    if (!ctx.settings.sources.rdap_other) return outcome('UNKNOWN', 'SOURCE_DISABLED', 'The other-extension RDAP source is switched off (sources.rdap_other)', nul);
    if (ctx.run.backtest && !ctx.item.as_of) return outcome('UNKNOWN', 'AS_OF_REQUIRED', 'A backtest or holdout run needs an as_of for every name', nul);
    const availability = ctx.latest('availability');
    const comCreated = availability?.fields.availability === 'registered' && typeof availability.fields.created_at === 'string' ? availability.fields.created_at : null;
    const { asOf } = asOfOf(ctx);
    const comparison = comCreated ? new Date(comCreated) : asOf;
    const sld = ctx.item.domain.replace(/\.com$/, '');
    const prior = ctx.latest('history')?.fields.prior_history;
    const comPrior = prior === 1 ? 'yes' : prior === 0 ? 'no' : 'unknown';
    const pace = sharedPacer(ctx);
    const list = ctx.settings.ext.list;
    let calls = 0;
    const evidence: number[] = [];

    const rows: ExtRow[] = [];
    for (const tld of list) {
      if (ctx.now() > ctx.deadline) { rows.push({ tld, status: 'unknown', created_at: null, reason_code: 'TIMEOUT' }); continue; }
      let base: string | null;
      try {
        base = await rdapBaseFor(ctx.db, ctx.deps, tld, { enabled: ctx.settings.sources.iana_bootstrap || tld === 'com', now: ctx.now });
      } catch (e) {
        rows.push({ tld, status: 'unknown', created_at: null, reason_code: 'SOURCE_ERROR' });
        continue;
      }
      if (base === null) { rows.push({ tld, status: 'unknown', created_at: null, reason_code: ctx.settings.sources.iana_bootstrap ? 'NO_REGISTRY_SERVICE' : 'SOURCE_DISABLED' }); continue; }
      const r: CachedLookup = await lookupCached(ctx.db, ctx.deps, `${sld}.${tld}`, { maxAgeHours: ctx.settings.freshness_hours.ext_dates ?? 0, baseUrl: base, evidenceMaxBytes: ctx.settings.evidence.max_text_bytes, pace, now: ctx.now });
      if (!r.cached) calls++;
      if (r.evidenceId !== null) evidence.push(r.evidenceId);
      if (r.outcome === 'unknown') rows.push({ tld, status: 'unknown', created_at: null, reason_code: r.reasonCode ?? 'SOURCE_ERROR' });
      else if (r.outcome === 'not_registered') rows.push({ tld, status: 'not_registered', created_at: null });
      else rows.push({ tld, status: 'registered', created_at: r.facts?.created_at ?? null });
    }

    let before = 0, undatedExcluded = 0;
    for (const r of rows) {
      if (r.status !== 'registered') continue;
      if (r.created_at === null) { undatedExcluded++; r.counted = false; continue; }
      r.counted = Date.parse(r.created_at) < comparison.getTime();
      if (r.counted) before++;
    }
    const nUnknown = rows.filter((r) => r.status === 'unknown').length;
    const fields = {
      extensions: rows, as_of: asOf.toISOString(), comparison_date: comparison.toISOString(), comparison_basis: comCreated ? 'com_created_at' : 'as_of',
      com_prior_registration: comPrior, n_unknown_ext: nUnknown, undated_excluded_n: undatedExcluded,
    };
    const extra = { upstreamCalls: calls, evidenceIds: evidence, dataAsOf: new Date(ctx.now()) };
    if (list.length > 0 && nUnknown === list.length) {
      return outcome('UNKNOWN', 'ALL_EXT_UNKNOWN', 'No other extension could be checked', { ...fields, alt_tld_before_n: null }, extra);
    }
    return outcome('PASS', null, null, { ...fields, alt_tld_before_n: before }, extra);
  },
};
