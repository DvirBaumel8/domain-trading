export type RdapStatus = 'not_registered' | 'registered' | 'rdap_unknown';
export type RdapFn = (domain: string, opts?: { signal?: AbortSignal; timeoutMs?: number }) => Promise<RdapStatus>;

export interface RdapFacts {
  registrar: string | null;
  created_at: string | null;
  expires_at: string | null;
  updated_at: string | null;
  statuses: string[];
  nameservers: string[];
}
export interface RdapLookup {
  outcome: 'registered' | 'not_registered' | 'unknown';
  reasonCode: 'TIMEOUT' | 'RATE_LIMITED' | 'SOURCE_ERROR' | 'NO_REGISTRY_SERVICE' | null;
  httpStatus: number | null;
  url: string;
  retrievedAt: Date;
  body: string | null;
  facts: RdapFacts | null;
  /** From a 429 `Retry-After` (seconds form only); null when absent or unreadable. */
  retryAfterMs?: number | null;
}
export type RdapLookupFn = (domain: string, opts?: { baseUrl?: string; timeoutMs?: number; signal?: AbortSignal }) => Promise<RdapLookup>;

/** Honest identification for every outbound request of the screening sources (sources.md). */
export const USER_AGENT = 'domain-trading-api/1.2.0 (+https://github.com/DvirBaumel8/domain-trading)';
export const RDAP_COM_BASE = 'https://rdap.verisign.com/com/v1/';
const MAX_BODY_CHARS = 1_000_000;

const isoOrNull = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

/** Reads the registrar name from the `registrar` entity's vcard `fn`. */
function registrarOf(entities: unknown): string | null {
  if (!Array.isArray(entities)) return null;
  for (const e of entities as Record<string, unknown>[]) {
    if (!Array.isArray(e?.roles) || !e.roles.includes('registrar')) continue;
    const card = e.vcardArray;
    const props = Array.isArray(card) && Array.isArray(card[1]) ? (card[1] as unknown[]) : [];
    for (const p of props) if (Array.isArray(p) && p[0] === 'fn' && typeof p[3] === 'string' && p[3].trim()) return p[3].trim();
  }
  return null;
}

/** Facts of a domain object; null when the body is not an RDAP domain object for `domain` (HTML, other JSON, another name). */
export function parseRdapDomain(body: string, domain: string): RdapFacts | null {
  let j: unknown;
  try {
    j = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof j !== 'object' || j === null || Array.isArray(j)) return null;
  const o = j as Record<string, unknown>;
  if (o.objectClassName !== undefined && o.objectClassName !== 'domain') return null;
  if (typeof o.ldhName !== 'string' || o.ldhName.toLowerCase().replace(/\.$/, '') !== domain.toLowerCase()) return null;
  const events = Array.isArray(o.events) ? (o.events as Record<string, unknown>[]) : [];
  const at = (action: string): string | null => {
    for (const e of events) if (e?.eventAction === action) return isoOrNull(e.eventDate);
    return null;
  };
  const ns = Array.isArray(o.nameservers) ? (o.nameservers as Record<string, unknown>[]) : [];
  return {
    registrar: registrarOf(o.entities),
    created_at: at('registration'),
    expires_at: at('expiration'),
    updated_at: at('last changed'),
    statuses: Array.isArray(o.status) ? o.status.filter((s): s is string => typeof s === 'string') : [],
    nameservers: ns.map((n) => (typeof n?.ldhName === 'string' ? n.ldhName.toLowerCase() : '')).filter(Boolean),
  };
}

/** One RDAP query. Never throws. 404 = not registered; 200 must be a JSON domain object for the same name, else unknown SOURCE_ERROR. */
export const rdapLookup: RdapLookupFn = async (domain, opts = {}) => {
  const base = (opts.baseUrl ?? RDAP_COM_BASE).replace(/\/?$/, '/');
  const url = `${base}domain/${encodeURIComponent(domain)}`;
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 8000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const retrievedAt = new Date();
  const unknown = (reasonCode: NonNullable<RdapLookup['reasonCode']>, httpStatus: number | null, body: string | null = null, retryAfterMs: number | null = null): RdapLookup =>
    ({ outcome: 'unknown', reasonCode, httpStatus, url, retrievedAt, body, facts: null, retryAfterMs });
  try {
    const res = await fetch(url, { headers: { accept: 'application/rdap+json', 'user-agent': USER_AGENT }, signal });
    if (res.status === 404) {
      void res.body?.cancel().catch(() => {}); // not awaited: some servers never finish the body
      // A 404 is "not registered" only when it is an RDAP answer: a proxy or error page also says 404.
      const ct = (res.headers.get('content-type') ?? '').toLowerCase();
      if (!ct.includes('application/rdap+json') && !ct.includes('application/json')) return unknown('SOURCE_ERROR', 404);
      return { outcome: 'not_registered', reasonCode: null, httpStatus: 404, url, retrievedAt, body: null, facts: null };
    }
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after'));
      void res.body?.cancel().catch(() => {});
      return unknown('RATE_LIMITED', 429, null, Number.isFinite(ra) && ra >= 0 && res.headers.get('retry-after') !== null ? Math.round(ra * 1000) : null);
    }
    if (res.status !== 200) {
      void res.body?.cancel().catch(() => {});
      return unknown('SOURCE_ERROR', res.status);
    }
    const body = (await res.text()).slice(0, MAX_BODY_CHARS);
    const facts = parseRdapDomain(body, domain);
    if (!facts) return unknown('SOURCE_ERROR', 200, body);
    return { outcome: 'registered', reasonCode: null, httpStatus: 200, url, retrievedAt, body, facts };
  } catch (e) {
    const name = (e as { name?: string })?.name;
    return unknown(name === 'TimeoutError' || name === 'AbortError' || signal.aborted ? 'TIMEOUT' : 'SOURCE_ERROR', null);
  }
};

/** The coarse form used by the reconciler, /check and /buy: a 200 that is not a domain object for the name, or a 404 that is not an RDAP/JSON answer (a proxy or error page), is `rdap_unknown`: never `registered`, never `not_registered`. */
export const rdapStatus: RdapFn = async (domain, opts = {}) => {
  const r = await rdapLookup(domain, opts);
  return r.outcome === 'registered' ? 'registered' : r.outcome === 'not_registered' ? 'not_registered' : 'rdap_unknown';
};
