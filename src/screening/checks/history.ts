// G6 history (CAP-07, HIST-2 + prior-business guard; CR-002 CAP-07 and Amendment A1/A2/A5): what the Internet Archive says the name
// was used for BEFORE the current registration (or before `as_of`). Prior history is a positive signal; only harmful use rejects.
// Deterministic and versioned: captures are classified by the signature lists (sig_harmful_strong/weak, sig_parked, sig_forsale), no LLM.
// An archive that cannot be read is UNKNOWN, never "no history". Source: Wayback CDX + raw captures, <= 1 request/s per host.
import { Pacer } from '../rdap-batch.js';
import { storeEvidence } from '../evidence.js';
import { hiddenSignals, metaRefreshTarget, visibleText } from '../html-text.js';
import { businessNameCandidate, nameTokens, pickBusinessName, type BusinessCandidate } from '../prior-business.js';
import {
  cdxCaptures, classifyCapture, fetchCapture, pickDecisive, scanPaths, timestampMs, toTimestamp, type Capture, type CaptureCls, type CaptureFetch, type CdxResult,
  type PreCls, type SignatureLists,
} from '../wayback.js';
import { outcome, type Check, type CheckContext, type CheckOutcome, type Status } from '../types.js';
import { matchTerms } from './brand-lists.js';
import { asOfOf } from './census.js';

const YEAR_MS = 365.25 * 86_400_000;
const BACKOFF_MS = 2000;
const WAYBACK_HOST = 'web.archive.org';
const SIG_LISTS = ['sig_harmful_strong', 'sig_harmful_weak', 'sig_parked', 'sig_forsale'] as const;

/** The six HIST-2 fail classes (CR-002 Amendment A1) and the signature classes that map to them. */
export const HIST2_FAIL_CLASSES = ['blocklist', 'malware_phishing', 'spam', 'adult', 'scam', 'trademark_abuse'] as const;
type FailClass = (typeof HIST2_FAIL_CLASSES)[number];
const FAIL_CLASS_OF: Record<string, FailClass> = {
  malware: 'malware_phishing', phishing: 'malware_phishing', scam: 'scam', adult: 'adult',
  pharma: 'spam', gambling: 'spam', hacked_spam: 'spam', pbn: 'spam', trademark: 'trademark_abuse',
};
/** When one capture hits several classes the most serious names the failure. */
const SEVERITY: FailClass[] = ['malware_phishing', 'scam', 'adult', 'spam', 'trademark_abuse', 'blocklist'];

const classOfTerm = (term: string) => term.slice(0, term.indexOf(':'));
const failClassOf = (matched: string[]): FailClass | null => {
  const classes = matched.map((t) => FAIL_CLASS_OF[classOfTerm(t)]).filter((c): c is FailClass => c !== undefined);
  return SEVERITY.find((s) => classes.includes(s)) ?? null;
};

const NUL = {
  prior_history: null, pre_caps: null, first_capture: null, last_capture: null, pre_cls: 'unknown', hist2: 'UNKNOWN', hist2_fail_class: null,
  prior_business_use: 'unknown', prior_business_name: null, prior_business_years: null, archive_span_yrs: null, source_lane: 'unknown',
  source_lane_inferred: true, com_prior_registration: 'unknown', forsale: null, parked_only: null, captures: [] as unknown[], evidence_urls: [] as string[],
};

const excerptOf = (text: string, matched: string[]): string => {
  const phrase = matched[0] ? matched[0].slice(matched[0].indexOf(':') + 1) : '';
  const at = phrase ? text.toLowerCase().indexOf(phrase.toLowerCase()) : -1;
  const from = at < 0 ? 0 : Math.max(0, at - 100);
  return text.slice(from, from + 300);
};

const isoOf = (ts: string) => new Date(timestampMs(ts)!).toISOString();
const round1 = (n: number) => Math.round(n * 10) / 10;

