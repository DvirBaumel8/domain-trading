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

export function uaClass(ua: string | null): 'human' | 'bot' {
  const u = (ua ?? '').trim();
  return u === '' || BOT_UA.test(u) ? 'bot' : 'human';
}

export function refererHost(referer: string | null): string | null {
  if (!referer) return null;
  try {
    return new URL(referer).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

async function sendHit(origin: string, token: string, body: { domain: string; ua_class: 'human' | 'bot'; referrer_host: string | null }, fetcher: Fetcher): Promise<void> {
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
    ctx.waitUntil(sendHit(origin, token, { domain, ua_class: uaClass(request.headers.get('user-agent')), referrer_host: refererHost(request.headers.get('referer')) }, fetcher));
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
