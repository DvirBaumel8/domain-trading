// Daily step `portfolioCheck` (CR-007 G-5): is each live name still ours at the registry, is its for-sale lander still up, is it on a blocklist.
// Read-only toward the outside: RDAP, one guarded GET of the name's own site, SURBL and Web Risk lookups. It never calls a registrar API,
// never changes nameservers, listings or domain rows, and sends nothing. It writes only its own append-only rows (portfolio_checks), the
// Web Risk usage counter and one audit row. `/report` raises REGISTRY_MISMATCH, LANDER_DOWN and OWNED_NAME_BLOCKLISTED from those rows.
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { newAuditId } from '../http/audit.js';
import { BlockedError, safeFetch } from '../net/safe-fetch.js';
import { USER_AGENT, type RdapLookupFn } from '../rdap.js';
import { surblCheck } from '../screening/checks/surbl.js';
import { activeSelectionSettings } from '../screening/settings.js';
import type { CheckContext, ScreeningDeps } from '../screening/types.js';
import { readCappedBytes } from '../screening/wayback.js';
import { webRiskLookup } from '../screening/web-risk.js';

type Status = 'ok' | 'fail' | 'unknown';
type Kind = 'registry' | 'web' | 'blocklist';

/** How our `domains.registrar` code appears in an RDAP registrar name. An unlisted code is compared as a case-insensitive substring. */
export const REGISTRAR_NAME_PATTERNS: Readonly<Record<string, RegExp>> = { godaddy: /godaddy/i, porkbun: /porkbun/i, dynadot: /dynadot/i };
/** Statuses that mean the name is not freely ours (compared lowercase, without spaces, so `pendingDelete` and `pending delete` are the same). */
export const BAD_REGISTRY_STATUSES = ['client hold', 'server hold', 'pending delete', 'redemption period'] as const;
/** What a working lander's front page (or its Location header) contains. A lander without an entry only has to answer 2xx or 3xx. */
export const LANDER_SIGNATURES: Readonly<Record<string, RegExp[]>> = { afternic: [/\/lander/i, /afternic/i, /godaddy/i], sedo: [/sedo/i] };
export const WEB_CHECK_TIMEOUT_MS = 10_000;
export const WEB_BODY_BYTES = 4096;
/** A name's blocklist lookup is repeated when its latest one is at least this old. */
export const BLOCKLIST_EVERY_MS = 7 * 86_400_000;

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
  private running = false;

  constructor(private readonly deps: {
    db: Kysely<Database>; rdapLookup: RdapLookupFn; screening: ScreeningDeps; now: () => number;
    log?: { warn(o: object, m: string): void };
  }) {}

  async runOnce(opts: { dryRun?: boolean } = {}): Promise<PortfolioCheckSummary> {
    const dryRun = opts.dryRun ?? false;
    const out: PortfolioCheckSummary = { dryRun, skipped: false, checked: 0, registry: tally(), web: { ...tally(), skipped: 0 }, blocklist: { ...tally(), skipped: 0 }, names: [] };
    if (this.running) return { ...out, skipped: true };
    this.running = true;
    try {
      const { db } = this.deps;
      const doms = await db.selectFrom('domains')
        .select(['id', 'domain', 'status', 'registrar', 'expiry_date', 'lander', 'lander_ns', 'ns_verified_at', 'lander_pending'])
        .where('status', 'in', ['owned', 'listed', 'delisted']).orderBy('domain').execute();
      const shared = new Map<string, unknown>([['surbl_no_evidence', true]]); // one SURBL proof per run, and no screening evidence rows
      for (const d of doms) {
        out.checked += 1;
        const row = { domain: d.domain, registry: 'unknown' as Status, web: 'skipped' as Status | 'skipped', blocklist: 'skipped' as Status | 'skipped' };
        const reg = await this.registry(d).catch((e: Error) => ({ status: 'unknown' as Status, details: { reason: 'ERROR', message: e.message.slice(0, 120) } }));
        row.registry = reg.status;
        out.registry[reg.status] += 1;
        await this.write(d.id, 'registry', reg, dryRun);

        const web = d.status === 'listed' && d.lander_ns !== null && d.ns_verified_at !== null && !d.lander_pending ? await this.web(d).catch((e: Error) => ({ status: 'unknown' as Status, details: { reason: 'ERROR', message: e.message.slice(0, 120) } })) : null;
        if (web) {
          row.web = web.status;
          out.web[web.status] += 1;
          await this.write(d.id, 'web', web, dryRun);
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
      this.running = false;
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

  private async web(d: { domain: string; lander: string | null }): Promise<{ status: Status; details: Record<string, unknown> }> {
    const { screening } = this.deps;
    let res: Response;
    try {
      res = await safeFetch({ fetch: screening.siteFetch, lookupHost: screening.lookupHost }, `http://${d.domain}/`,
        { redirect: 'manual', headers: { 'user-agent': USER_AGENT, accept: 'text/html,*/*;q=0.5' }, signal: AbortSignal.timeout(WEB_CHECK_TIMEOUT_MS) });
    } catch (e) {
      const name = (e as { name?: string })?.name;
      const reason = e instanceof BlockedError ? e.code : name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network_error';
      return { status: 'unknown', details: { reason } };
    }
    const location = res.headers.get('location');
    let body = '';
    try {
      body = (await readCappedBytes(res, WEB_BODY_BYTES)).bytes.toString('utf8');
    } catch {
      return { status: 'unknown', details: { reason: 'network_error', status_code: res.status } };
    }
    const code = res.status;
    if (code < 200 || code >= 400) return { status: 'fail', details: { status_code: code, ...(location ? { location } : {}), reason: 'http_status' } };
    const sigs = d.lander ? LANDER_SIGNATURES[d.lander] : undefined;
    if (!sigs || sigs.length === 0 || sigs.some((re) => re.test(location ?? '') || re.test(body))) return { status: 'ok', details: { status_code: code, ...(location ? { location } : {}) } };
    return { status: 'fail', details: { status_code: code, ...(location ? { location } : {}), reason: 'no_lander_signature' } };
  }

  private async blocklistDue(domainId: number): Promise<boolean> {
    const last = await this.deps.db.selectFrom('portfolio_checks').select('at').where('domain_id', '=', domainId).where('kind', '=', 'blocklist')
      .orderBy('id', 'desc').limit(1).executeTakeFirst();
    return !last || this.deps.now() - last.at.getTime() >= BLOCKLIST_EVERY_MS;
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
