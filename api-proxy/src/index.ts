// CR-041: a stable public URL (workers.dev) in front of the Mac mini's Cloudflare quick tunnel, whose own URL changes on every restart.
// The tunnel-watch agent on the Mac sets the GitHub variable TUNNEL_URL and redeploys this Worker when the tunnel URL changes.
export interface Env {
  TUNNEL_URL?: string;
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
    return await fetcher(new Request(target, init));
  } catch {
    return errorResponse(502, 'ORIGIN_UNREACHABLE', 'The Mac host did not answer (tunnel down or restarting).');
  }
}

export default {
  fetch: (request: Request, env: Env): Promise<Response> => proxy(request, env),
};
