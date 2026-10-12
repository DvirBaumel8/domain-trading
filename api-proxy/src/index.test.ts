import { describe, expect, it, vi } from 'vitest';

import { parseOrigin, proxy } from './index';

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
    const res = await proxy(new Request('https://p.example.workers.dev/posts', { method: 'POST', body: '{}' }), env, fetcher);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('ORIGIN_UNREACHABLE');
  });
  it("passes the API's own JSON 5xx through unchanged", async () => {
    const body = '{"error":{"code":"POST_FAILED","message":"x","details":{}}}';
    const fetcher = vi.fn().mockResolvedValue(new Response(body, { status: 502, headers: { 'content-type': 'application/json' } }));
    const res = await proxy(new Request('https://p.example.workers.dev/posts', { method: 'POST', body: '{}' }), env, fetcher);
    expect(res.status).toBe(502);
    expect(await res.text()).toBe(body);
  });
});

describe('parseOrigin', () => {
  it('accepts a quick-tunnel URL with a trailing slash', () => {
    expect(parseOrigin('https://a-b.trycloudflare.com/')).toBe('https://a-b.trycloudflare.com');
  });
});
