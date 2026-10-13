// Daily step `portfolioCheck` (CR-007 G-5): is each live name still ours at the registry, is its for-sale lander still up, is it on a blocklist.
// Read-only toward the outside: RDAP, one guarded GET of the name's own site, SURBL and Web Risk lookups. It never calls a registrar API,
// never changes nameservers, listings or domain rows, and sends nothing. It writes only its own append-only rows (portfolio_checks), the
// Web Risk usage counter and one audit row. `/report` raises REGISTRY_MISMATCH, LANDER_DOWN and OWNED_NAME_BLOCKLISTED from those rows.
import { trySessionLock } from '../../../core/locks.js';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types.js';
import { idtDay } from '../../../core/dates.js';
import { newAuditId } from '../../../http/audit.js';
import { BlockedError, safeFetch } from '../../../core/safe-fetch.js';
import { USER_AGENT, type RdapLookupFn } from '../../../core/rdap.js';
import { surblCheck } from '../../selection/index.js';
import { activeSelectionSettings } from '../../selection/index.js';
import type { CheckContext, ScreeningDeps } from '../../selection/index.js';
import { readCappedBytes } from '../../selection/index.js';
import { webRiskLookup } from '../../selection/index.js';

type Status = 'ok' | 'fail' | 'unknown';
type Kind = 'registry' | 'web' | 'blocklist' | 'price';

/** How our `domains.registrar` code appears in an RDAP registrar name. An unlisted code is compared as a case-insensitive substring. */
export const REGISTRAR_NAME_PATTERNS: Readonly<Record<string, RegExp>> = { godaddy: /godaddy/i, porkbun: /porkbun/i, dynadot: /dynadot/i };
/** Statuses that mean the name is not freely ours (compared lowercase, without spaces, so `pendingDelete` and `pending delete` are the same). */
export const BAD_REGISTRY_STATUSES = ['client hold', 'server hold', 'pending delete', 'redemption period'] as const;
/** What a working lander's front page (or its Location header) contains. A lander without an entry only has to answer 2xx or 3xx. */
export const LANDER_SIGNATURES: Readonly<Record<string, RegExp[]>> = { afternic: [/\/lander/i, /afternic/i, /godaddy/i], sedo: [/sedo/i] };
export const WEB_CHECK_TIMEOUT_MS = 10_000;
export const WEB_BODY_BYTES = 4096;
/** v4.0.0 (CR-049 item 3): the lander page is read up to this many bytes per hop, through at most LANDER_MAX_HOPS redirects. */
export const LANDER_BODY_BYTES = 200_000;
export const LANDER_MAX_HOPS = 3;
const TLS_ERROR = /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME|HOSTNAME_MISMATCH/i;

/** The Buy Now amount a lander page shows (an amount within 80 characters after "buy now" / "buy it now"), in cents, or null when the page shows none. */
export function shownBuyNowCents(text: string): number | null {
  const m = /buy\s*(?:it\s*)?now[^$]{0,80}\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?/i.exec(text) ?? /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?[^<]{0,40}buy\s*(?:it\s*)?now/i.exec(text);
  if (!m) return null;
  return Number(m[1]!.replace(/,/g, '')) * 100 + Number(m[2] ?? 0);
}
/** The price check of a readable lander page: shown Buy Now against the plan BIN; null shown = the page shows no amount (often script-rendered): unknown, never a mismatch. */
export function landerPriceCheck(text: string, d: { bin_cents: number | null; listing_mode: string | null }): { status: Status; details: Record<string, unknown> } | null {
  if (d.bin_cents === null) return null;
  const shown = shownBuyNowCents(text);
  const makeOffer = /make\s+(?:an\s+)?offer|submit\s+(?:an\s+)?offer|your\s+offer/i.test(text);
  const wantsOffer = d.listing_mode === 'hybrid' || d.listing_mode === 'offer';
  const details = { expected_cents: d.bin_cents, shown_cents: shown, make_offer_shown: makeOffer, make_offer_expected: wantsOffer };
  if (shown === null) return { status: 'unknown', details: { ...details, reason: 'no_price_text' } };
  return { status: shown === d.bin_cents ? 'ok' : 'fail', details };
}
/** A name's blocklist lookup is repeated when its latest one is at least this old. */
export const BLOCKLIST_EVERY_DAYS = 7;

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, '');
const tally = () => ({ ok: 0, fail: 0, unknown: 0 });

