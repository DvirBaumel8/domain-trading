// v3.3.0 (CR-023 B): the firms a scout says already sell or deploy the exact service ("sellers"), and their verification. The list arrives on intake
// (`candidate_intake.sellers`) or as a `sellers` record (`domain_records`); the newer one wins. Screening fetches each URL with the same safe, paced
// fetcher the same-name check uses and counts an entry as verified when the page answers 2xx and is not parked or for sale. One registrable domain counts once.
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../db/types.js';
import { currentLists } from './lists.js';
import { Pacer } from './rdap-batch.js';
import type { SelectionValuesT } from './settings.js';
import { classifySite, fetchPage, type RobotsRule } from './site.js';
import type { CheckContext } from './types.js';

export const SELLERS_KIND = 'sellers';
export const SELLERS_MAX = 10;
/** The window of a sellers list when the settings have no `freshness_hours.sellers` (hours). */
export const SELLERS_FRESH_HOURS_DEFAULT = 720;
const HOUR_MS = 3_600_000;

const httpUrl = z.string().trim().min(1).max(500).refine((u) => {
  try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; }
}, 'an http or https URL');
export const SellerEntry = z.object({ name: z.string().trim().min(1).max(100), url: httpUrl }).strict();
export const SellersList = z.array(SellerEntry).max(SELLERS_MAX);
export type SellerEntryT = z.infer<typeof SellerEntry>;

export const sellersFreshHours = (s: Pick<SelectionValuesT, 'freshness_hours'>): number => s.freshness_hours.sellers ?? SELLERS_FRESH_HOURS_DEFAULT;
export const sellersFreshUntil = (checkedAt: Date, freshHours: number): Date => new Date(checkedAt.getTime() + freshHours * HOUR_MS);
export const sellersFresh = (checkedAt: Date, freshHours: number, nowMs: number): boolean => checkedAt.getTime() <= nowMs + 60_000 && sellersFreshUntil(checkedAt, freshHours).getTime() > nowMs;

/** Whether any tier clause reads `sellers_verified_n` (only then does a screening run fetch seller pages). */
export function tierUsesSellers(tier: SelectionValuesT['tier']): boolean {
  return Object.values(tier.clauses).some((c) => c !== undefined && ('all' in c ? c.all : c.any).some((x) => 'f' in x && (x.f === 'sellers_verified_n' || x.f === 'sellers_unknown_n')));
}

const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'or', 'ne', 'go']);
/** The registrable domain of a host: the last two labels, or three under a two-letter country code with a common second level (acme.co.uk). No public-suffix list is shipped. */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const tld = labels[labels.length - 1]!;
  const take = tld.length === 2 && SECOND_LEVEL.has(labels[labels.length - 2]!) ? 3 : 2;
  return labels.slice(-take).join('.');
}

export interface SellersFound {
  state: 'none' | 'stale' | 'list';
  source: 'intake' | 'record' | null;
  /** Intake: when it was received. Record: when the check was done. */
  at: Date | null;
  list: SellerEntryT[];
}

/**
 * The name's sellers list: the newest of its newest intake list and its newest `sellers` record (a drop-list name has none from intake: Q3).
 * `stale`: the newest list is older than the window (ignored, unknown). `none`: no list at all.
 */
