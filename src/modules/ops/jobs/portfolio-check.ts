// Daily step `portfolioCheck` (CR-007 G-5): is each live name still ours at the registry, is its for-sale lander still up, is it on a blocklist.
// Read-only toward the outside: RDAP, one guarded GET of the name's own site, SURBL and Web Risk lookups. It never calls a registrar API,
// never changes nameservers or listings, and sends nothing; its one domain-row write (v5.44.0) is `transfer_confirmed` / `transfer_checked_at` of an S8 name until the transfer is confirmed. It writes only its own append-only rows (portfolio_checks), the
// Web Risk usage counter and one audit row. `/report` raises REGISTRY_MISMATCH, LANDER_DOWN and OWNED_NAME_BLOCKLISTED from those rows.
import { trySessionLock } from '../../../core/locks.js';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types.js';
import { idtDay } from '../../../core/dates.js';
import { writeJobAudit } from '../../../http/audit.js';
import { BlockedError, safeFetch } from '../../../core/safe-fetch.js';
import { USER_AGENT, registrarMatches, type RdapLookupFn } from '../../../core/rdap.js';
import { surblCheck } from '../../selection/index.js';
import { activeSelectionSettings } from '../../selection/index.js';
import type { CheckContext, ScreeningDeps } from '../../selection/index.js';
import { readCappedBytes } from '../../selection/index.js';
import { webRiskLookup } from '../../selection/index.js';
import { ownershipSummary } from '../../reporting/index.js';

type Status = 'ok' | 'fail' | 'unknown';
type Kind = 'registry' | 'web' | 'blocklist' | 'price';

/** Statuses that mean the name is not freely ours (compared lowercase, without spaces, so `pendingDelete` and `pending delete` are the same). */
const BAD_REGISTRY_STATUSES = ['client hold', 'server hold', 'pending delete', 'redemption period'] as const;
/** What a working lander's front page (or its Location header) contains. A lander without an entry only has to answer 2xx or 3xx. */
const LANDER_SIGNATURES: Readonly<Record<string, RegExp[]>> = { afternic: [/\/lander/i, /afternic/i, /godaddy/i], sedo: [/sedo/i] };
const WEB_CHECK_TIMEOUT_MS = 10_000;
/** v4.0.0 (CR-049 item 3): the lander page is read up to this many bytes per hop, through at most LANDER_MAX_HOPS redirects. */
const LANDER_BODY_BYTES = 512_000;
const LANDER_MAX_HOPS = 3;
const TLS_ERROR = /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME|HOSTNAME_MISMATCH/i;

const AMOUNT = String.raw`\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?`;
/** 5.66.0 (BUG-054): an amount right after offer-form validation copy ("Offer cannot exceed $49,999,999") or a page-wide ceiling is never the Buy Now price. */
const LIMIT_COPY = /(?:exceed|cannot|limit|minimum|maximum|at\s+least|less\s+than|more\s+than|between|offer\s+must|must\s+be\s+below)\W*(?:\w+\W+){0,2}$/i;
const PLACEHOLDER_MIN_CENTS = 1_000_000_000; // $10,000,000: Afternic's offer ceiling $49,999,999 and similar
/** The Buy Now amount a lander page shows, in cents, or null when the page shows none.
 * 5.66.0 (BUG-054): "buy it now for $X" first; skipping amounts after limit copy and placeholder ceilings.
 * 5.68.0 (BUG-056): the tight "buy it now for $X" pattern (with required "for") is tried first across the
 * whole page before falling back to proximity patterns; this prevents a generic "Buy Now" near an unrelated
 * amount ($100,000 offer cap, lease copy) from winning over the actual buyer-visible price. */
