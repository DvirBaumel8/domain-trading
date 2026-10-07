// G8 other-extension creation dates (CAP-12, CR-002): how many other extensions of the same name were created strictly before the
// .com's creation date (re-registration / drop-catch signal; leakage rule: a later extension never counts). An extension whose RDAP
// is missing or fails is UNKNOWN for that extension, never "not registered".
import { lookupCached, pacerFor, rdapBaseFor, type CachedLookup } from '../rdap-batch.js';
import { outcome, type Check, type CheckContext } from '../types.js';
import { asOfOf } from './census.js';

export interface ExtRegistration { tld: string; status: 'registered' | 'not_registered' | 'unknown'; created_at: string | null; reason_code?: string; evidenceId: number | null; cached: boolean; /** true when a registry query was made or attempted (counts toward upstream_calls when not cached). */ upstream: boolean }

/**
 * Is `<sld>.<tld>` registered, from RDAP (the IANA bootstrap gives the base; `.com` is Verisign). A missing base, a timeout or any
 * failure is `unknown` with a reason code, never "not registered". Shared by `ext_dates` and `same_name`.
 */
export async function extRegistration(ctx: CheckContext, sld: string, tld: string): Promise<ExtRegistration> {
  const unk = (reason_code: string, upstream = false): ExtRegistration => ({ tld, status: 'unknown', created_at: null, reason_code, evidenceId: null, cached: false, upstream });
  if (ctx.now() > ctx.deadline) return unk('TIMEOUT');
  let base: string | null;
  try {
    base = await rdapBaseFor(ctx.db, ctx.deps, tld, { enabled: ctx.settings.sources.iana_bootstrap || tld === 'com', now: ctx.now });
  } catch (e) {
    return unk('SOURCE_ERROR');
  }
  if (base === null) return unk(ctx.settings.sources.iana_bootstrap ? 'NO_REGISTRY_SERVICE' : 'SOURCE_DISABLED');
  const r: CachedLookup = await lookupCached(ctx.db, ctx.deps, `${sld}.${tld}`, { maxAgeHours: ctx.settings.freshness_hours.ext_dates ?? 0, baseUrl: base, evidenceMaxBytes: ctx.settings.evidence.max_text_bytes, pace: pacerFor(ctx, base), now: ctx.now, deadline: ctx.deadline });
  const common = { tld, evidenceId: r.evidenceId, cached: r.cached, upstream: true };
  if (r.outcome === 'unknown') return { ...common, status: 'unknown', created_at: null, reason_code: r.reasonCode ?? 'SOURCE_ERROR' };
  if (r.outcome === 'not_registered') return { ...common, status: 'not_registered', created_at: null };
  return { ...common, status: 'registered', created_at: r.facts?.created_at ?? null };
}

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
    // The earlier of the two: an extension created after as_of never counts, whatever the .com's own date (leakage rule).
    const comparison = comCreated && Date.parse(comCreated) < asOf.getTime() ? new Date(comCreated) : asOf;
    const sld = ctx.item.domain.replace(/\.com$/, '');
    // CAP-12: was the .com itself registered before? The history result decides (captures before the current registration); an older
    // or stand-in history result that only carries `prior_history` is read the same way.
    const hist = ctx.latest('history')?.fields;
    const histPrior = hist?.com_prior_registration;
    const comPrior = histPrior === 'yes' || histPrior === 'no' ? histPrior : hist?.prior_history === 1 ? 'yes' : hist?.prior_history === 0 ? 'no' : 'unknown';
    // CR-008 C-1: `ext.alt_list` (when the version has one) is the only list this feature counts; an absent key reads `ext.list`.
    const list = ctx.settings.ext.alt_list ?? ctx.settings.ext.list;
    let calls = 0;
    const evidence: number[] = [];

    const rows: ExtRow[] = [];
    for (const tld of list) {
      const r = await extRegistration(ctx, sld, tld);
      if (!r.cached && r.upstream) calls++;
      if (r.evidenceId !== null) evidence.push(r.evidenceId);
      rows.push(r.status === 'unknown' ? { tld, status: 'unknown', created_at: null, reason_code: r.reason_code ?? 'SOURCE_ERROR' } : { tld, status: r.status, created_at: r.created_at });
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
      extensions: rows, as_of: asOf.toISOString(), comparison_date: comparison.toISOString(), comparison_basis: comparison === asOf ? 'as_of' : 'com_created_at',
      com_prior_registration: comPrior, n_unknown_ext: nUnknown, undated_excluded_n: undatedExcluded,
    };
    const extra = { upstreamCalls: calls, evidenceIds: evidence, dataAsOf: new Date(ctx.now()) };
    if (list.length > 0 && nUnknown === list.length) {
      return outcome('UNKNOWN', 'ALL_EXT_UNKNOWN', 'No other extension could be checked', { ...fields, alt_tld_before_n: null }, extra);
    }
    return outcome('PASS', null, null, { ...fields, alt_tld_before_n: before }, extra);
  },
};
