// CAP-12 (CR-001, CR-002): the same name on the other extensions. Is our exact name already in use by someone else (a business name or a
// service description on the home page of `<sld>.<tld>`)? Registration comes from RDAP (`extRegistration`); the page is read politely
// (`fetchPage`: robots.txt, pacing, honest User-Agent; docs/internal/sources.md "Business websites"). Fail closed: a site that answers
// but cannot be read is `unknown` and FLAGs SITE_UNKNOWN, never PASS; a registry with no RDAP is unknown, never "not registered".
import { storeEvidence } from '../evidence.js';
import { visibleText } from '../html-text.js';
import { Pacer } from '../rdap-batch.js';
import { classifySite, fetchPage, type RobotsRule, type SiteClass } from '../site.js';
import { outcome, type Check, type CheckContext } from '../types.js';
import { extRegistration, type ExtRegistration } from './ext-dates.js';
import { formFieldsOf } from './form.js';

interface ExtensionRow {
  tld: string;
  registered: 'yes' | 'no' | 'unknown';
  created_at: string | null;
  site_state: SiteClass['site_state'];
  final_url: string | null;
  business_use: SiteClass['business_use'];
  business_name: string | null;
  reason_code: string | null;
  registration_reason_code: string | null;
  evidence_id: number | null;
}

function sharedPacer(ctx: CheckContext): Pacer {
  const hit = ctx.shared.get('site_pacer') as Pacer | undefined;
  if (hit) return hit;
  const p = new Pacer(ctx.settings.same_name.min_ms_between_fetches, 1, ctx.deps.sleep);
  ctx.shared.set('site_pacer', p);
  return p;
}
function sharedRobots(ctx: CheckContext): Map<string, RobotsRule> {
  const hit = ctx.shared.get('site_robots') as Map<string, RobotsRule> | undefined;
  if (hit) return hit;
  const m = new Map<string, RobotsRule>();
  ctx.shared.set('site_robots', m);
  return m;
}

const LISTS = ['sig_parked', 'sig_forsale'] as const;
const NUL = { tlds_taken_n: null, unknown_sites_n: null, exact_sld_other_tld_active: null, same_name_operators: [] as unknown[], extensions: [] as unknown[] };