function shownBuyNowCents(text: string): number | null {
  const cents = (m: RegExpExecArray) => Number(m[1]!.replace(/,/g, '')) * 100 + Number(m[2] ?? 0);
  const usable = (m: RegExpExecArray, at: number) => {
    const c = cents(m);
    return c > 0 && c < PLACEHOLDER_MIN_CENTS && !LIMIT_COPY.test(text.slice(Math.max(0, at - 40), at)) ? c : null;
  };
  const patterns: Array<[RegExp, (m: RegExpExecArray) => number]> = [
    // Tight: "buy it now for $X" — the Afternic buyer-visible text; requires both "it" and "for"
    [new RegExp(String.raw`buy\s+it\s+now\s+for\s+(?:US)?${AMOUNT}`, 'gi'), (m) => m.index + m[0].indexOf('$')],
    [new RegExp(String.raw`buy\s*(?:it\s*)?now\s*(?:for|price)?\s*:?\s*(?:US)?${AMOUNT}`, 'gi'), (m) => m.index + m[0].indexOf('$')],
    [new RegExp(String.raw`buy\s*(?:it\s*)?now[^$]{0,80}${AMOUNT}`, 'gi'), (m) => m.index + m[0].lastIndexOf('$')],
    [new RegExp(String.raw`${AMOUNT}[^<]{0,40}buy\s*(?:it\s*)?now`, 'gi'), (m) => m.index],
  ];
  for (const [re, dollarAt] of patterns) {
    for (const m of text.matchAll(re)) {
      const c = usable(m, dollarAt(m));
      if (c !== null) return c;
    }
  }
  return null;
}
/** The price check of a readable lander page: shown Buy Now against the plan BIN; null shown = the page shows no amount (often script-rendered): unknown, never a mismatch. */
function landerPriceCheck(text: string, d: { bin_cents: number | null; listing_mode: string | null }): { status: Status; details: Record<string, unknown> } | null {
  if (d.bin_cents === null) return null;
  const shown = shownBuyNowCents(text);
  const makeOffer = /make\s+(?:an\s+)?offer|submit\s+(?:an\s+)?offer|your\s+offer/i.test(text);
  const wantsOffer = d.listing_mode === 'hybrid' || d.listing_mode === 'offer';
  const details = { expected_cents: d.bin_cents, shown_cents: shown, make_offer_shown: makeOffer, make_offer_expected: wantsOffer };
  if (shown === null) return { status: 'unknown', details: { ...details, reason: 'no_price_text' } };
  return { status: shown === d.bin_cents ? 'ok' : 'fail', details };
}
/** A name's blocklist lookup is repeated when its latest one is at least this old. */
const BLOCKLIST_EVERY_DAYS = 7;

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, '');
const tally = () => ({ ok: 0, fail: 0, unknown: 0 });

export interface PortfolioCheckSummary {
  dryRun: boolean; skipped: boolean; checked: number;
  registry: { ok: number; fail: number; unknown: number };
  web: { ok: number; fail: number; unknown: number; skipped: number };
  blocklist: { ok: number; fail: number; unknown: number; skipped: number };
  names: { domain: string; registry: Status; web: Status | 'skipped'; blocklist: Status | 'skipped' }[];
  /** v5.58.0 (CR-079): the missing-name check, read from the same list GET /report builds: warn and error rows of the ownership codes, and the count of each code (info rows included). */
  alerts_n?: number;
  by_code?: Record<string, number>;
}

export class PortfolioCheckJob {
  constructor(private readonly deps: {
    db: Kysely<Database>; rdapLookup: RdapLookupFn; screening: ScreeningDeps; now: () => number;
    log?: { warn(o: object, m: string): void };
  }) {}

  async runOnce(opts: { dryRun?: boolean } = {}): Promise<PortfolioCheckSummary> {
    const dryRun = opts.dryRun ?? false;
    const out: PortfolioCheckSummary = { dryRun, skipped: false, checked: 0, registry: tally(), web: { ...tally(), skipped: 0 }, blocklist: { ...tally(), skipped: 0 }, names: [] };
    const lock = await trySessionLock(this.deps.db, 'job:portfolio-check');
    if (!lock) return { ...out, skipped: true };
    try {
      const { db } = this.deps;
      const doms = await db.selectFrom('domains')
        .select(['id', 'domain', 'status', 'registrar', 'lane', 'transfer_confirmed', 'expiry_date', 'lander', 'lander_ns', 'ns_verified_at', 'lander_pending', 'bin_cents', 'listing_mode'])
        .where('status', 'in', ['owned', 'listed', 'delisted']).orderBy('domain').execute();
      const shared = new Map<string, unknown>([['surbl_no_evidence', true]]); // one SURBL proof per run, and no screening evidence rows
      for (const d of doms) {
        out.checked += 1;
        const row = { domain: d.domain, registry: 'unknown' as Status, web: 'skipped' as Status | 'skipped', blocklist: 'skipped' as Status | 'skipped' };
        const reg: { status: Status; details: Record<string, unknown>; transfer?: boolean | null } = await this.registry(d).catch((e: Error) => ({ status: 'unknown' as Status, details: { reason: 'ERROR', message: e.message.slice(0, 120) } }));
        row.registry = reg.status;
        // v5.44.0: an S8 name whose transfer is not confirmed yet: RDAP's registrar is ours (true), another one (false) or unreadable (null); checked daily until true.
        // The one domain-row write of this job: two columns, nothing else.
        if (d.lane === 'S8' && d.transfer_confirmed !== true && !dryRun) {
          await db.updateTable('domains').set({ transfer_confirmed: reg.transfer ?? null, transfer_checked_at: new Date(this.deps.now()) }).where('id', '=', d.id).execute();
        }
        out.registry[reg.status] += 1;
        await this.write(d.id, 'registry', reg, dryRun);

        const both = d.status === 'listed' && d.lander_ns !== null && d.ns_verified_at !== null && !d.lander_pending
          ? await this.web(d).catch((e: Error) => ({ web: { status: 'unknown' as Status, details: { reason: 'ERROR', message: e.message.slice(0, 120) } }, price: null }))
          : null;
        if (both) {
          row.web = both.web.status;
          out.web[both.web.status] += 1;
          await this.write(d.id, 'web', both.web, dryRun);
          if (both.price) await this.write(d.id, 'price', both.price, dryRun);
        } else out.web.skipped += 1;

        if (await this.blocklistDue(d.id)) {
          const bl = await this.blocklist(d.domain, shared, dryRun).catch((e: Error) => ({ status: 'unknown' as Status, details: { reason: 'ERROR', message: e.message.slice(0, 120) } }));
          row.blocklist = bl.status;
          out.blocklist[bl.status] += 1;
          await this.write(d.id, 'blocklist', bl, dryRun);
        } else out.blocklist.skipped += 1;
        out.names.push(row);
      }
      const own = await ownershipSummary(db, new Date(this.deps.now()));
      out.alerts_n = own.alerts_n;
      out.by_code = own.by_code;
      if (!dryRun) {
        await writeJobAudit(db, {
          path: 'portfolio-check', request: {}, at: new Date(this.deps.now()),
          summary: `checked ${out.checked}; registry fail ${out.registry.fail}; web fail ${out.web.fail}; blocklist fail ${out.blocklist.fail}`,
        });
      }
      return out;
    } finally {
      await lock.release();
    }
  }

