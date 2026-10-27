// v5.61.0: the Afternic seller API client (api.afternic.com/docs/portfolio-api, released 22 Oct 2026). Domains: list, get, update (PATCH); stats per name (read).
// Auth: `Authorization: sso-key KEY:SECRET`. Limit 150 requests a minute (a sliding-window limiter here, 429 backed off). Money fields are micro-USD (1488000000 = $1,488).
// The key and secret are never logged, never in an error text, never returned. No create / delete here: the daily step reads, the push route updates.
import { scrubSecrets } from '../../core/redact.js';

export type AfternicErrorCode = 'AFTERNIC_AUTH' | 'AFTERNIC_NOT_FOUND' | 'AFTERNIC_RATE_LIMITED' | 'AFTERNIC_REJECTED' | 'AFTERNIC_UNAVAILABLE' | 'AFTERNIC_BAD_RESPONSE';

export class AfternicApiError extends Error {
  constructor(readonly code: AfternicErrorCode, readonly status: number, message: string) { super(message); this.name = 'AfternicApiError'; }
}

/** One domain as the API returns it (fields we read; prices still in micro-USD). `intakeViews` is seen on live reads but is not in the docs. */
export interface AfternicDomainRaw {
  name: string; displayName?: string; buynowPrice?: number | null; floorPrice?: number | null; minbidPrice?: number | null;
  leasingEnabled?: boolean | null; maxLeasePeriod?: number | null; intakeStyle?: string | null; landingPage?: string | null;
  showLanderBuynowOption?: boolean | null; showLanderLeaseToOwnOption?: boolean | null; showLanderMakeOfferOption?: boolean | null;
  hidden?: boolean | null; listStatus?: string | null; updatedAt?: string | null; intakeViews?: unknown;
}

/** The same domain with money in cents. */
export interface AfternicListing {
  name: string; list_status: string | null; bin_cents: number | null; floor_cents: number | null; min_offer_cents: number | null;
  leasing_enabled: boolean | null; max_lease_months: number | null; show_buynow: boolean | null; show_lto: boolean | null; show_offer: boolean | null;
  intake_style: string | null; landing_page: string | null; hidden: boolean | null; updated_at: string | null; intake_views: number | null;
}

/** The fields an update may carry (cents / plain values); only the ones present are sent. */
export interface AfternicUpdate {
  bin_cents?: number; floor_cents?: number; min_offer_cents?: number; leasing_enabled?: boolean; max_lease_months?: number;
  show_buynow?: boolean; show_lto?: boolean; show_offer?: boolean; intake_style?: string; hidden?: boolean;
}

export const MICRO_PER_CENT = 10_000;
export const microOfCents = (c: number): number => c * MICRO_PER_CENT;
export const centsOfMicro = (m: number | null | undefined): number | null => (typeof m === 'number' && Number.isFinite(m) ? Math.round(m / MICRO_PER_CENT) : null);

const PAGE = 100;
const MAX_PAGES = 50;
const PREFIX = '/v3/aftermarket/customers/my';
const MAX_RETRIES_429 = 3;

const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function listingOf(r: AfternicDomainRaw): AfternicListing {
  const views = typeof r.intakeViews === 'number' && Number.isFinite(r.intakeViews) ? Math.trunc(r.intakeViews) : null;
  return {
    name: r.name.toLowerCase(), list_status: str(r.listStatus), bin_cents: centsOfMicro(r.buynowPrice), floor_cents: centsOfMicro(r.floorPrice), min_offer_cents: centsOfMicro(r.minbidPrice),
    leasing_enabled: bool(r.leasingEnabled), max_lease_months: typeof r.maxLeasePeriod === 'number' ? r.maxLeasePeriod : null,
    show_buynow: bool(r.showLanderBuynowOption), show_lto: bool(r.showLanderLeaseToOwnOption), show_offer: bool(r.showLanderMakeOfferOption),
    intake_style: str(r.intakeStyle), landing_page: str(r.landingPage), hidden: bool(r.hidden), updated_at: str(r.updatedAt), intake_views: views,
  };
}

/** The PATCH body of an update: documented field names, prices in micro-USD. */
export function patchBody(u: AfternicUpdate): Record<string, unknown> {
  const b: Record<string, unknown> = {};
  if (u.bin_cents !== undefined) b.buynowPrice = microOfCents(u.bin_cents);
  if (u.floor_cents !== undefined) b.floorPrice = microOfCents(u.floor_cents);
  if (u.min_offer_cents !== undefined) b.minbidPrice = microOfCents(u.min_offer_cents);
  if (u.leasing_enabled !== undefined) b.leasingEnabled = u.leasing_enabled;
  if (u.max_lease_months !== undefined) b.maxLeasePeriod = u.max_lease_months;
  if (u.show_buynow !== undefined) b.showLanderBuynowOption = u.show_buynow;
  if (u.show_lto !== undefined) b.showLanderLeaseToOwnOption = u.show_lto;
  if (u.show_offer !== undefined) b.showLanderMakeOfferOption = u.show_offer;
  if (u.intake_style !== undefined) { b.landingPage = 'SALES_TYPE'; b.intakeStyle = u.intake_style; }
  if (u.hidden !== undefined) b.hidden = u.hidden;
  return b;
}

