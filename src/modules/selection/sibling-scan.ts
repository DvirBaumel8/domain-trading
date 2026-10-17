// CR-050 part 1 (v4.1.0): the sibling scan. For a .com name: the same words on other endings, the hyphenated .com, get-/try- .com. Each is checked by RDAP
// (never system DNS) and, when registered, by its home page (live business, parked / for sale, redirect). Built on the CR-043 lookalike probe.
// Personal data: no email address and no person name is stored. Only the company name a page shows (og:site_name or title) and the URL of its contact page.
import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { analyzeForm } from './form.js';
import { lookalikeNames, probeLookalike, type LookalikeKind } from './checks/lookalikes.js';
import { anchorLinks, ogSiteName, titleOf } from './html-text.js';
import { buildLexicon, loadDataLexicon, type Lexicon } from './lexicon.js';
import { currentLists } from './lists.js';
import { Pacer, prefetchStored } from './rdap-batch.js';
import { activeSelectionSettings, type SelectionValuesT } from './settings.js';
import type { PageFetch } from './site.js';
import type { CheckContext, ScreeningDeps } from './types.js';

export interface Sibling {
  domain: string; kind: LookalikeKind;
  /** true / false from RDAP; null = could not be told, with `reason_code`. */
  registered: boolean | null; reason_code: string | null;
  /** true: HTTP 200 with real content. false: parked, for sale, redirect off the site, no site, or not registered. null: not determined. */
  live_business: boolean | null;
  /** The finer state of a registered sibling: in_use, parked_or_for_sale, redirect_off_domain, registered_no_site, unknown. */
  site_state: string | null;
  url: string | null; http_status: number | null; fetched_at: string | null;
  title: string | null; company: string | null; contact_url: string | null;
}
export interface LeadPoints { points: number; formula: string; live_n: number; parked_n: number }
export interface SiblingScan {
  domain: string; fetched_at: string; settings_version: string; complete: boolean; skipped_n: number; upstream_calls: number;
  siblings: Sibling[]; lead_points: LeadPoints;
}

const COMPANY_MAX = 120;
/** Words that look like an email address are dropped from any text we keep (no personal data). */
const scrub = (s: string | null): string | null => {
  if (s === null) return null;
  const t = s.split(/\s+/).filter((w) => !w.includes('@')).join(' ').trim().slice(0, COMPANY_MAX).trim();
  return t === '' ? null : t;
};

const hostKey = (u: string): string | null => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; } };

/** The contact page of a site: the first link on the same host whose path or text says "contact". The URL only (no query, no fragment); never mailto: or a URL with credentials. */
export function contactUrlOf(html: string, finalUrl: string): string | null {
  const host = hostKey(finalUrl);
  if (host === null) return null;
  for (const a of anchorLinks(html)) {
    let u: URL;
    try { u = new URL(a.href, finalUrl); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || u.username !== '' || u.password !== '' || hostKey(u.toString()) !== host) continue;
    if (!/contact/i.test(u.pathname) && !/contact/i.test(a.text)) continue;
    const clean = `${u.origin}${u.pathname}`;
    if (clean.includes('@')) continue;
    return clean;
  }
  return null;
}

/** Pure: the lead points of a set of siblings (CR-050). Weights and caps are the settings'; nothing is hard-coded. */
export function leadPointsOf(siblings: Pick<Sibling, 'live_business' | 'site_state'>[], s: SelectionValuesT['siblings']): LeadPoints {
  const live_n = siblings.filter((x) => x.live_business === true).length;
  const parked_n = siblings.filter((x) => x.live_business === false && (x.site_state === 'parked_or_for_sale' || x.site_state === 'redirect_off_domain' || x.site_state === 'default_page')).length;
  const lc = Math.min(live_n, s.live_counted_max);
  const pc = Math.min(parked_n, s.parked_counted_max);
  const raw = lc * s.points_live + pc * s.points_parked;
  const points = Math.min(s.max, raw);
  const formula = `min(${s.max}, ${s.points_live} x ${lc} live (of ${live_n}, counted up to ${s.live_counted_max}) + ${s.points_parked} x ${pc} parked (of ${parked_n}, counted up to ${s.parked_counted_max})) = ${points}`;
  return { points, formula, live_n, parked_n };
}

let dataLexicon: ReturnType<typeof loadDataLexicon> | null = null;
const FORM_LISTS = ['trade', 'regime', 'tech', 'generic_head', 'state', 'legal', 'city_extra', 'dictionary_extra'];

