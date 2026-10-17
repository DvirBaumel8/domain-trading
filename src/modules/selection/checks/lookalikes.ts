// G8 lookalikes (CR-043, G-70): the same words on other endings (net, org, io, co, ai, co.uk), hyphenated at the word boundaries of the best split,
// and get<sld>.com / try<sld>.com. Each name: is it registered (RDAP only, never system DNS; an ending with no RDAP service is `null`, never guessed),
// and for a registered one, is its home page in use (a paced, robots-aware, size-capped fetch through the outbound guard; parked or for-sale pages
// are not in use). A feature check: it always answers PASS (or UNKNOWN when it cannot run); it never FAILs or FLAGs a name, so verdicts do not change.
import { RDAP_FALLBACK_BASES } from '../../../core/rdap.js';
import { fetchPage, classifySite, type PageFetch, type RobotsRule, type SiteClass } from '../site.js';
import { lookupCached, pacerFor, prefetchStored, rdapBaseFor, type Pacer, type StoredLookup } from '../rdap-batch.js';
import { sharedPacer, sharedRobots } from '../sellers.js';
import { outcome, type Check, type CheckContext } from '../types.js';
import { formFieldsOf } from './form.js';

export type LookalikeKind = 'ending' | 'hyphen' | 'prefix';
export interface LookalikeName { domain: string; kind: LookalikeKind }
export interface LookalikeItem { domain: string; kind: LookalikeKind; registered: boolean | null; in_use: boolean | null; reason_code: string | null }

const isDigit = (c: string): boolean => c >= '0' && c <= '9';
const MIN_WORD = 4;

/**
 * v4.2.1 (CR-052 S-1): hyphen points from real words, not from the form split (which broke `drscompliance` into dr-sc-om-pl-ian-ce).
 * The longest dictionary word ending the name (`drs|compliance`, `ppwr|labelling`), the longest one starting it (`roofing|voiceagent`),
 * and a digit followed by a letter (`ets2|compliance`, `fsma204|audit`), so an acronym with its number (ets2, fsma204) stays whole.
 * A letter followed by a digit (`fsma|204`) is used only in the form with every point. A British double l counts (labelling = labeling). Pure.
 */
export function wordHyphenNames(sld: string, dictionary: ReadonlySet<string>): string[] {
  const isWord = (w: string): boolean => w.length >= MIN_WORD && /^[a-z]+$/.test(w) && (dictionary.has(w) || dictionary.has(w.replace('ll', 'l')));
  const single = new Set<number>();
  for (let i = 1; i <= sld.length - MIN_WORD; i++) if (isWord(sld.slice(i))) { single.add(i); break; }
  for (let j = sld.length - 1; j >= MIN_WORD; j--) if (isWord(sld.slice(0, j))) { single.add(j); break; }
  const all = new Set(single);
  for (let i = 1; i < sld.length; i++) {
    if (isDigit(sld[i - 1]!) && !isDigit(sld[i]!)) { single.add(i); all.add(i); }
    else if (!isDigit(sld[i - 1]!) && isDigit(sld[i]!)) all.add(i);
  }
  const cut = (at: number[]): string => { let out = ''; let from = 0; for (const b of at) { out += `${sld.slice(from, b)}-`; from = b; } return `${out}${sld.slice(from)}.com`; };
  const out = [...single].sort((a, b) => a - b).map((b) => cut([b]));
  if (all.size >= 2) out.push(cut([...all].sort((a, b) => a - b)));
  return out;
}

/**
 * The names to check, in priority order, de-duplicated and never our own name. Pure.
 * With a `dictionary` (the sibling scan, CR-052) the hyphen forms come from `wordHyphenNames` first, and the form split is used only when it has at most three pieces of 3+ letters (v4.2.2: no `ppwr-la-belling`).
 */
export function lookalikeNames(sld: string, tokens: string[], s: { endings: string[]; prefixes: string[] }, dictionary?: ReadonlySet<string>): LookalikeName[] {
  const out: LookalikeName[] = [];
  const seen = new Set<string>([`${sld}.com`]);
  const add = (domain: string, kind: LookalikeKind): void => { if (!seen.has(domain)) { seen.add(domain); out.push({ domain, kind }); } };
  for (const e of s.endings) add(`${sld}.${e}`, 'ending');
  if (dictionary) for (const d of wordHyphenNames(sld, dictionary)) add(d, 'hyphen');
  if (tokens.length >= 2 && tokens.join('') === sld && (!dictionary || (tokens.length <= 3 && tokens.every((t) => t.length >= 3)))) {
    add(`${tokens.join('-')}.com`, 'hyphen');
    // three words: each single boundary too (a-bc, ab-c); more words: the full hyphenated form only
    if (tokens.length === 3) for (let i = 1; i < 3; i++) add(`${tokens.slice(0, i).join('')}-${tokens.slice(i).join('')}.com`, 'hyphen');
  }
  for (const p of s.prefixes) add(`${p}${sld}.com`, 'prefix');
  return out;
}