export async function findSellers(db: Kysely<Database>, domain: string, o: { runId: string; nowMs: number; freshHours: number }): Promise<SellersFound> {
  const rec = await db.selectFrom('domain_records').select(['record', 'checked_at']).where('domain', '=', domain).where('kind', '=', SELLERS_KIND)
    .where('checked_at', '<=', new Date(o.nowMs + 60_000)).orderBy('checked_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
  const dropList = await db.selectFrom('candidate_screenings').select('id').where('run_id', '=', o.runId).where('domain', '=', domain).where('origin', '=', 'drop_list').limit(1).executeTakeFirst();
  const intake = dropList ? undefined : await db.selectFrom('candidate_intake').select(['sellers', 'received_at']).where('domain', '=', domain)
    .where('status', 'in', ['queued', 'duplicate']).where('sellers', 'is not', null).orderBy('received_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
  const cands: { source: 'intake' | 'record'; at: Date; raw: unknown }[] = [];
  if (rec) cands.push({ source: 'record', at: rec.checked_at, raw: rec.record });
  if (intake) cands.push({ source: 'intake', at: intake.received_at, raw: intake.sellers });
  cands.sort((a, b) => b.at.getTime() - a.at.getTime());
  const top = cands[0];
  if (!top) return { state: 'none', source: null, at: null, list: [] };
  const parsed = SellersList.safeParse(top.raw);
  if (!sellersFresh(top.at, o.freshHours, o.nowMs)) return { state: 'stale', source: top.source, at: top.at, list: [] };
  return { state: 'list', source: top.source, at: top.at, list: parsed.success ? parsed.data : [] };
}

/**
 * `verified: null` = unknown (v3.4.1, CR-028): the page could not be read (HTTP 401/403/429, or a timeout), which is not the same as "not verified".
 * `http_status`: the status of the answer (null when no answer came). `truncated`: a 2xx page longer than `max_bytes`, judged on its first `max_bytes`.
 */
export interface SellerResult { name: string; url: string; verified: boolean | null; reason: string; http_status: number | null; truncated: boolean }

function sharedPacer(ctx: CheckContext): Pacer {
  const hit = ctx.shared.get('site_pacer') as Pacer | undefined;
  if (hit) return hit;
  const p = new Pacer(ctx.settings.same_name.min_ms_between_fetches, 1, ctx.deps.sleep, ctx.now);
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

/** The number of unknown entries (v3.4.1), one per registrable domain; a domain that is also verified does not count as unknown. */
export function unknownCount(results: SellerResult[]): number {
  const dom = (r: SellerResult): string => { try { return registrableDomain(new URL(r.url).hostname); } catch { return r.url; } };
  const verified = new Set(results.filter((r) => r.verified === true).map(dom));
  return new Set(results.filter((r) => r.verified === null).map(dom).filter((d) => !verified.has(d))).size;
}
/**
 * Fetches each entry's page (robots.txt, pacing, at most `same_name.max_redirects` redirects, the SSRF guard) and decides: verified = a 2xx page that is not parked or for sale.
 * An entry whose registrable domain is already verified is not fetched and counts 0 (`DUPLICATE_DOMAIN`). A missing parked/for-sale signature list verifies nothing (`LIST_MISSING`).
 */
export async function verifySellers(ctx: CheckContext, list: SellerEntryT[]): Promise<{ results: SellerResult[]; upstreamCalls: number }> {
  const s = ctx.settings.same_name;
  const lists = { ...(await currentLists(ctx.db, ['sig_parked', 'sig_forsale'])), ...Object.fromEntries(['sig_parked', 'sig_forsale'].filter((n) => ctx.lists[n]).map((n) => [n, ctx.lists[n]!])) }; // the run's pinned version wins
  const pace = sharedPacer(ctx);
  const robots = sharedRobots(ctx);
  const verifiedDomains = new Set<string>();
  const results: SellerResult[] = [];
  let calls = 0;
  for (const e of list) {
    const out = (verified: boolean | null, reason: string, http_status: number | null = null, truncated = false): void => { results.push({ name: e.name, url: e.url, verified, reason, http_status, truncated }); };
    let host: string;
    try { host = new URL(e.url).hostname; } catch { out(false, 'URL_NOT_ALLOWED'); continue; }
    const reg = registrableDomain(host);
    if (verifiedDomains.has(reg)) { out(false, 'DUPLICATE_DOMAIN'); continue; }
    if (!ctx.settings.sources.business_sites) { out(false, 'SOURCE_DISABLED'); continue; }
    if (!lists.sig_parked || !lists.sig_forsale) { out(false, 'LIST_MISSING'); continue; }
    const page = await fetchPage({ fetch: ctx.deps.siteFetch, lookupHost: ctx.deps.lookupHost }, e.url, {
      timeoutMs: s.timeout_ms, maxBytes: s.max_bytes, maxRedirects: s.max_redirects, pace, robots, neverFetchHosts: ctx.settings.lead.verify.never_fetch_hosts,
      deadline: ctx.deadline, now: ctx.now, onRequest: () => { calls++; }, truncatedOk: true,
    });
    if (!page.ok) {
      const st = page.status ?? null;
      // Unknown: a login wall or bot block (401/403), rate limiting (429), a timeout. Everything else that fails stays "not verified".
      if (st === 401 || st === 403 || st === 429) out(null, `HTTP_${st}`, st);
      else if (page.reasonCode === 'TIMEOUT') out(null, 'TIMEOUT');
      else out(false, page.reasonCode, st);
      continue;
    }
    if (page.status < 200 || page.status >= 300) { out(false, 'REDIRECT_OFF_SITE', page.status); continue; } // a redirect to another host is not followed (not ours to read)
    const c = classifySite(page, host, '', [], { parked: lists.sig_parked.terms, forsale: lists.sig_forsale.terms }, s);
    if (c.site_state === 'parked_or_for_sale') { out(false, 'PARKED_OR_FOR_SALE', page.status, page.truncated); continue; }
    if (c.site_state === 'redirect_off_domain') { out(false, 'REDIRECT_OFF_SITE', page.status, page.truncated); continue; }
    verifiedDomains.add(reg);
    out(true, 'OK', page.status, page.truncated);
  }
  return { results, upstreamCalls: calls };
}