  private async write(domainId: number, kind: Kind, r: { status: Status; details: Record<string, unknown> }, dryRun: boolean): Promise<void> {
    if (dryRun) return;
    await this.deps.db.insertInto('portfolio_checks').values({ domain_id: domainId, at: new Date(this.deps.now()), kind, status: r.status, details: JSON.stringify(r.details) }).execute();
  }

  private async registry(d: { domain: string; registrar: string | null; expiry_date: string | null }): Promise<{ status: Status; details: Record<string, unknown>; transfer?: boolean | null }> {
    const r = await this.deps.rdapLookup(d.domain);
    if (r.outcome === 'unknown' || (r.outcome === 'registered' && !r.facts)) return { status: 'unknown', details: { reason: r.reasonCode ?? 'SOURCE_ERROR', http_status: r.httpStatus } };
    if (r.outcome === 'not_registered') {
      return { status: 'fail', details: { registered: false, differences: [{ field: 'registered', ours: true, registry: false }] }, transfer: false };
    }
    const f = r.facts!;
    const differences: { field: string; ours: unknown; registry: unknown }[] = [];
    const transfer = d.registrar && f.registrar ? registrarMatches(d.registrar, f.registrar) : null;
    if (d.registrar && f.registrar) {
      if (!registrarMatches(d.registrar, f.registrar)) differences.push({ field: 'registrar', ours: d.registrar, registry: f.registrar });
    }
    const expiry = f.expires_at ? f.expires_at.slice(0, 10) : null;
    if (d.expiry_date && expiry && expiry !== String(d.expiry_date).slice(0, 10)) differences.push({ field: 'expiry_date', ours: String(d.expiry_date).slice(0, 10), registry: expiry });
    for (const bad of BAD_REGISTRY_STATUSES) {
      const hit = f.statuses.find((s) => squash(s) === squash(bad));
      if (hit) differences.push({ field: 'status', ours: 'no hold or deletion status', registry: hit });
    }
    if (differences.length > 0) return { status: 'fail', details: { differences }, transfer };
    return { status: 'ok', details: { registrar: f.registrar, expiry_date: expiry, statuses: f.statuses }, transfer };
  }