export interface PortfolioCheckSummary {
  dryRun: boolean; skipped: boolean; checked: number;
  registry: { ok: number; fail: number; unknown: number };
  web: { ok: number; fail: number; unknown: number; skipped: number };
  blocklist: { ok: number; fail: number; unknown: number; skipped: number };
  names: { domain: string; registry: Status; web: Status | 'skipped'; blocklist: Status | 'skipped' }[];
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
        .select(['id', 'domain', 'status', 'registrar', 'expiry_date', 'lander', 'lander_ns', 'ns_verified_at', 'lander_pending', 'bin_cents', 'listing_mode'])
        .where('status', 'in', ['owned', 'listed', 'delisted']).orderBy('domain').execute();
      const shared = new Map<string, unknown>([['surbl_no_evidence', true]]); // one SURBL proof per run, and no screening evidence rows
      for (const d of doms) {
        out.checked += 1;
        const row = { domain: d.domain, registry: 'unknown' as Status, web: 'skipped' as Status | 'skipped', blocklist: 'skipped' as Status | 'skipped' };
        const reg = await this.registry(d).catch((e: Error) => ({ status: 'unknown' as Status, details: { reason: 'ERROR', message: e.message.slice(0, 120) } }));
        row.registry = reg.status;
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
      if (!dryRun) {
        await db.insertInto('audit_log').values({
          id: newAuditId(), at: new Date(this.deps.now()), scope: 'job', method: 'JOB', path: 'portfolio-check', request: JSON.stringify({}), status_code: 200,
          result_summary: `checked ${out.checked}; registry fail ${out.registry.fail}; web fail ${out.web.fail}; blocklist fail ${out.blocklist.fail}`,
        }).execute();
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

  private async registry(d: { domain: string; registrar: string | null; expiry_date: string | null }): Promise<{ status: Status; details: Record<string, unknown> }> {
    const r = await this.deps.rdapLookup(d.domain);
    if (r.outcome === 'unknown' || (r.outcome === 'registered' && !r.facts)) return { status: 'unknown', details: { reason: r.reasonCode ?? 'SOURCE_ERROR', http_status: r.httpStatus } };
    if (r.outcome === 'not_registered') {
      return { status: 'fail', details: { registered: false, differences: [{ field: 'registered', ours: true, registry: false }] } };
    }
    const f = r.facts!;
    const differences: { field: string; ours: unknown; registry: unknown }[] = [];
    if (d.registrar && f.registrar) {
      const pattern = REGISTRAR_NAME_PATTERNS[d.registrar];
      const same = pattern ? pattern.test(f.registrar) : f.registrar.toLowerCase().includes(d.registrar.toLowerCase());
      if (!same) differences.push({ field: 'registrar', ours: d.registrar, registry: f.registrar });
    }
    const expiry = f.expires_at ? f.expires_at.slice(0, 10) : null;
    if (d.expiry_date && expiry && expiry !== String(d.expiry_date).slice(0, 10)) differences.push({ field: 'expiry_date', ours: String(d.expiry_date).slice(0, 10), registry: expiry });
    for (const bad of BAD_REGISTRY_STATUSES) {
      const hit = f.statuses.find((s) => squash(s) === squash(bad));
      if (hit) differences.push({ field: 'status', ours: 'no hold or deletion status', registry: hit });
    }
    if (differences.length > 0) return { status: 'fail', details: { differences } };
    return { status: 'ok', details: { registrar: f.registrar, expiry_date: expiry, statuses: f.statuses } };
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