/** The word split of a name: the newest stored `form` result, else a fresh analysis, else the whole SLD. */
async function tokensOf(db: Kysely<Database>, domain: string, values: SelectionValuesT): Promise<string[]> {
  const sld = domain.replace(/\.com$/, '');
  const form = await db.selectFrom('screening_results').select('fields').where('domain', '=', domain).where('check_id', '=', 'form').orderBy('checked_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
  const stored = (form?.fields as { tokens?: unknown } | undefined)?.tokens;
  if (Array.isArray(stored) && stored.every((t) => typeof t === 'string') && stored.length > 0) return stored as string[];
  try {
    dataLexicon ??= loadDataLexicon();
    const lists = await currentLists(db, FORM_LISTS);
    const lex: Lexicon = buildLexicon(dataLexicon, lists, { cityOneToken: values.form.geo_city_one_token, cityWordAllowlist: values.form.city_word_allowlist });
    const f = analyzeForm(domain, 'S3', lex, values.form, {});
    return Array.isArray(f.tokens) && f.tokens.length > 0 ? f.tokens : [sld];
  } catch {
    return [sld];
  }
}

/** v4.2.2 (CR-052 S-3): titles of web-server and hosting default or placeholder pages. */
const DEFAULT_PAGE_TITLE = /\b(default (web )?(site|page)|welcome to (nginx|openresty|caddy)|apache2?\b.*\b(default|test) page|test page for|index of \/|coming soon|under construction|it works!?$|site not (configured|found)|domain (has been )?registered|future home of)/i;
export const isDefaultPageTitle = (title: string): boolean => DEFAULT_PAGE_TITLE.test(title.trim());

const statusOf = (p: PageFetch | null): number | null => (p === null ? null : p.status ?? null);

export interface ScanOpts { now: () => number; by: string; auditId: string | null }

/** Scans each domain in turn under one time budget and appends one `sibling_scans` row per domain. */
export async function scanSiblings(db: Kysely<Database>, deps: ScreeningDeps, domains: string[], o: ScanOpts): Promise<SiblingScan[]> {
  const sel = await activeSelectionSettings(db);
  const values = sel.values;
  const cfg = values.siblings;
  const lists = await currentLists(db, ['sig_parked', 'sig_forsale']);
  const pageLists = lists.sig_parked && lists.sig_forsale ? { parked: lists.sig_parked.terms, forsale: lists.sig_forsale.terms } : null;
  const shared = new Map<string, unknown>();
  const deadline = o.now() + cfg.time_budget_seconds * 1000;
  const maxAgeHours = values.freshness_hours.lookalikes ?? values.freshness_hours.ext_dates ?? 0;
  const pace = new Pacer(values.same_name.min_ms_between_fetches, 1, deps.sleep, o.now);
  const robots = new Map<string, { text: string }>();
  const out: SiblingScan[] = [];

  for (const domain of domains) {
    const tokens = await tokensOf(db, domain, values);
    const ctx = {
      db, run: { id: 'sibling-scan', mode: 'live', backtest: false, buyHold: false, trancheId: null, createdAt: new Date(o.now()) }, item: { idx: 0, domain, lane: 'S3', leads_ab: 0 },
      settings: values, settingsLabel: sel.label, latest: () => undefined, ahead: () => [], lists,
      lexicon: { types: new Map(), versions: {} }, deps, now: o.now, deadline, shared,
    } as unknown as CheckContext;
    dataLexicon ??= loadDataLexicon();
    const all = lookalikeNames(domain.replace(/\.com$/, ''), tokens, cfg, dataLexicon.dictionary);
    const names = all.slice(0, cfg.max_checks);
    const scanAt = new Date(o.now());
    let calls = 0;
    const evidence: number[] = [];
    const siblings: Sibling[] = [];
    const prefetched = await prefetchStored(db, names.map((n) => n.domain), { maxAgeHours, now: o.now });
    for (const n of names) {
      const pr = await probeLookalike(ctx, n, { maxAgeHours, lists: pageLists, pace, robots, prefetched });
      calls += pr.calls;
      evidence.push(...pr.evidence);
      const it = pr.item;
      const page = pr.page;
      const read = page !== null && page.ok && page.html !== '' ? page : null;
      const title = read ? scrub(titleOf(read.html)) : null;
      // v4.2.2 (CR-052 S-3): a hosting default page ("Default Site - Home", "Welcome to nginx", "Index of /") is registered but not a business.
      const defaultPage = pr.site?.site_state === 'in_use' && title !== null && isDefaultPageTitle(title);
      const live = pr.site?.site_state === 'in_use' && !defaultPage && page?.ok === true && page.status === 200;
      const s: Sibling = {
        domain: it.domain, kind: it.kind, registered: it.registered, reason_code: it.reason_code,
        live_business: it.registered === false ? false : it.registered === null ? null : live ? true : pr.site !== null && pr.site.site_state !== 'unknown' ? false : null,
        site_state: defaultPage ? 'default_page' : pr.site?.site_state ?? null,
        url: page === null ? null : page.finalUrl ?? `https://${it.domain}/`,
        http_status: statusOf(page),
        fetched_at: (page !== null ? new Date(o.now()) : pr.rdapCheckedAt ?? scanAt).toISOString(),
        title,
        company: read && !defaultPage ? scrub(ogSiteName(read.html) ?? titleOf(read.html)) : null,
        contact_url: read && live ? contactUrlOf(read.html, read.finalUrl) : null,
      };
      siblings.push(s);
    }
    const lead_points = leadPointsOf(siblings, cfg);
    const complete = !siblings.some((s) => s.reason_code === 'TIMEOUT');
    const skipped_n = all.length - names.length;
    await db.insertInto('sibling_scans').values({
      domain, fetched_at: scanAt, settings_label: sel.label, siblings: JSON.stringify(siblings), lead_points: JSON.stringify(lead_points), complete, skipped_n,
      upstream_calls: calls, evidence_ids: JSON.stringify(evidence), recorded_by: o.by, audit_id: o.auditId,
    }).execute();
    out.push({ domain, fetched_at: scanAt.toISOString(), settings_version: sel.label, complete, skipped_n, upstream_calls: calls, siblings, lead_points });
  }
  return out;
}

/** The newest stored scan of a domain, or null. */
export async function latestSiblingScan(db: Kysely<Database>, domain: string): Promise<SiblingScan | null> {
  const r = await db.selectFrom('sibling_scans').selectAll().where('domain', '=', domain).orderBy('id', 'desc').limit(1).executeTakeFirst();
  if (!r) return null;
  const siblings = r.siblings as Sibling[];
  const lead_points = r.lead_points as LeadPoints;
  return { domain: r.domain, fetched_at: r.fetched_at.toISOString(), settings_version: r.settings_label, complete: r.complete, skipped_n: r.skipped_n, upstream_calls: r.upstream_calls, siblings, lead_points };
}
