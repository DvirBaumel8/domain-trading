// G8 UK company names (CR-046 item 2, v4.2.0): Companies House search (free API, HTTP Basic with the key as the user name). A feature check: it informs and
// never rejects. A match is a company whose title contains every split token as a whole word. Only title, company number and status are kept (no officers,
// no addresses). Paced per host (`companies.max_per_minute`), timed out, through the outbound guard. Without COMPANIES_HOUSE_API_KEY: UNKNOWN SOURCE_DISABLED.
import { safeFetch } from '../../../core/safe-fetch.js';
import { Pacer } from '../rdap-batch.js';
import { outcome, type Check, type CheckContext } from '../types.js';
import { formFieldsOf } from './form.js';

const COMPANIES_HOST = 'api.company-information.service.gov.uk';
const COMPANIES_MAX_ITEMS = 5;
export interface CompanyItem { title: string; company_number: string; company_status: string }

const pacers = new Map<(ms: number) => Promise<void>, { gap: number; pacer: Pacer }>();
/** One pacer per app (its `sleep`), one call at a time and at least 60000 / max_per_minute ms between starts. */
function pacerOf(ctx: CheckContext): Pacer {
  const gap = Math.ceil(60_000 / ctx.settings.companies.max_per_minute);
  const hit = pacers.get(ctx.deps.sleep);
  if (hit && hit.gap === gap) return hit.pacer;
  const pacer = new Pacer(gap, 1, ctx.deps.sleep, ctx.now);
  pacers.set(ctx.deps.sleep, { gap, pacer });
  return pacer;
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** True when the title contains every token as a whole word, case-insensitively. Pure. */
export function titleMatches(title: string, tokens: string[]): boolean {
  const t = title.toLowerCase();
  return tokens.length > 0 && tokens.every((k) => new RegExp(`(^|[^a-z0-9])${esc(k.toLowerCase())}($|[^a-z0-9])`).test(t));
}

/** The matches of a search answer: max 5, active companies first (the order of the answer otherwise). Pure. */
export function companyMatches(items: unknown, tokens: string[]): { n: number; items: CompanyItem[] } {
  const hits: CompanyItem[] = [];
  if (Array.isArray(items)) {
    for (const x of items) {
      const o = x as { title?: unknown; company_number?: unknown; company_status?: unknown } | null;
      if (!o || typeof o.title !== 'string' || !titleMatches(o.title, tokens)) continue;
      hits.push({ title: o.title.slice(0, 200), company_number: typeof o.company_number === 'string' ? o.company_number.slice(0, 20) : '', company_status: typeof o.company_status === 'string' ? o.company_status.slice(0, 40) : 'unknown' });
    }
  }
  const sorted = [...hits.filter((h) => h.company_status === 'active'), ...hits.filter((h) => h.company_status !== 'active')];
  return { n: hits.length, items: sorted.slice(0, COMPANIES_MAX_ITEMS) };
}

const unknown = (code: string, message: string, calls = 0) => outcome('UNKNOWN', code, message, { companies: { uk_matches_n: null, items: [] } }, { upstreamCalls: calls });

export const companiesCheck: Check = {
  id: 'companies',
  gate: 'G8',
  ruleIds: ['CR-046'],
  lists: [],
  async run(ctx: CheckContext) {
    const key = ctx.deps.companiesHouseApiKey;
    if (!key) return unknown('SOURCE_DISABLED', 'COMPANIES_HOUSE_API_KEY is not set');
    if (ctx.run.mode === 'full' && ctx.item.as_of !== undefined) return unknown('AS_OF_NOT_SUPPORTED', "Today's company register cannot be read as of a past date");
    const tokens = formFieldsOf(ctx).tokens;
    if (tokens.length === 0) return unknown('NO_TOKENS', 'The name has no word split to search');
    if (ctx.now() > ctx.deadline || ctx.isCancelled?.()) return unknown('TIMEOUT', 'The run deadline passed');
    const cfg = ctx.settings.companies;
    const pacer = pacerOf(ctx);
    if (pacer.breakerOpen) return unknown('RATE_LIMITED', 'Companies House refused several calls in a row');
    const url = `https://${COMPANIES_HOST}/search/companies?q=${encodeURIComponent(tokens.join(' '))}&items_per_page=20`;
    const auth = `Basic ${Buffer.from(`${key}:`).toString('base64')}`;
    try {
      const res = await pacer.run(() => safeFetch({ fetch: ctx.deps.siteFetch, lookupHost: ctx.deps.lookupHost }, url, {
        headers: { authorization: auth, accept: 'application/json' }, signal: AbortSignal.timeout(cfg.timeout_ms),
      }, { neverFetchHosts: ctx.settings.lead.verify.never_fetch_hosts, lookupTimeoutMs: cfg.timeout_ms }));
      if (res.status === 429) { pacer.slowDown(); await res.body?.cancel().catch(() => {}); return unknown('RATE_LIMITED', 'Companies House answered 429', 1); }
      if (res.status !== 200) { await res.body?.cancel().catch(() => {}); return unknown('SOURCE_ERROR', `Companies House answered HTTP ${res.status}`, 1); }
      pacer.noteNotRefused();
      const body = JSON.parse((await res.text()).slice(0, 2_000_000)) as { items?: unknown };
      const m = companyMatches(body.items, tokens);
      return outcome('PASS', null, null, { companies: { uk_matches_n: m.n, items: m.items }, query: tokens.join(' ') }, { upstreamCalls: 1, dataAsOf: new Date(ctx.now()) });
    } catch (e) {
      const timeout = e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError');
      return unknown(timeout ? 'TIMEOUT' : 'SOURCE_ERROR', timeout ? 'Companies House did not answer in time' : 'The Companies House call failed', 1);
    }
  },
};
