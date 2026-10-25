// CR-041: a stable public URL (workers.dev) in front of the Mac mini's Cloudflare quick tunnel, whose own URL changes on every restart.
// The tunnel-watch agent on the Mac sets the GitHub variable TUNNEL_URL and redeploys this Worker when the tunnel URL changes.
export interface Env {
  TUNNEL_URL?: string;
  /** Optional secret (CR-068): the visits-scope API token. Unset = GET /r/<domain> still redirects but counts nothing. */
  VISITS_TOKEN?: string;
}
/** The part of the Workers ExecutionContext used here. */
export interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
}

type Fetcher = (request: Request) => Promise<Response>;

function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message, details: {} } }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** Only an https origin on .trycloudflare.com is accepted, so the proxy can't be pointed elsewhere by mistake. Returns the origin without a trailing slash, or null. */
export function parseOrigin(raw: string | undefined): string | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.trycloudflare.com') || url.hostname === '.trycloudflare.com') return null;
  return url.origin;
}

export async function proxy(request: Request, env: Env, fetcher: Fetcher = (r) => fetch(r)): Promise<Response> {
  const origin = parseOrigin(env.TUNNEL_URL);
  if (!origin) return errorResponse(503, 'ORIGIN_NOT_SET', 'The tunnel URL is not set (or is not an https .trycloudflare.com URL).');

  const incoming = new URL(request.url);
  const target = `${origin}${incoming.pathname}${incoming.search}`;
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.set('x-forwarded-host', incoming.host);
  headers.set('x-forwarded-proto', 'https');

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
    body: hasBody ? request.body : null,
    redirect: 'manual',
  };
  if (hasBody) init.duplex = 'half';

  try {
    const res = await fetcher(new Request(target, init));
    // BUG-043: when the Mac server is down or restarting, the tunnel answers with Cloudflare's own HTML error page
    // (502/530). The API only ever answers JSON, so an HTML 5xx is the tunnel's: return the API's error shape instead.
    if (res.status >= 500 && (res.headers.get('content-type') ?? '').includes('text/html')) {
      return errorResponse(502, 'ORIGIN_UNREACHABLE', `The Mac host did not answer (tunnel status ${res.status}); retry with the same Idempotency-Key.`);
    }
    return res;
  } catch {
    return errorResponse(502, 'ORIGIN_UNREACHABLE', 'The Mac host did not answer (tunnel down or restarting).');
  }
}

// ---- CR-068: the counting redirect ------------------------------------------------------------------------------------------------------
// GET|HEAD /r/<domain> answers 302 to the name's Afternic page at once (no cookie, nothing cached), then sends one count to the API (POST /visits/hit)
// after the response, with a 3 s timeout and every error swallowed: the visitor never waits for, or depends on, the Mac host. Only the domain, a
// human/bot class and the referrer HOST are sent; never an IP, the user agent, a path or a query.
const COM_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.com$/;
const BOT_UA = /bot|crawl|spider|slurp|preview|monitor|curl|wget|python|http-client|headless/i;
// v5.47.0 (F17): scripted clients and scanners that the plain bot test lets through as people. They are sent as `suspect` and counted apart (`suspect_hits`), never as human.
const SCANNER_UA = /headlesschrome|puppeteer|playwright|phantomjs|selenium|webdriver|go-http-client|java\/|okhttp|libwww|scrapy|axios|node-fetch|undici|aiohttp|httpx|requests|mechanize|apache-httpclient|postman|insomnia|nuclei|nmap|masscan|zgrab|censys|shodan|expanse|nessus|qualys|semrush|ahrefs|majestic|dataprovider|wappalyzer|builtwith|urlscan|virustotal|sucuri|uptime|pingdom|statuscake|check_http|gtmetrix|lighthouse|pagespeed/i;
/** Hosting and cloud networks: a real visitor of a for-sale page does not come from a data center. Matched on Cloudflare's AS organisation name (request.cf), when it is present. */
const DATACENTER_ORG = /amazon|aws|google cloud|google llc|microsoft|azure|digitalocean|ovh|hetzner|linode|akamai|oracle|alibaba|tencent|vultr|choopa|scaleway|leaseweb|contabo|m247|datacamp|cogent|packet|rackspace|ionos|hostinger|godaddy|namecheap|colocrossing|quadranet|psychz|stark industries|ipxo|zenlayer/i;

