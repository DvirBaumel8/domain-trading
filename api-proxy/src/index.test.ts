import { describe, expect, it, vi } from 'vitest';

import worker, { countingRedirect, parseOrigin, proxy, redirectDomain, refererHost, uaClass } from './index';

const env = { TUNNEL_URL: 'https://quiet-fox-1234.trycloudflare.com' };
const ok = () => new Response('{"ok":true}', { status: 200, headers: { 'x-origin': 'yes' } });

describe('proxy', () => {
  it('forwards path, query, method, headers and body', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok());
    const req = new Request('https://domain-trading-api-proxy.example.workers.dev/jobs/run?x=1&y=a%20b', {
      method: 'POST',
      headers: { authorization: 'Bearer t', 'idempotency-key': 'k1', 'content-type': 'application/json' },
      body: '{"job":"daily"}',
    });
    const res = await proxy(req, env, fetcher);
    const sent = fetcher.mock.calls[0]![0] as Request;
    expect(sent.url).toBe('https://quiet-fox-1234.trycloudflare.com/jobs/run?x=1&y=a%20b');
    expect(sent.method).toBe('POST');
    expect(sent.headers.get('authorization')).toBe('Bearer t');
    expect(sent.headers.get('idempotency-key')).toBe('k1');
    expect(sent.headers.get('x-forwarded-host')).toBe('domain-trading-api-proxy.example.workers.dev');
    expect(sent.headers.get('x-forwarded-proto')).toBe('https');
    expect(sent.redirect).toBe('manual');
    expect(await sent.text()).toBe('{"job":"daily"}');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-origin')).toBe('yes');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('returns a redirect from the origin as is', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: '/elsewhere' } }));
    const res = await proxy(new Request('https://p.example.workers.dev/a'), env, fetcher);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/elsewhere');
  });

  it('GET sends no body', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok());
    await proxy(new Request('https://p.example.workers.dev/health/ping'), env, fetcher);
    const sent = fetcher.mock.calls[0]![0] as Request;
    expect(sent.method).toBe('GET');
    expect(sent.url).toBe('https://quiet-fox-1234.trycloudflare.com/health/ping');
    expect(sent.body).toBeNull();
  });

  it('503 ORIGIN_NOT_SET when TUNNEL_URL is unset or empty', async () => {
    for (const e of [{}, { TUNNEL_URL: '' }, { TUNNEL_URL: '  ' }]) {
      const fetcher = vi.fn();
      const res = await proxy(new Request('https://p.example.workers.dev/x'), e, fetcher);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: { code: 'ORIGIN_NOT_SET', message: expect.any(String), details: {} } });
      expect(fetcher).not.toHaveBeenCalled();
    }
  });

  it('503 ORIGIN_NOT_SET for a URL that is not https .trycloudflare.com', async () => {
    for (const bad of ['http://a.trycloudflare.com', 'https://example.com', 'https://trycloudflare.com.evil.com', 'https://evil.com/.trycloudflare.com', 'not a url']) {
      const fetcher = vi.fn();
      const res = await proxy(new Request('https://p.example.workers.dev/x'), { TUNNEL_URL: bad }, fetcher);
      expect(res.status, bad).toBe(503);
      expect(fetcher).not.toHaveBeenCalled();
    }
  });

  it('502 ORIGIN_UNREACHABLE when the fetch throws', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('boom'));
    const res = await proxy(new Request('https://p.example.workers.dev/x'), env, fetcher);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: { code: 'ORIGIN_UNREACHABLE', message: expect.any(String), details: {} } });
  });
});

describe('proxy: tunnel error pages (BUG-043)', () => {
  it('turns an HTML 5xx from the tunnel into 502 ORIGIN_UNREACHABLE JSON', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('<html>Bad gateway</html>', { status: 530, headers: { 'content-type': 'text/html; charset=UTF-8' } }));
    const res = await proxy(new Request('https://p.example.workers.dev/list', { method: 'POST', body: '{}' }), env, fetcher);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('ORIGIN_UNREACHABLE');
  });
  it("passes the API's own JSON 5xx through unchanged", async () => {
    const body = '{"error":{"code":"POST_FAILED","message":"x","details":{}}}';
    const fetcher = vi.fn().mockResolvedValue(new Response(body, { status: 502, headers: { 'content-type': 'application/json' } }));
    const res = await proxy(new Request('https://p.example.workers.dev/list', { method: 'POST', body: '{}' }), env, fetcher);
    expect(res.status).toBe(502);
    expect(await res.text()).toBe(body);
  });
});

describe('parseOrigin', () => {
  it('accepts a quick-tunnel URL with a trailing slash', () => {
    expect(parseOrigin('https://a-b.trycloudflare.com/')).toBe('https://a-b.trycloudflare.com');
  });
});

