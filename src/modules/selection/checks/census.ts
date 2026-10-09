// G8 sibling registered-share census (CAP-10, CR-002): of the frozen census list's 20 siblings, the share that are registered.
// A sibling counts only if its RDAP creation date is strictly before `as_of` (unknown date: counted and `as_of_exact` false).
// More than `census.max_unknown_share` unknown siblings makes the share UNKNOWN: an error is never read as "not registered".
import { isCensusListName } from '../lists.js';
import { methodApproval } from '../sibling-methods.js';
import { isKnownMethod, siblingsBt1, usesSplitV2 } from '../siblings.js';
import { splitV2OfDomain } from '../split-v2.js';
import { formFieldsOf } from './form.js';
import { answerPolicy, lookupCached, pacerFor, prefetchStored, type CachedLookup } from '../rdap-batch.js';
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
    let listName: string;
    let listTerms: string[];
    const extraFields: Record<string, unknown> = {};
    if (ctx.item.census_list && isKnownMethod(ctx.item.census_list)) {
      // CR-008 C-2: a frozen sibling method builds the 20 siblings from the name's own word split, once Dvir approved the method version.
      const method = ctx.item.census_list;
      if (!ctx.run.allowUnapprovedMethod && !(await methodApproval(ctx.db, method))) return outcome('UNKNOWN', 'CENSUS_METHOD_NOT_APPROVED', `Sibling method ${method} has no approval recorded (POST /selection/sibling-methods/${method}/approve)`, { ...nul, list: method });
      const tokens = ctx.item.words ?? (usesSplitV2(method) ? splitV2OfDomain(ctx.item.domain, method) : formFieldsOf(ctx).tokens); // v3.3.0 (CR-022 A): a scout's words win
      listTerms = siblingsBt1(tokens).map((l) => `${l}.com`);
      listName = method;
      extraFields.sibling_tokens = tokens;
    } else {
      const ref = ctx.item.census_list ? REF.exec(ctx.item.census_list) : null;
      if (!ref) return outcome('UNKNOWN', 'CENSUS_LIST_MISSING', ctx.item.census_list ? `"${ctx.item.census_list}" is not a census list reference (name or name@vN)` : 'The name has no census_list', nul);
      const name = ref[1]!;
      if (!isCensusListName(name)) return outcome('UNKNOWN', 'CENSUS_LIST_MISSING', `"${name}" is not a census list name`, nul);
      let q = ctx.db.selectFrom('selection_lists').select(['name', 'version', 'terms', 'approval_text']).where('name', '=', name);
      q = ref[2] === undefined ? q.orderBy('version', 'desc').limit(1) : q.where('version', '=', Number(ref[2]));
      const row = await q.executeTakeFirst();
      if (!row) return outcome('UNKNOWN', 'CENSUS_LIST_MISSING', `Census list ${ctx.item.census_list} does not exist`, nul);
      if (!row.approval_text) return outcome('UNKNOWN', 'CENSUS_LIST_MISSING', `Census list ${name}@v${row.version} is not frozen (no approval recorded)`, nul);
      // bt1_<sld> belongs to that name; the shared pattern lists (s6_regime_audit) are frozen for several names and carry no single owner.
      const sld = ctx.item.domain.replace(/\.com$/, '');
      if (name.startsWith('bt1_') && name !== `bt1_${sld}`) return outcome('UNKNOWN', 'CENSUS_LIST_MISMATCH', `Census list ${name} belongs to ${name.slice(4)}.com, not ${ctx.item.domain}`, nul);
      listName = `${row.name}@v${row.version}`;
      listTerms = row.terms;
    }
    const terms = listTerms;
    const size = ctx.settings.census.sibling_count;
    if (terms.length !== size) return outcome('UNKNOWN', 'CENSUS_LIST_SIZE', `Census list ${listName} has ${terms.length} names, not ${size}`, { ...nul, list: listName, size: terms.length, ...extraFields });

    const { asOf, explicit } = asOfOf(ctx);
    const pace = pacerFor(ctx);
    const results: CachedLookup[] = [];
    let calls = 0;
    const policy = answerPolicy(ctx, 'census');
    // One query reads every stored answer of the 20 siblings; a stored answer never waits in the pacer.
    const prefetched = await prefetchStored(ctx.db, terms, { ...policy, now: ctx.now });
    await Promise.all(terms.map(async (d, i) => {
      const r = await lookupCached(ctx.db, ctx.deps, d, { ...policy, prefetched, evidenceMaxBytes: ctx.settings.evidence.max_text_bytes, pace, now: ctx.now, deadline: ctx.deadline, isCancelled: ctx.isCancelled });
      if (!r.cached && r.reasonCode !== 'TIMEOUT') calls++;
      results[i] = r;
    }));
    const rateLimited = results.reduce((n, r) => n + r.rateLimited, 0);

    let nRegistered = 0, nUnknown = 0, undated = 0, after = 0;
    const siblings = terms.map((d, i) => {
      const r = results[i]!;
      const prov = { checked_at: r.checkedAt.toISOString(), reused: r.cached, source: r.source };
      if (r.outcome === 'unknown') { nUnknown++; return { domain: d, status: 'unknown', created_at: null, counted: false, reason_code: r.reasonCode, ...prov }; }
      if (r.outcome === 'not_registered') return { domain: d, status: 'not_registered', created_at: null, counted: false, ...prov };
      const created = r.facts?.created_at ?? null;
      if (created === null) {
        // Registered, creation date unknown: with an explicit as_of it cannot be placed before or after it (A2): out of numerator and denominator.
        if (explicit) { undated++; return { domain: d, status: 'registered', created_at: null, counted: false, reason_code: 'UNDATED', ...prov }; }
        nRegistered++;
        return { domain: d, status: 'registered', created_at: null, counted: true, ...prov };
      }
      if (Date.parse(created) < asOf.getTime()) { nRegistered++; return { domain: d, status: 'registered', created_at: created, counted: true, ...prov }; }
      after++;
      return { domain: d, status: 'registered', created_at: created, counted: false, ...prov };
    });
    const asOfExact = ctx.now() - asOf.getTime() <= ctx.settings.census.as_of_exact_max_days * DAY_MS;
    const total = terms.length;
    const nChecked = total - undated;
    // Nothing countable (every sibling undated) is no evidence at all: UNKNOWN, never 0 of 0 read as a share.
    if (nChecked === 0) return outcome('UNKNOWN', 'TOO_MANY_UNKNOWN', `All ${total} siblings are undated: no registered share can be computed`, { list: listName, ...extraFields, as_of: asOf.toISOString(), as_of_exact: asOfExact, n_registered: 0, n_checked: 0, n_unknown: nUnknown, registered_after_as_of_n: after, undated_excluded_n: undated, rate_limited_n: rateLimited, siblings, in_use_share: null, registered_share: null }, { upstreamCalls: calls, evidenceIds: [...new Set(results.map((r) => r.evidenceId).filter((x): x is number => x !== null))], dataAsOf: new Date(Math.min(...results.map((r) => r.retrievedAt.getTime()))) });
    const fields = {
      list: listName, ...extraFields, as_of: asOf.toISOString(), as_of_exact: asOfExact, n_registered: nRegistered, n_checked: nChecked, n_unknown: nUnknown,
      registered_after_as_of_n: after, undated_excluded_n: undated, rate_limited_n: rateLimited, siblings, in_use_share: null,
    };
    const extra = { upstreamCalls: calls, evidenceIds: [...new Set(results.map((r) => r.evidenceId).filter((x): x is number => x !== null))], dataAsOf: new Date(Math.min(...results.map((r) => r.retrievedAt.getTime()))) };
    if ((nUnknown + undated) / total > ctx.settings.census.max_unknown_share) {
      return outcome('UNKNOWN', 'TOO_MANY_UNKNOWN', `${nUnknown + undated} of ${total} siblings could not be checked or dated (limit ${Math.round(ctx.settings.census.max_unknown_share * 100)}%)`, { ...fields, registered_share: null }, extra);
    }
    return outcome('PASS', null, null, { ...fields, registered_share: nRegistered / nChecked }, extra);
  },
};