export interface LookalikeProbe { item: LookalikeItem; calls: number; evidence: number[]; page: PageFetch | null; site: SiteClass | null; rdapCheckedAt: Date | null }

/**
 * One name: RDAP (cached, paced), then for a registered one its home page (paced, robots-aware, size-capped) classified parked / for sale / in use.
 * Shared by the lookalike check and the sibling scan (CR-050). Never throws for an upstream failure; the reason is in `item.reason_code`.
 */
export async function probeLookalike(
  ctx: CheckContext, n: LookalikeName,
  o: { maxAgeHours: number; lists: { parked: string[]; forsale: string[] } | null; pace: Pacer; robots: Map<string, RobotsRule>; /** Stored RDAP answers read in one query (`prefetchStored`) for every name of the scan: no per-name lookup query. */ prefetched?: Map<string, StoredLookup> },
): Promise<LookalikeProbe> {
  const cfg = ctx.settings.lookalikes;
  const item: LookalikeItem = { domain: n.domain, kind: n.kind, registered: null, in_use: null, reason_code: null };
  const out: LookalikeProbe = { item, calls: 0, evidence: [], page: null, site: null, rdapCheckedAt: null };
  if (ctx.now() > ctx.deadline || ctx.isCancelled?.()) { item.reason_code = 'TIMEOUT'; return out; }
  const tld = n.domain.slice(n.domain.lastIndexOf('.') + 1); // the registry label: co.uk is asked at uk
  const sourceOn = tld === 'com' ? ctx.settings.sources.rdap_com : ctx.settings.sources.rdap_other;
  if (!sourceOn) { item.reason_code = 'SOURCE_DISABLED'; return out; }
  let base: string | null;
  try {
    // v4.2.1 (CR-052 S-2): co, us and io are missing from IANA's RDAP list; their registries' own servers are used instead.
    base = (await rdapBaseFor(ctx.db, ctx.deps, tld, { enabled: ctx.settings.sources.iana_bootstrap || tld === 'com', now: ctx.now })) ?? RDAP_FALLBACK_BASES[tld] ?? null;
  } catch {
    item.reason_code = 'SOURCE_ERROR';
    return out;
  }
  if (base === null) { item.reason_code = 'NO_REGISTRY_SERVICE'; return out; }
  const r = await lookupCached(ctx.db, ctx.deps, n.domain, {
    maxAgeHours: o.maxAgeHours, baseUrl: base, evidenceMaxBytes: ctx.settings.evidence.max_text_bytes, pace: pacerFor(ctx, base), now: ctx.now, deadline: ctx.deadline, isCancelled: ctx.isCancelled, prefetched: o.prefetched,
  });
  if (!r.cached && r.reasonCode !== 'TIMEOUT') out.calls++;
  if (r.evidenceId !== null) out.evidence.push(r.evidenceId);
  out.rdapCheckedAt = r.checkedAt;
  if (r.outcome === 'unknown') { item.reason_code = r.reasonCode ?? 'SOURCE_ERROR'; return out; }
  if (r.outcome === 'not_registered') { item.registered = false; return out; }
  item.registered = true;
  // The home page of a registered lookalike.
  if (!ctx.settings.sources.business_sites) { item.reason_code = 'SOURCE_DISABLED'; return out; }
  if (!o.lists) { item.reason_code = 'LIST_MISSING'; return out; }
  if (ctx.now() > ctx.deadline) { item.reason_code = 'TIMEOUT'; return out; }
  const s = ctx.settings.same_name;
  const page = await fetchPage({ fetch: ctx.deps.siteFetch, lookupHost: ctx.deps.lookupHost }, `https://${n.domain}/`, {
    timeoutMs: cfg.timeout_ms, maxBytes: cfg.max_bytes, maxRedirects: s.max_redirects, pace: o.pace, robots: o.robots, neverFetchHosts: ctx.settings.lead.verify.never_fetch_hosts,
    deadline: ctx.deadline, now: ctx.now, onRequest: () => { out.calls++; }, truncatedOk: true,
  });
  const c = classifySite(page, n.domain, ctx.item.domain, [], o.lists, s);
  out.page = page;
  out.site = c;
  if (c.site_state === 'in_use') item.in_use = true;
  else if (c.site_state === 'parked_or_for_sale' || c.site_state === 'registered_no_site') item.in_use = false;
  else item.reason_code = c.reason_code ?? c.site_state; // redirect_off_domain, unknown: not guessed
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

    const prefetched = await prefetchStored(ctx.db, names.map((n) => n.domain), { maxAgeHours, now: ctx.now });
    for (const n of names) {
      const pr = await probeLookalike(ctx, n, { maxAgeHours, lists, pace, robots, prefetched });
      calls += pr.calls;
      evidence.push(...pr.evidence);
      items.push(pr.item);
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