export interface AfternicClientOptions {
  fetch: typeof fetch; baseUrl: string; apiKey: string; apiSecret: string; timeoutMs?: number;
  /** Test hooks: the clock and the sleep (the limiter and the 429 backoff). */
  now?: () => number; sleep?: (ms: number) => Promise<void>; perMinute?: number;
}

export class AfternicClient {
  private readonly stamps: number[] = [];
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly perMinute: number;

  constructor(private readonly o: AfternicClientOptions) {
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.perMinute = o.perMinute ?? 150;
  }

  /** Sliding window: at most `perMinute` requests in any 60 s; waits when the window is full. */
  private async take(): Promise<void> {
    for (;;) {
      const t = this.now();
      while (this.stamps.length > 0 && t - this.stamps[0]! >= 60_000) this.stamps.shift();
      if (this.stamps.length < this.perMinute) { this.stamps.push(t); return; }
      await this.sleep(Math.max(1, 60_000 - (t - this.stamps[0]!)));
    }
  }

  private clean(text: string): string {
    return scrubSecrets(text, [this.o.apiKey, this.o.apiSecret, `${this.o.apiKey}:${this.o.apiSecret}`]);
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const where = `${method} ${path.split('?')[0]!.replace(/(domains|stats)\/[^/]+$/, '$1/{name}')}`;
    for (let attempt = 0; ; attempt++) {
      await this.take();
      let res: Response;
      try {
        res = await this.o.fetch(`${this.o.baseUrl}${path}`, {
          method,
          headers: { authorization: `sso-key ${this.o.apiKey}:${this.o.apiSecret}`, accept: 'application/json', 'user-agent': 'domain-trading/5.61', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(this.o.timeoutMs ?? 20_000),
        });
      } catch (e) {
        throw new AfternicApiError('AFTERNIC_UNAVAILABLE', 0, `Afternic unreachable (${(e as { name?: string }).name ?? 'error'})`);
      }
      if (res.status === 429) {
        if (attempt >= MAX_RETRIES_429) throw new AfternicApiError('AFTERNIC_RATE_LIMITED', 429, `Afternic ${where} answered 429 after ${MAX_RETRIES_429} retries`);
        const ra = Number(res.headers.get('retry-after'));
        await this.sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60) * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      const text = await res.text().catch(() => '');
      if (!res.ok) {
        // only the stable error code of Afternic's body ({code, message}), upper snake, never free text
        let apiCode = '';
        try { const c = (JSON.parse(text) as { code?: unknown }).code; if (typeof c === 'string' && /^[A-Z0-9_]{1,60}$/.test(c)) apiCode = ` (${c})`; } catch { /* not JSON */ }
        const code: AfternicErrorCode = res.status === 401 || res.status === 403 ? 'AFTERNIC_AUTH' : res.status === 404 ? 'AFTERNIC_NOT_FOUND' : res.status >= 500 ? 'AFTERNIC_UNAVAILABLE' : 'AFTERNIC_REJECTED';
        throw new AfternicApiError(code, res.status, this.clean(`Afternic ${where} answered ${res.status}${apiCode}`));
      }
      if (res.status === 204 || text === '') return null;
      try { return JSON.parse(text); } catch { throw new AfternicApiError('AFTERNIC_BAD_RESPONSE', res.status, 'Afternic answered with a body that is not JSON'); }
    }
  }

  /** Every domain of the account (GET /domains, limit/offset pages until a short page). */
  async list(): Promise<AfternicListing[]> {
    const out: AfternicListing[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = (await this.call('GET', `${PREFIX}/domains?limit=${PAGE}&offset=${page * PAGE}&order=NAME_ASC`)) as { domains?: AfternicDomainRaw[] } | null;
      const rows = Array.isArray(r?.domains) ? r!.domains! : [];
      for (const d of rows) if (d && typeof d.name === 'string') out.push(listingOf(d));
      if (rows.length < PAGE) break;
    }
    return out;
  }

  /** GET /domains/{name}; null when Afternic does not know the name. */
  async get(name: string): Promise<AfternicListing | null> {
    try {
      const r = (await this.call('GET', `${PREFIX}/domains/${encodeURIComponent(name)}`)) as AfternicDomainRaw | null;
      return r && typeof r.name === 'string' ? listingOf(r) : null;
    } catch (e) {
      if (e instanceof AfternicApiError && e.status === 404) return null;
      throw e;
    }
  }

  /** PATCH /domains/{name} with only the given fields (200 with the domain or 204). */
  async update(name: string, u: AfternicUpdate): Promise<void> {
    const body = patchBody(u);
    if (Object.keys(body).length === 0) return;
    await this.call('PATCH', `${PREFIX}/domains/${encodeURIComponent(name)}`, body);
  }

  /** GET /stats/{name}?startDate&days: the views and leads of the `days` days from `startDate` (UTC), summed. */
  async stats(name: string, startDateIso: string, days: number): Promise<{ views: number; leads: number }> {
    const r = (await this.call('GET', `${PREFIX}/stats/${encodeURIComponent(name)}?startDate=${encodeURIComponent(startDateIso)}&days=${days}`)) as { stats?: { views?: number; leads?: number }[] } | null;
    let views = 0; let leads = 0;
    for (const s of r?.stats ?? []) { views += Number(s.views) || 0; leads += Number(s.leads) || 0; }
    return { views, leads };
  }
}