interface Issue { status: Exclude<Status, 'PASS'>; code: string; reason: string; guard?: boolean }
const SEV: Record<string, number> = { FAIL: 3, UNKNOWN: 2, FLAG: 1 };
const worst = (xs: Issue[]): Issue | null => xs.reduce<Issue | null>((a, b) => (a === null || SEV[b.status]! > SEV[a.status]! ? b : a), null);

/** One pacer per host for the whole process (every run shares the archive's 1 request/s), kept per `ScreeningDeps` instance. */
const PACERS = new WeakMap<object, Map<string, Pacer>>();
function pacerOf(ctx: CheckContext, host: string): Pacer {
  const byHost = PACERS.get(ctx.deps) ?? PACERS.set(ctx.deps, new Map()).get(ctx.deps)!;
  let p = byHost.get(host);
  if (!p) { p = new Pacer(ctx.settings.history.min_ms_between_calls, 1, ctx.deps.sleep); byHost.set(host, p); }
  return p;
}

const MAX_RETRY_AFTER_MS = 30_000;

/**
 * Runs `run` (which paces itself), retrying a failure `history.retries` times with a growing pause, or the archive's own Retry-After
 * when it asks for more (never past the run deadline; a Retry-After over 30 s is not waited for). An index that is truncated is not retried.
 */
async function withRetries<T extends { ok: boolean }>(ctx: CheckContext, run: () => Promise<T>): Promise<{ res: T | null; calls: number }> {
  let calls = 0;
  let res: T | null = null;
  for (let attempt = 0; attempt <= ctx.settings.history.retries; attempt++) {
    if (ctx.now() > ctx.deadline) return { res: null, calls };
    res = await run();
    calls++;
    if (res.ok || (res as { reasonCode?: string }).reasonCode === 'INDEX_TRUNCATED') break;
    if (attempt < ctx.settings.history.retries) {
      const ra = (res as { retryAfterMs?: number | null }).retryAfterMs ?? 0;
      if (ra > MAX_RETRY_AFTER_MS) break;
      await ctx.deps.sleep(Math.max(BACKOFF_MS * (attempt + 1), ra));
    }
  }
  return { res, calls };
}

