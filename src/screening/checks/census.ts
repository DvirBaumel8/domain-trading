// G8 sibling registered-share census (CAP-10, CR-002): of the frozen census list's 20 siblings, the share that are registered.
// A sibling counts only if its RDAP creation date is strictly before `as_of` (unknown date: counted and `as_of_exact` false).
// More than `census.max_unknown_share` unknown siblings makes the share UNKNOWN: an error is never read as "not registered".
import { listVersion } from '../lists.js';
import { lookupCached, sharedPacer, type CachedLookup } from '../rdap-batch.js';
import { outcome, type Check, type CheckContext } from '../types.js';

const REF = /^([a-z0-9_]{3,64})(?:@v(\d+))?$/;
const DAY_MS = 86_400_000;

/** The instant a dated input is read as of: the item's `as_of`, else now. AS_OF_REQUIRED is the caller's job in a backtest. */
export function asOfOf(ctx: CheckContext): { asOf: Date; explicit: boolean } {
  return ctx.item.as_of ? { asOf: new Date(ctx.item.as_of), explicit: true } : { asOf: new Date(ctx.now()), explicit: false };
}

export const censusCheck: Check = {
  id: 'census',
  gate: 'G8',
  ruleIds: ['DEMAND-2'],
  lists: [],
  async run(ctx) {
    const nul = { registered_share: null, in_use_share: null };
    if (!ctx.settings.sources.rdap_com) return outcome('UNKNOWN', 'SOURCE_DISABLED', 'The .com RDAP source is switched off (sources.rdap_com)', nul);
    if (ctx.run.backtest && !ctx.item.as_of) return outcome('UNKNOWN', 'AS_OF_REQUIRED', 'A backtest or holdout run needs an as_of for every name', nul);
    const ref = ctx.item.census_list ? REF.exec(ctx.item.census_list) : null;
    if (!ref) return outcome('UNKNOWN', 'CENSUS_LIST_MISSING', ctx.item.census_list ? `"${ctx.item.census_list}" is not a census list reference (name or name@vN)` : 'The name has no census_list', nul);
    const row = await listVersion(ctx.db, ref[1]!, ref[2] === undefined ? undefined : Number(ref[2]));
    if (!row) return outcome('UNKNOWN', 'CENSUS_LIST_MISSING', `Census list ${ctx.item.census_list} does not exist`, nul);
    const listName = `${row.name}@v${row.version}`;
    const size = ctx.settings.census.sibling_count;
    if (row.terms.length !== size) return outcome('UNKNOWN', 'CENSUS_LIST_SIZE', `Census list ${listName} has ${row.terms.length} names, not ${size}`, { ...nul, list: listName });

    const { asOf } = asOfOf(ctx);
    const pace = sharedPacer(ctx);
    const results: CachedLookup[] = [];
    let calls = 0;
    await Promise.all(row.terms.map(async (d, i) => {
      if (ctx.now() > ctx.deadline) {
        results[i] = { outcome: 'unknown', reasonCode: 'TIMEOUT', httpStatus: null, url: '', retrievedAt: new Date(ctx.now()), body: null, facts: null, cached: false, evidenceId: null };
        return;
      }
      const r = await lookupCached(ctx.db, ctx.deps, d, { maxAgeHours: ctx.settings.freshness_hours.census ?? 0, evidenceMaxBytes: ctx.settings.evidence.max_text_bytes, pace, now: ctx.now });
      if (!r.cached) calls++;
      results[i] = r;
    }));

    let nRegistered = 0, nUnknown = 0, undated = 0, after = 0;
    const siblings = row.terms.map((d, i) => {
      const r = results[i]!;
      if (r.outcome === 'unknown') { nUnknown++; return { domain: d, status: 'unknown', created_at: null, counted: false, reason_code: r.reasonCode }; }
      if (r.outcome === 'not_registered') return { domain: d, status: 'not_registered', created_at: null, counted: false };
      const created = r.facts?.created_at ?? null;
      if (created === null) { nRegistered++; undated++; return { domain: d, status: 'registered', created_at: null, counted: true }; }
      if (Date.parse(created) < asOf.getTime()) { nRegistered++; return { domain: d, status: 'registered', created_at: created, counted: true }; }
      after++;
      return { domain: d, status: 'registered', created_at: created, counted: false };
    });
    const asOfExact = undated === 0 && ctx.now() - asOf.getTime() <= ctx.settings.census.as_of_exact_max_days * DAY_MS;
    const nChecked = row.terms.length;
    const fields = {
      list: listName, as_of: asOf.toISOString(), as_of_exact: asOfExact, n_registered: nRegistered, n_checked: nChecked, n_unknown: nUnknown,
      registered_after_as_of_n: after, undated_counted_n: undated, undated_excluded_n: 0, siblings, in_use_share: null,
    };
    const extra = { upstreamCalls: calls, evidenceIds: [...new Set(results.map((r) => r.evidenceId).filter((x): x is number => x !== null))], dataAsOf: new Date(Math.min(...results.map((r) => r.retrievedAt.getTime()))) };
    if (nUnknown / nChecked > ctx.settings.census.max_unknown_share) {
      return outcome('UNKNOWN', 'TOO_MANY_UNKNOWN', `${nUnknown} of ${nChecked} siblings could not be checked (limit ${Math.round(ctx.settings.census.max_unknown_share * 100)}%)`, { ...fields, registered_share: null }, extra);
    }
    return outcome('PASS', null, null, { ...fields, registered_share: nRegistered / nChecked }, extra);
  },
};