export const sameNameCheck: Check = {
  id: 'same_name',
  gate: 'G8',
  ruleIds: ['CAP-12', 'TN-1'],
  lists: [...LISTS],
  async run(ctx) {
    const s = ctx.settings.same_name;
    if (!ctx.settings.sources.business_sites) return outcome('UNKNOWN', 'SOURCE_DISABLED', 'Business-site fetching is switched off (sources.business_sites)', NUL);
    if (ctx.run.mode === 'full' && ctx.item.as_of !== undefined) return outcome('UNKNOWN', 'AS_OF_NOT_SUPPORTED', "Today's sites cannot be read as of a past date (CR-001 Q11)", NUL);
    const missing = LISTS.filter((n) => !ctx.lists[n]);
    if (missing.length > 0) return outcome('UNKNOWN', 'LIST_MISSING', `No uploaded signature list: ${missing.join(', ')} (a missing list is never a clean result)`, { ...NUL, lists_missing: missing });

    const sld = ctx.item.domain.replace(/\.com$/, '');
    const form = formFieldsOf(ctx);
    const phraseTokens = form.tokens.length > 0 ? form.tokens : [sld];
    const lists = { parked: ctx.lists.sig_parked!.terms, forsale: ctx.lists.sig_forsale!.terms };
    const pace = sharedPacer(ctx);
    const robots = sharedRobots(ctx);
    const rows: ExtensionRow[] = [];
    const operators: { url: string; tld: string; business_use: string; business_name: string | null }[] = [];
    const evidence: number[] = [];
    let calls = 0;

    for (const tld of ctx.settings.ext.list) {
      if (tld === 'com') continue;
      // Registration is RDAP's; with rdap_other off it is unknown (the site is still read: a site in use is a fact).
      const reg: ExtRegistration = ctx.settings.sources.rdap_other
        ? await extRegistration(ctx, sld, tld)
        : { tld, status: 'unknown', created_at: null, reason_code: 'SOURCE_DISABLED', evidenceId: null, cached: false, upstream: false };
      if (!reg.cached && reg.upstream) calls++;
      if (reg.evidenceId !== null) evidence.push(reg.evidenceId);
      const base = { tld, registered: reg.status === 'registered' ? 'yes' as const : reg.status === 'not_registered' ? 'no' as const : 'unknown' as const, created_at: reg.created_at, registration_reason_code: reg.reason_code ?? null };
      if (reg.status === 'not_registered') {
        rows.push({ ...base, site_state: 'unregistered', final_url: null, business_use: null, business_name: null, reason_code: null, evidence_id: null });
        continue;
      }
      if (ctx.now() > ctx.deadline) {
        rows.push({ ...base, site_state: 'unknown', final_url: null, business_use: null, business_name: null, reason_code: 'TIMEOUT', evidence_id: null });
        continue;
      }
      const host = `${sld}.${tld}`;
      const page = await fetchPage(ctx.deps, `https://${host}/`, { timeoutMs: s.timeout_ms, maxBytes: s.max_bytes, maxRedirects: s.max_redirects, pace, robots });
      calls++;
      const c = classifySite(page, host, ctx.item.domain, phraseTokens, lists, s);
      let evidenceId: number | null = null;
      if (page.ok && page.html !== '') {
        const text = visibleText(page.html).text;
        evidenceId = await storeEvidence(ctx.db, { source: 'site', url: page.finalUrl, retrievedAt: new Date(ctx.now()), httpStatus: page.status, contentType: 'text/html', body: page.html, text, maxBytes: ctx.settings.evidence.max_text_bytes });
        evidence.push(evidenceId);
      }
      rows.push({ ...base, site_state: c.site_state, final_url: c.final_url, business_use: c.business_use, business_name: c.business_name, reason_code: c.reason_code, evidence_id: evidenceId });
      if (c.site_state === 'in_use' && (c.business_use === 'business_name' || c.business_use === 'service_description') && c.final_url) {
        operators.push({ url: c.final_url, tld, business_use: c.business_use, business_name: c.business_name });
      }
    }

    // A name is taken when RDAP says registered, or when a live site (in use, parked, redirecting) proves it.
    const taken = rows.filter((r) => r.registered === 'yes' || r.site_state === 'in_use' || r.site_state === 'parked_or_for_sale' || r.site_state === 'redirect_off_domain').length;
    const unknownSites = rows.filter((r) => r.site_state === 'unknown');
    const anyInUse = rows.some((r) => r.site_state === 'in_use');
    const fields = {
      tlds_taken_n: taken,
      unknown_sites_n: unknownSites.length,
      exact_sld_other_tld_active: anyInUse ? true : unknownSites.length > 0 ? null : false,
      same_name_operators: operators,
      unknown_sites: unknownSites.map((r) => ({ tld: r.tld, host: `${sld}.${r.tld}`, reason_code: r.reason_code })),
      extensions: rows,
      phrase_tokens: phraseTokens,
      list_versions: { sig_parked: ctx.lists.sig_parked!.version, sig_forsale: ctx.lists.sig_forsale!.version },
    };
    const extra = { upstreamCalls: calls, evidenceIds: evidence, dataAsOf: new Date(ctx.now()) };
    if (operators.length > 0) {
      const first = operators[0]!;
      return outcome('FLAG', 'SAME_NAME_OPERATOR', `${operators.length} other extension${operators.length === 1 ? '' : 's'} already use this name (${first.url})`, fields, extra);
    }
    if (rows.length > 0 && rows.every((r) => r.registered === 'unknown' && r.site_state === 'unknown')) {
      return outcome('UNKNOWN', 'ALL_EXT_UNKNOWN', 'No other extension could be checked', { ...fields, exact_sld_other_tld_active: null }, extra);
    }
    if (unknownSites.length > s.max_unknown_sites) {
      return outcome('FLAG', 'SITE_UNKNOWN', `${unknownSites.length} site${unknownSites.length === 1 ? '' : 's'} could not be read: ${unknownSites.map((r) => `${sld}.${r.tld} (${r.reason_code})`).join(', ')}`, fields, extra);
    }
    return outcome('PASS', null, null, fields, extra);
  },
};