/** The domain of a /r/<domain> path (lowercase, a leading www. dropped), or null when it is not a plain .com name. */
export function redirectDomain(pathname: string): string | null {
  const m = /^\/r\/([^/]+)\/?$/.exec(pathname);
  if (!m) return null;
  let d: string;
  try {
    d = decodeURIComponent(m[1]!).toLowerCase();
  } catch {
    return null;
  }
  if (d.startsWith('www.')) d = d.slice(4);
  return COM_DOMAIN.test(d) ? d : null;
}

/** What the Worker can see of the request without keeping anything: header names/values are tested and dropped, the AS organisation is read from request.cf. */
export interface HitSignals { acceptLanguage: string | null; accept: string | null; asOrganization?: string | null }

/**
 * bot = no user agent or a crawler / preview / monitor name (as before). suspect (v5.47.0) = a scanner or scripted client name, a request with no Accept-Language, one that does not ask for
 * HTML, or one from a hosting / cloud network. human = everything else. Without signals (older callers) only the user agent is tested.
 */
export function uaClass(ua: string | null, sig?: HitSignals): 'human' | 'bot' | 'suspect' {
  const u = (ua ?? '').trim();
  if (u === '' || BOT_UA.test(u)) return 'bot';
  if (SCANNER_UA.test(u)) return 'suspect';
  if (sig) {
    if (!sig.acceptLanguage || sig.acceptLanguage.trim() === '') return 'suspect';
    if (sig.accept !== null && !/text\/html|\*\/\*/i.test(sig.accept)) return 'suspect';
    if (sig.asOrganization && DATACENTER_ORG.test(sig.asOrganization)) return 'suspect';
  }
  return 'human';
}

export function refererHost(referer: string | null): string | null {
  if (!referer) return null;
  try {
    return new URL(referer).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

async function sendHit(origin: string, token: string, body: { domain: string; ua_class: 'human' | 'bot' | 'suspect'; referrer_host: string | null }, fetcher: Fetcher): Promise<void> {
  try {
    await fetcher(new Request(`${origin}/visits/hit`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': crypto.randomUUID(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    }));
  } catch {
    // best effort: a dropped count is fine
  }
}

export function countingRedirect(request: Request, env: Env, ctx: Ctx, fetcher: Fetcher = (r) => fetch(r)): Response {
  const domain = redirectDomain(new URL(request.url).pathname);
  if (!domain) return errorResponse(404, 'NOT_FOUND', 'No such redirect.');
  const origin = parseOrigin(env.TUNNEL_URL);
  const token = (env.VISITS_TOKEN ?? '').trim();
  if (origin && token) {
    const cf = (request as Request & { cf?: { asOrganization?: string } }).cf;
    const signals: HitSignals = { acceptLanguage: request.headers.get('accept-language'), accept: request.headers.get('accept'), asOrganization: cf?.asOrganization ?? null };
    ctx.waitUntil(sendHit(origin, token, { domain, ua_class: uaClass(request.headers.get('user-agent'), signals), referrer_host: refererHost(request.headers.get('referer')) }, fetcher));
  }
  return new Response(null, { status: 302, headers: { location: `https://www.afternic.com/domain/${domain}`, 'cache-control': 'no-store' } });
}

export default {
  fetch: (request: Request, env: Env, ctx: Ctx): Promise<Response> | Response => {
    const path = new URL(request.url).pathname;
    if ((request.method === 'GET' || request.method === 'HEAD') && path.startsWith('/r/')) return countingRedirect(request, env, ctx);
    return proxy(request, env);
  },
};