export const historyCheck: Check = {
  id: 'history',
  gate: 'G6',
  ruleIds: ['HIST-2'],
  lists: [...SIG_LISTS, 'brand', 'bigco'],
  async run(ctx): Promise<CheckOutcome> {
    const h = ctx.settings.history;
    const domain = ctx.item.domain;
    const { asOf, explicit } = asOfOf(ctx);
    const base = { ...NUL, as_of: asOf.toISOString() };
    if (!ctx.settings.sources.wayback) return outcome('UNKNOWN', 'SOURCE_DISABLED', 'The Internet Archive source is switched off (sources.wayback)', base);
    if (ctx.run.backtest && !ctx.item.as_of) return outcome('UNKNOWN', 'AS_OF_REQUIRED', 'A backtest or holdout run needs an as_of for every name', base);
    const missingSig = SIG_LISTS.filter((n) => !ctx.lists[n]);
    if (missingSig.length > 0) return outcome('UNKNOWN', 'LIST_MISSING', `No uploaded signature list: ${missingSig.join(', ')} (a missing list is never a clean result)`, { ...base, lists_missing: missingSig });
    const lists: SignatureLists = { strong: ctx.lists.sig_harmful_strong!.terms, weak: ctx.lists.sig_harmful_weak!.terms, parked: ctx.lists.sig_parked!.terms, forsale: ctx.lists.sig_forsale!.terms };
    const listVersions = Object.fromEntries(SIG_LISTS.map((n) => [n, ctx.lists[n]!.version]));

    // The cut-off: captures at or after the current registration are the owner's, not history (our own post-purchase captures, CR-001 CAP-07 #8).
    const avail = ctx.latest('availability');
    const availState = avail?.fields.availability === 'registered' || avail?.fields.availability === 'available' ? (avail.fields.availability as 'registered' | 'available') : 'unknown';
    const createdMs = availState === 'registered' && typeof avail?.fields.created_at === 'string' && !Number.isNaN(Date.parse(avail.fields.created_at)) ? Date.parse(avail.fields.created_at) : null;
    const cutoffMs = createdMs !== null ? Math.min(createdMs, asOf.getTime()) : asOf.getTime();
    const cutoffBasis = createdMs !== null && createdMs < asOf.getTime() ? 'registration' : 'as_of';
    const nowMs = ctx.now();
    const to = explicit || createdMs !== null ? (cutoffMs < nowMs ? toTimestamp(cutoffMs) : undefined) : undefined;
    const common = { ...base, cutoff: new Date(cutoffMs).toISOString(), cutoff_basis: cutoffBasis, list_versions: listVersions };

    const pace = pacerOf(ctx, WAYBACK_HOST);
    let calls = 0;
    const evidenceIds: number[] = [];
    const ev = (extra: Partial<{ dataAsOf: Date }> = {}) => ({ upstreamCalls: calls, evidenceIds, dataAsOf: extra.dataAsOf ?? new Date(nowMs) });
    const archiveDown = (reasonCode: string, reason: string, more: Record<string, unknown> = {}) =>
      outcome('UNKNOWN', reasonCode, reason, { ...common, ...more, error_code: 'ARCHIVE_UNAVAILABLE' }, ev());

    // ---- the index ----
    const cdx = await withRetries<CdxResult>(ctx, () => cdxCaptures(ctx.deps, domain, { to, timeoutMs: h.timeout_ms, pace: (fn) => pace.run(fn) }));
    calls += cdx.calls;
    if (cdx.res === null) return archiveDown('TIMEOUT', 'The run ran out of time before the archive index was read');
    if (!cdx.res.ok) return archiveDown(cdx.res.reasonCode, cdx.res.reasonCode === 'INDEX_TRUNCATED' ? 'The archive index is larger than what was read (a full page with no resume key, or more than 5 pages): part of the history was never seen' : `The Internet Archive index did not answer usefully (${cdx.res.reasonCode}): history is unknown, not absent`, { cdx_url: cdx.res.url });
    const index = cdx.res;
    calls += index.pages - 1;
    evidenceIds.push(await storeEvidence(ctx.db, { source: 'wayback', url: index.url, retrievedAt: new Date(ctx.now()), httpStatus: 200, contentType: 'application/json', body: index.body, text: index.body, maxBytes: ctx.settings.evidence.max_text_bytes }));

    // Strictly before the cut-off; a capture whose timestamp is not a real date cannot be placed and is excluded (A2).
    let undated = 0;
    let after = 0;
    const before: (Capture & { ms: number })[] = [];
    for (const c of index.captures) {
      const ms = timestampMs(c.timestamp);
      if (ms === null) { undated++; continue; }
      if (ms < cutoffMs) before.push({ ...c, ms }); else after++;
    }
    before.sort((a, b) => a.ms - b.ms);
    const preCaps = before.length;
    const first = before[0];
    const last = before[before.length - 1];

    // ---- the decisive captures ----
    const decisive = pickDecisive(before, domain, h.max_fetch_per_name);
    interface Rec { capture: Capture; fetched: Extract<CaptureFetch, { ok: true }>; cls: CaptureCls; matched: string[]; adMatches: string[]; metaRefresh: boolean; title: string | null; text: string; html: string; target: string | null; ignored: boolean }
    const recs: Rec[] = [];
    for (const c of decisive) {
      const f = await withRetries<CaptureFetch>(ctx, () => pace.run(() => fetchCapture(ctx.deps, c, { timeoutMs: h.timeout_ms })));
      calls += f.calls;
      if (f.res === null) return archiveDown('TIMEOUT', 'The run ran out of time while reading archived captures', { pre_caps: preCaps });
      if (!f.res.ok) {
        return archiveDown('CAPTURE_UNAVAILABLE', `A decisive capture (${c.timestamp}) could not be read (${f.res.reasonCode}): an incomplete history never passes`, { pre_caps: preCaps, capture: c.timestamp, capture_url: f.res.url, fetch_reason: f.res.reasonCode });
      }
      const fr = f.res;
      const vt = fr.html === null ? { title: null, text: '' } : visibleText(fr.html);
      // A page that is only a quick meta refresh (<= 5 s) is a redirect: where it points decides, like a 3xx.
      const refresh = fr.html === null ? null : metaRefreshTarget(fr.html);
      const k = refresh !== null
        ? classifyCapture({ status: 302, location: refresh, text: '', domain }, lists, h.min_content_chars, h.parked_max_text_chars)
        : classifyCapture({ status: fr.status, location: fr.location, text: vt.text, domain, extra: fr.html === null ? '' : hiddenSignals(fr.html) }, lists, h.min_content_chars, h.parked_max_text_chars);
      const target = refresh ?? fr.location;
      evidenceIds.push(await storeEvidence(ctx.db, {
        source: 'wayback', url: fr.url, retrievedAt: new Date(ctx.now()), httpStatus: fr.status, contentType: fr.contentType,
        body: fr.html ?? `HTTP ${fr.status} ${fr.location ?? ''}`, text: fr.html === null ? `HTTP ${fr.status} redirect to ${fr.location ?? '(no Location)'}` : vt.text, maxBytes: ctx.settings.evidence.max_text_bytes,
      }));
      recs.push({ capture: c, fetched: fr, cls: k.cls, matched: k.matched, adMatches: k.adMatches ?? [], metaRefresh: refresh !== null, title: vt.title, text: vt.text, html: fr.html ?? '', target, ignored: k.sameSiteRedirect === true });
    }
    const counted = recs.filter((r) => !r.ignored);
    const has = (...cls: CaptureCls[]) => counted.some((r) => cls.includes(r.cls));

    const preCls: PreCls = preCaps === 0 ? 'none'
      : has('harmful_strong', 'harmful_weak') ? 'harmful' : has('redirect_offsite') ? 'redirect_offsite' : has('content') ? 'content' : has('parked', 'forsale') ? 'parked' : 'redirect_error_only';
    const forsale = has('forsale');
    const captures = recs.map((r) => ({
      timestamp: isoOf(r.capture.timestamp), status: r.fetched.status, class: r.ignored ? 'same_site_redirect' : r.cls, title: r.title,
      excerpt: excerptOf(r.text, r.matched), redirect_target: r.target, archive_url: r.fetched.url, matched: r.matched, ...(r.adMatches.length > 0 && { ad_matches: r.adMatches }), ...(r.metaRefresh && { meta_refresh: true }),
    }));

    // ---- the verdict: the archive's classes by the settings' actions, blocklists, then the prior-business guard ----
    const issues: Issue[] = [];
    const act = (action: 'PASS' | 'FLAG' | 'FAIL', code: string, reason: string) => { if (action !== 'PASS') issues.push({ status: action, code, reason }); };
    const strong = counted.find((r) => r.cls === 'harmful_strong');
    let failClass: FailClass | null = null;
    let details: Record<string, unknown> | null = null;
    if (strong) {
      failClass = failClassOf(strong.matched);
      details = { class: classOfTerm(strong.matched[0]!), fail_class: failClass, matched: strong.matched, capture: isoOf(strong.capture.timestamp), archive_url: strong.fetched.url };
      act(h.strong_action, 'HARMFUL_HISTORY', `Archived capture of ${isoOf(strong.capture.timestamp).slice(0, 10)} matches harmful signatures (${strong.matched.join(', ')})`);
    }
    const weak = counted.find((r) => r.cls === 'harmful_weak');
    if (weak) {
      if (!details) details = { class: classOfTerm(weak.matched[0]!), fail_class: failClassOf(weak.matched), matched: weak.matched, capture: isoOf(weak.capture.timestamp), archive_url: weak.fetched.url };
      act(h.weak_action, 'HARMFUL_WEAK', `Archived capture of ${isoOf(weak.capture.timestamp).slice(0, 10)} partly matches harmful signatures (${weak.matched.join(', ')}): needs a human look`);
    }
    // Harmful words on a parking or for-sale placeholder are its advertising: a FLAG for a human, never a FAIL (parked first).
    const ads = counted.filter((r) => r.adMatches.length > 0);
    const parkedAds = ads.map((r) => ({ capture: isoOf(r.capture.timestamp), archive_url: r.fetched.url, ad_matches: r.adMatches, excerpt: excerptOf(r.text, r.adMatches) }));
    if (ads.length > 0) issues.push({ status: 'FLAG', code: 'HARMFUL_ON_PARKED_PAGE', reason: `A parked or for-sale capture of ${isoOf(ads[0]!.capture.timestamp).slice(0, 10)} shows harmful words (${ads[0]!.adMatches.join(', ')}), most likely sponsored links: needs a human look` });
    // The archived URLs themselves (subdomains, paths): scanned without fetching anything.
    const pathHits = scanPaths(before, domain, lists, h.url_terms).map((x) => ({ ...x, timestamp: isoOf(x.timestamp) }));
    if (pathHits.length > 0) issues.push({ status: 'FLAG', code: 'HARMFUL_PATH', reason: `An archived URL of this name contains harmful words (${pathHits[0]!.url}: ${pathHits[0]!.matched.join(', ')}): needs a human look` });
    const redirect = counted.find((r) => r.cls === 'redirect_offsite');
    if (redirect) act(h.redirect_action, 'REDIRECT_OFFSITE', `Archived capture of ${isoOf(redirect.capture.timestamp).slice(0, 10)} redirects to another site (${redirect.target})`);
    if (forsale) act(h.forsale_action, 'FORSALE_HISTORY', 'The name was archived as a for-sale page');
    if (has('parked')) act(h.parked_action, 'PARKED_HISTORY', 'The name was archived as a parked page');

    // Blocklists (SURBL, Web Risk): a listing is a fail class; a blocklist that ran and could not answer is unknown (never read as clean).
    const surbl = ctx.latest('surbl');
    const wr = ctx.latest('web_risk');
    const blocklist = { surbl: surbl ? surbl.status : 'not_run', web_risk: wr ? wr.status : 'not_run' };
    if (surbl?.status === 'FAIL' || wr?.status === 'FAIL') {
      failClass = 'blocklist'; // a listing is the cause of the FAIL, whatever else the pages say (details keep the page matches)
      details = details ?? { class: 'blocklist', fail_class: 'blocklist', matched: [], source: surbl?.status === 'FAIL' ? 'surbl' : 'web_risk' };
      issues.push({ status: 'FAIL', code: 'HARMFUL_HISTORY', reason: `${domain} is on a blocklist (${surbl?.status === 'FAIL' ? 'SURBL' : 'Web Risk'})` });
    } else if (surbl?.status === 'UNKNOWN') {
      issues.push({ status: 'UNKNOWN', code: 'BLOCKLIST_UNAVAILABLE', reason: 'The SURBL lookup is unknown, so the blocklist half of HIST-2 cannot be decided' });
    }

    // Prior-business guard: a real business page in the archive. Its own name runs through CAP-02 here; CAP-08 (US trademark) is a manual
    // record and gets the name in its request (`tm_us` reads `prior_business_name` from this result).
    const content = counted.filter((r) => r.cls === 'content');
    const business = content.length > 0;
    let bizName: string | null = null;
    let bizYears: number | null = null;
    let guard: Record<string, unknown> | null = null;
    let bizNameInfo: Record<string, unknown> = {};
    if (business) {
      const cands = content.map((r) => businessNameCandidate({ html: r.html, title: r.title, text: r.text, timestamp: r.capture.timestamp }, domain)).filter((x): x is BusinessCandidate => x !== null);
      const picked = pickBusinessName(cands);
      bizName = picked.name;
      bizNameInfo = { prior_business_name_is_domain: picked.nameIsDomain, prior_business_name_basis: picked.reason, prior_business_name_sources: [...new Set(cands.map((x) => x.source))] };
      const ts = content.map((r) => timestampMs(r.capture.timestamp)!).sort((a, b) => a - b);
      bizYears = round1((ts[ts.length - 1]! - ts[0]!) / YEAR_MS);
      if (bizName === null) {
        issues.push({ status: 'FLAG', code: 'PRIOR_BUSINESS_NAME_UNKNOWN', guard: true, reason: `A prior business used this name but no business name is clear from its pages (${bizNameInfo.prior_business_name_basis === 'conflict' ? 'the captures name different businesses' : bizNameInfo.prior_business_name_basis === 'text_line_only' ? 'only a text line suggests one' : 'none found'}): the brand and trademark checks cannot run on it` });
      } else {
        const tokens = nameTokens(bizName);
        const none = tokens.map(() => false);
        const brand = ctx.lists.brand ? matchTerms(tokens, none, ctx.lists.brand.terms) : null;
        const bigco = ctx.lists.bigco ? matchTerms(tokens, none, ctx.lists.bigco.terms) : null;
        guard = { name: bizName, brand_hits: brand, bigco_hits: bigco, brand_list: ctx.lists.brand?.version ?? null, bigco_list: ctx.lists.bigco?.version ?? null, cap08_required: true, gate: 'G1', rules: ['BRAND-1', 'BIGCO-1'] };
        if (brand && brand.length > 0) issues.push({ status: 'FAIL', code: 'PRIOR_BUSINESS_BRAND_HIT', guard: true, reason: `The prior business name "${bizName}" is on the brand list (${brand.map((x) => x.term).join(', ')}); a BRAND-1 failure, not a HIST-2 one` });
        else if (bigco && bigco.length > 0) issues.push({ status: 'FAIL', code: 'PRIOR_BUSINESS_BIGCO_HIT', guard: true, reason: `The prior business name "${bizName}" is on the big-company list (${bigco.map((x) => x.term).join(', ')}); a BIGCO-1 failure, not a HIST-2 one` });
        else if (!brand || !bigco) issues.push({ status: 'UNKNOWN', code: 'LIST_MISSING', guard: true, reason: `No uploaded ${!brand ? 'brand' : 'bigco'} list: the prior business name cannot be checked (never a clean result)` });
      }
    }

    const top = worst(issues);
    const archiveTop = worst(issues.filter((i) => !i.guard));
    // Source lane (CAP-03 / CAP-04), INFERRED from the archive: the registry says nothing about a dropped name. Captures before the current
    // registration (any capture, for an available name) mean the name was registered before: `expired_drop`; none: `fresh`.
    const lane = availState === 'unknown' ? 'unknown' : preCaps > 0 ? 'expired_drop' : 'fresh';
    const comPrior = availState === 'unknown' || (availState === 'registered' && createdMs === null) ? 'unknown' : preCaps > 0 ? 'yes' : 'no';
    const fields = {
      ...common, prior_history: preCaps > 0 ? 1 : 0, pre_caps: preCaps, first_capture: first ? isoOf(first.timestamp) : null, last_capture: last ? isoOf(last.timestamp) : null,
      pre_cls: preCls, hist2: archiveTop ? archiveTop.status : 'PASS',
      hist2_fail_class: issues.some((i) => i.status === 'FAIL' && i.code === 'HARMFUL_HISTORY') ? failClass : null, ...(details && { details }),
      forsale, parked_only: preCls === 'parked', captures,
      archive_span_yrs: preCaps === 0 ? 0 : round1((last!.ms - first!.ms) / YEAR_MS),
      prior_business_use: business ? 'yes' : 'no', prior_business_name: bizName, prior_business_years: business ? bizYears : null, ...(guard && { prior_business_guard: guard }), ...bizNameInfo, path_hits: pathHits, parked_page_ads: parkedAds,
      source_lane: lane, source_lane_inferred: true, com_prior_registration: comPrior, blocklist,
      evidence_urls: [index.url, ...recs.map((r) => r.fetched.url)], decisive_n: recs.length, undated_excluded_n: undated, after_cutoff_n: after,
    };
    if (!top) return outcome('PASS', null, null, fields, ev());
    return outcome(top.status, top.code, top.reason, top.code === 'BLOCKLIST_UNAVAILABLE' ? { ...fields, error_code: 'BLOCKLIST_UNAVAILABLE' } : fields, ev());
  },
};
