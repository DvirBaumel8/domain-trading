// G8 lookalikes (CR-043, G-70): the same words on other endings (net, org, io, co, ai, co.uk), hyphenated at the word boundaries of the best split,
// and get<sld>.com / try<sld>.com. Each name: is it registered (RDAP only, never system DNS; an ending with no RDAP service is `null`, never guessed),
// and for a registered one, is its home page in use (a paced, robots-aware, size-capped fetch through the outbound guard; parked or for-sale pages
// are not in use). A feature check: it always answers PASS (or UNKNOWN when it cannot run); it never FAILs or FLAGs a name, so verdicts do not change.
import { fetchPage, classifySite } from '../site.js';
import { lookupCached, pacerFor, rdapBaseFor } from '../rdap-batch.js';
import { sharedPacer, sharedRobots } from '../sellers.js';
import { outcome, type Check, type CheckContext } from '../types.js';
import { formFieldsOf } from './form.js';

export type LookalikeKind = 'ending' | 'hyphen' | 'prefix';
export interface LookalikeName { domain: string; kind: LookalikeKind }
export interface LookalikeItem { domain: string; kind: LookalikeKind; registered: boolean | null; in_use: boolean | null; reason_code: string | null }

/** The names to check, in priority order, de-duplicated and never our own name. Pure. */
export function lookalikeNames(sld: string, tokens: string[], s: { endings: string[]; prefixes: string[] }): LookalikeName[] {
  const out: LookalikeName[] = [];
  const seen = new Set<string>([`${sld}.com`]);
  const add = (domain: string, kind: LookalikeKind): void => { if (!seen.has(domain)) { seen.add(domain); out.push({ domain, kind }); } };
  for (const e of s.endings) add(`${sld}.${e}`, 'ending');
  if (tokens.length >= 2 && tokens.join('') === sld) {
    add(`${tokens.join('-')}.com`, 'hyphen');
    // three words: each single boundary too (a-bc, ab-c); more words: the full hyphenated form only
    if (tokens.length === 3) for (let i = 1; i < 3; i++) add(`${tokens.slice(0, i).join('')}-${tokens.slice(i).join('')}.com`, 'hyphen');
  }
  for (const p of s.prefixes) add(`${p}${sld}.com`, 'prefix');
  return out;
}

const NUL = { lookalikes: { registered_n: null, in_use_n: null, unknown_n: null, items: [] as LookalikeItem[] } };

export const lookalikesCheck: Check = {
  id: 'lookalikes',
  gate: 'G8',
  ruleIds: ['G-70', 'CR-043'],
  lists: ['sig_parked', 'sig_forsale'],
  async run(ctx: CheckContext) {
    const cfg = ctx.settings.lookalikes;
    if (ctx.run.mode === 'full' && ctx.item.as_of !== undefined) return outcome('UNKNOWN', 'AS_OF_NOT_SUPPORTED', "Today's registrations and sites cannot be read as of a past date", NUL);
    const sld = ctx.item.domain.replace(/\.com$/, '');
    const all = lookalikeNames(sld, formFieldsOf(ctx).tokens, cfg);
    const names = all.slice(0, cfg.max_checks);
    const lists = ctx.lists.sig_parked && ctx.lists.sig_forsale ? { parked: ctx.lists.sig_parked.terms, forsale: ctx.lists.sig_forsale.terms } : null;
    const pace = sharedPacer(ctx);
    const robots = sharedRobots(ctx);
    const maxAgeHours = ctx.settings.freshness_hours.lookalikes ?? ctx.settings.freshness_hours.ext_dates ?? 0;
    let calls = 0;
    const evidence: number[] = [];
    const items: LookalikeItem[] = [];

    for (const n of names) {
      const item: LookalikeItem = { domain: n.domain, kind: n.kind, registered: null, in_use: null, reason_code: null };
      items.push(item);
      if (ctx.now() > ctx.deadline || ctx.isCancelled?.()) { item.reason_code = 'TIMEOUT'; continue; }
      const tld = n.domain.slice(n.domain.lastIndexOf('.') + 1); // the registry label: co.uk is asked at uk
      const sourceOn = tld === 'com' ? ctx.settings.sources.rdap_com : ctx.settings.sources.rdap_other;
      if (!sourceOn) { item.reason_code = 'SOURCE_DISABLED'; continue; }
      let base: string | null;
      try {
        base = await rdapBaseFor(ctx.db, ctx.deps, tld, { enabled: ctx.settings.sources.iana_bootstrap || tld === 'com', now: ctx.now });
      } catch {
        item.reason_code = 'SOURCE_ERROR';
        continue;
      }
      if (base === null) { item.reason_code = 'NO_REGISTRY_SERVICE'; continue; }
      const r = await lookupCached(ctx.db, ctx.deps, n.domain, {
        maxAgeHours, baseUrl: base, evidenceMaxBytes: ctx.settings.evidence.max_text_bytes, pace: pacerFor(ctx, base), now: ctx.now, deadline: ctx.deadline, isCancelled: ctx.isCancelled,
      });
      if (!r.cached && r.reasonCode !== 'TIMEOUT') calls++;
      if (r.evidenceId !== null) evidence.push(r.evidenceId);
      if (r.outcome === 'unknown') { item.reason_code = r.reasonCode ?? 'SOURCE_ERROR'; continue; }
      if (r.outcome === 'not_registered') { item.registered = false; continue; }
      item.registered = true;
      // The home page of a registered lookalike.
      if (!ctx.settings.sources.business_sites) { item.reason_code = 'SOURCE_DISABLED'; continue; }
      if (!lists) { item.reason_code = 'LIST_MISSING'; continue; }
      if (ctx.now() > ctx.deadline) { item.reason_code = 'TIMEOUT'; continue; }
      const s = ctx.settings.same_name;
      const page = await fetchPage({ fetch: ctx.deps.siteFetch, lookupHost: ctx.deps.lookupHost }, `https://${n.domain}/`, {
        timeoutMs: cfg.timeout_ms, maxBytes: cfg.max_bytes, maxRedirects: s.max_redirects, pace, robots, neverFetchHosts: ctx.settings.lead.verify.never_fetch_hosts,
        deadline: ctx.deadline, now: ctx.now, onRequest: () => { calls++; }, truncatedOk: true,
      });
      const c = classifySite(page, n.domain, ctx.item.domain, [], lists, s);
      if (c.site_state === 'in_use') item.in_use = true;
      else if (c.site_state === 'parked_or_for_sale' || c.site_state === 'registered_no_site') item.in_use = false;
      else item.reason_code = c.reason_code ?? c.site_state; // redirect_off_domain, unknown: not guessed
    }

    const registered = items.filter((i) => i.registered === true);
    const fields = {
      lookalikes: {
        registered_n: registered.length,
        in_use_n: items.filter((i) => i.in_use === true).length,
        // not fully determined: RDAP could not answer, or a registered name whose page could not be read
        unknown_n: items.filter((i) => i.registered === null || (i.registered === true && i.in_use === null)).length,
        items,
      },
      checked_n: items.length, skipped_n: all.length - names.length,
    };
    return outcome('PASS', null, null, fields, { upstreamCalls: calls, evidenceIds: evidence, dataAsOf: new Date(ctx.now()) });
  },
};