  /**
   * The daily lander check of our own name (CR-044 item 1, CR-049 item 3): GET https://<name>/ through the outbound guard, following up to LANDER_MAX_HOPS redirects
   * (Afternic's lander), a TLS failure is a miss. `price` is the second check on the page the buyer sees: the Buy Now amount shown against the plan's BIN, and a make-offer option.
   */
  private async web(d: { domain: string; lander: string | null; bin_cents: number | null; listing_mode: string | null }): Promise<{ web: { status: Status; details: Record<string, unknown> }; price: { status: Status; details: Record<string, unknown> } | null }> {
    const { screening } = this.deps;
    const unknown = (reason: string, extra: Record<string, unknown> = {}) => ({ web: { status: 'unknown' as Status, details: { reason, ...extra } }, price: null });
    let url = `https://${d.domain}/`;
    let res: Response | null = null;
    let body = '';
    const locations: string[] = [];
    const bodies: string[] = [];
    for (let hop = 0; hop <= LANDER_MAX_HOPS; hop++) {
      try {
        res = await safeFetch({ fetch: screening.siteFetch, lookupHost: screening.lookupHost }, url,
          { redirect: 'manual', headers: { 'user-agent': USER_AGENT, accept: 'text/html,*/*;q=0.5' }, signal: AbortSignal.timeout(WEB_CHECK_TIMEOUT_MS) });
      } catch (e) {
        const name = (e as { name?: string })?.name;
        const code = (e as { cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code ?? '';
        if (TLS_ERROR.test(code)) return { web: { status: 'fail', details: { reason: 'tls_error', tls_code: code, ...(hop > 0 ? { url } : {}) } }, price: null };
        return unknown(e instanceof BlockedError ? e.code : name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network_error');
      }
      const location = res.headers.get('location');
      if (location) locations.push(location);
      try {
        body = (await readCappedBytes(res, LANDER_BODY_BYTES)).bytes.toString('utf8');
      } catch {
        return unknown('network_error', { status_code: res.status });
      }
      bodies.push(body);
      if (res.status >= 300 && res.status < 400 && location && hop < LANDER_MAX_HOPS) {
        try { url = new URL(location, url).toString(); } catch { break; }
        continue;
      }
      break;
    }
    const code = res!.status;
    const location = locations[0] ?? null;
    if (code < 200 || code >= 400) return { web: { status: 'fail', details: { status_code: code, ...(location ? { location } : {}), reason: 'http_status' } }, price: null };
    const sigs = d.lander ? LANDER_SIGNATURES[d.lander] : undefined;
    const hay = [...locations, ...bodies].join('\n');
    const matches = !sigs || sigs.length === 0 || sigs.some((re) => re.test(hay));
    const web = matches
      ? { status: 'ok' as Status, details: { status_code: code, ...(location ? { location } : {}) } }
      : { status: 'fail' as Status, details: { status_code: code, ...(location ? { location } : {}), reason: 'no_lander_signature' } };
    return { web, price: matches ? landerPriceCheck(bodies.join('\n'), d) : null };
  }

  private async blocklistDue(domainId: number): Promise<boolean> {
    const last = await this.deps.db.selectFrom('portfolio_checks').select('at').where('domain_id', '=', domainId).where('kind', '=', 'blocklist')
      .orderBy('id', 'desc').limit(1).executeTakeFirst();
    if (!last) return true;
    // weekly by IDT calendar day: due when the last check's day is at least 7 days before today's
    const today = idtDay(new Date(this.deps.now()));
    const dueDay = idtDay(new Date(Date.parse(`${today}T12:00:00Z`) - BLOCKLIST_EVERY_DAYS * 86_400_000));
    return idtDay(last.at) <= dueDay;
  }

  private async blocklist(domain: string, shared: Map<string, unknown>, dryRun: boolean): Promise<{ status: Status; details: Record<string, unknown> }> {
    const { db, screening, now } = this.deps;
    const settings = (await activeSelectionSettings(db)).values;
    const ctx = {
      db, run: {}, item: { domain }, settings, settingsLabel: 'portfolio-check', latest: () => undefined, ahead: () => [], lists: {},
      lexicon: { types: new Map(), versions: {} }, deps: screening, now, deadline: Number.MAX_SAFE_INTEGER, shared,
    } as unknown as CheckContext;
    const hits: string[] = [];
    const clean: string[] = [];
    const unknown: Record<string, string> = {};
    const s = await surblCheck.run(ctx);
    if (s.status === 'FAIL') hits.push(`surbl:${((s.fields.lists as string[] | undefined) ?? []).join(',')}`);
    else if (s.status === 'PASS') clean.push('surbl');
    else unknown.surbl = s.reasonCode ?? 'UNKNOWN';
    if (screening.webRiskApiKey && !dryRun) { // a dry run never spends a counted Web Risk lookup
      const w = await webRiskLookup({ db, fetch: screening.fetch, apiKey: screening.webRiskApiKey, now }, domain);
      if (w.kind === 'match') hits.push(`web_risk:${w.threatTypes.join(',')}`);
      else if (w.kind === 'clean') clean.push('web_risk');
      else unknown.web_risk = w.reason;
    }
    if (hits.length > 0) return { status: 'fail', details: { sources: hits, clean, unknown } };
    // v2.6.0 (N-3): ok only when every source that was asked answered clean; one unknown source leaves the name unknown.
    if (clean.length > 0 && Object.keys(unknown).length === 0) return { status: 'ok', details: { sources: [], clean, unknown } };
    return { status: 'unknown', details: { sources: [], clean, unknown } };
  }
}