// CR-068: the counting redirect GET|HEAD /r/<domain>
const venv = { ...env, VISITS_TOKEN: 'dt_visits_fake_token' };
const ctxOf = () => {
  const pending: Promise<unknown>[] = [];
  return { ctx: { waitUntil: (p: Promise<unknown>) => { pending.push(p); } }, done: () => Promise.all(pending) };
};

describe('counting redirect /r/<domain>', () => {
  it('302s to the Afternic page with no cookie and no caching, for a bare, www and mixed-case name, on GET and HEAD', async () => {
    for (const [method, path] of [['GET', '/r/ukcbamcompliance.com'], ['HEAD', '/r/www.ukcbamcompliance.com'], ['GET', '/r/UkcbAmCompliance.COM/']] as const) {
      const { ctx } = ctxOf();
      const res = await worker.fetch(new Request(`https://p.example.workers.dev${path}`, { method }), venv, ctx);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://www.afternic.com/domain/ukcbamcompliance.com');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('set-cookie')).toBeNull();
    }
  });

  it('404 for anything that is not a plain .com name; nothing is counted', async () => {
    for (const path of ['/r/', '/r/example.net', '/r/a.b.com', '/r/-bad.com', '/r/x.com/extra', '/r/%E0%A4%A.com']) {
      const fetcher = vi.fn();
      const { ctx, done } = ctxOf();
      const res = countingRedirect(new Request(`https://p.example.workers.dev${path}`), venv, ctx, fetcher);
      await done();
      expect(res.status, path).toBe(404);
      expect(fetcher).not.toHaveBeenCalled();
    }
    expect(redirectDomain('/r/www.x.com')).toBe('x.com');
  });

  it('after the 302 posts exactly {domain, ua_class, referrer_host} to <tunnel>/visits/hit with the bearer token and an Idempotency-Key', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }));
    const { ctx, done } = ctxOf();
    const res = countingRedirect(new Request('https://p.example.workers.dev/r/x.com?utm=1', {
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) Safari', referer: 'https://News.example.org/a/b?q=1', cookie: 'a=b', 'cf-connecting-ip': '203.0.113.9' },
    }), venv, ctx, fetcher);
    expect(res.status).toBe(302);
    await done();
    const sent = fetcher.mock.calls[0]![0] as Request;
    expect(sent.url).toBe('https://quiet-fox-1234.trycloudflare.com/visits/hit');
    expect(sent.method).toBe('POST');
    expect(sent.headers.get('authorization')).toBe('Bearer dt_visits_fake_token');
    expect(sent.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent.headers.get('cookie')).toBeNull();
    expect(JSON.parse(await sent.text())).toEqual({ domain: 'x.com', ua_class: 'human', referrer_host: 'news.example.org' });
  });

  it('classifies bots and an empty user agent as bot; the referrer host is null without a usable Referer', () => {
    for (const ua of ['Googlebot/2.1', 'curl/8.1', 'python-requests/2', 'Slackbot-LinkExpanding', 'HeadlessChrome', '', null]) expect(uaClass(ua), String(ua)).toBe('bot');
    expect(uaClass('Mozilla/5.0 Firefox/130')).toBe('human');
    expect(refererHost(null)).toBeNull();
    expect(refererHost('not a url')).toBeNull();
  });

  it('still 302s when the API fetch throws, and counts nothing without VISITS_TOKEN or a tunnel URL', async () => {
    const boom = vi.fn().mockRejectedValue(new Error('down'));
    const a = ctxOf();
    expect(countingRedirect(new Request('https://p.example.workers.dev/r/x.com'), venv, a.ctx, boom).status).toBe(302);
    await expect(a.done()).resolves.toBeDefined();
    for (const e of [env, { ...venv, TUNNEL_URL: '' }]) {
      const fetcher = vi.fn();
      const { ctx, done } = ctxOf();
      expect(countingRedirect(new Request('https://p.example.workers.dev/r/x.com'), e, ctx, fetcher).status).toBe(302);
      await done();
      expect(fetcher).not.toHaveBeenCalled();
    }
  });

  it('every other path, and a POST to /r/..., still goes to the API through the proxy', async () => {
    const orig = globalThis.fetch;
    const fetcher = vi.fn().mockResolvedValue(ok());
    globalThis.fetch = fetcher as unknown as typeof fetch;
    try {
      const res = await worker.fetch(new Request('https://p.example.workers.dev/health/ping'), venv, ctxOf().ctx);
      expect(res.status).toBe(200);
      expect((fetcher.mock.calls[0]![0] as Request).url).toBe('https://quiet-fox-1234.trycloudflare.com/health/ping');
      const post = await worker.fetch(new Request('https://p.example.workers.dev/r/x.com', { method: 'POST', body: '{}' }), venv, ctxOf().ctx);
      expect(post.status).toBe(200);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
