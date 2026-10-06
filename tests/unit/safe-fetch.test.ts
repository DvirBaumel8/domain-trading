// The outbound guard (src/net/safe-fetch.ts) and fetchPage on top of it. Pure: lookups and fetch are fakes.
import { describe, expect, it } from 'vitest';
import { BlockedError, isBlockedAddress, safeFetch, vetUrl, vettedLookup, type LookupAll } from '../../src/net/safe-fetch.js';
import { Pacer } from '../../src/screening/rdap-batch.js';
import { fetchPage, type FetchPageOpts } from '../../src/screening/site.js';

const PUBLIC: LookupAll = async () => [{ address: '93.184.216.34', family: 4 }];
const never = ['linkedin.com'];

describe('isBlockedAddress', () => {
  it.each([
    '0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.255', '127.0.0.1', '127.255.255.254', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.0.0.1', '192.0.2.5', '192.168.1.1', '198.18.0.1', '198.19.255.255', '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
  ])('v4 %s is blocked', (ip) => expect(isBlockedAddress(ip)).toBe(true));
  it.each(['8.8.8.8', '93.184.216.34', '100.63.255.255', '100.128.0.1', '172.15.255.255', '172.32.0.1', '169.253.1.1', '198.17.255.255', '198.20.0.1', '1.1.1.1', '223.255.255.255'])('v4 %s is allowed', (ip) => expect(isBlockedAddress(ip)).toBe(false));
  it.each([
    '::', '::1', 'fe80::1', 'febf::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '2001:db8::1', '2001:0::1', '2001:2::1', '100::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '::ffff:192.168.0.1', '::127.0.0.1', '::10.1.2.3', '::2',
    '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '64:ff9b::10.0.0.1', '64:ff9b:1::1', '::ffff:0:7f00:1', '::ffff:0:8.8.8.8', '3fff::1', '3fff:fff::1', '5f00::1', '2002:7f00:1::1', '2002:a9fe:a9fe::', 'fe80::1%eth0', 'not-an-ip',
  ])('v6 %s is blocked', (ip) => expect(isBlockedAddress(ip)).toBe(true));
  it.each(['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1'])('v6 %s is allowed', (ip) => expect(isBlockedAddress(ip)).toBe(false));
});

describe('vetUrl', () => {
  const vet = (u: string, look: LookupAll = PUBLIC) => vetUrl(u, look, { neverFetchHosts: never });
  const code = async (u: string, look?: LookupAll) => { try { await vet(u, look); return 'allowed'; } catch (e) { return e instanceof BlockedError ? e.code : `other:${String(e)}`; } };
  it('refuses IP-literal hosts in every spelling', async () => {
    for (const u of ['http://127.0.0.1/', 'http://2130706433/', 'http://0177.0.0.1/', 'http://0x7f000001/', 'http://0x7f.1/', 'http://[::1]/', 'http://[::ffff:7f00:1]/', 'https://169.254.169.254/latest', 'http://8.8.8.8/']) {
      expect(await code(u), u).toBe('ADDRESS_BLOCKED');
    }
  });
  it('allows only http(s) on the default ports, without credentials', async () => {
    expect(await code('https://example.net/')).toBe('allowed');
    expect(await code('http://example.net:80/')).toBe('allowed'); // :80 is the default and is dropped by the URL parser
    expect(await code('https://example.net:6379/')).toBe('URL_NOT_ALLOWED');
    expect(await code('http://example.net:8080/')).toBe('URL_NOT_ALLOWED');
    expect(await code('ftp://example.net/')).toBe('URL_NOT_ALLOWED');
    expect(await code('file:///etc/passwd')).toBe('URL_NOT_ALLOWED');
    expect(await code('https://user:pw@example.net/')).toBe('URL_NOT_ALLOWED');
    expect(await code('not a url')).toBe('URL_NOT_ALLOWED');
  });
  it('refuses never-fetch hosts and their subdomains', async () => {
    expect(await code('https://linkedin.com/in/x')).toBe('HOST_EXCLUDED');
    expect(await code('https://www.LinkedIn.com/in/x')).toBe('HOST_EXCLUDED');
    expect(await code('https://notlinkedin.com/')).toBe('allowed');
  });
  it('refuses a host if ANY resolved address is blocked, and rethrows a lookup error with its code', async () => {
    expect(await code('https://evil.example/', async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }])).toBe('ADDRESS_BLOCKED');
    expect(await code('https://evil.example/', async () => [{ address: '::ffff:127.0.0.1', family: 6 }])).toBe('ADDRESS_BLOCKED');
    const err = await vet('https://gone.example/', async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); }).catch((e) => e);
    expect((err as { cause: { code: string } }).cause.code).toBe('ENOTFOUND');
  });
});

describe('hostExcluded normalisation', () => {
  it('lowercase, trailing dots and punycode on both sides', async () => {
    const code = async (u: string, never: string[]) => vetUrl(u, PUBLIC, { neverFetchHosts: never }).then(() => 'allowed', (e) => (e as BlockedError).code);
    expect(await code('https://LinkedIn.com./x', ['linkedin.com'])).toBe('HOST_EXCLUDED');
    expect(await code('https://www.linkedin.com../x', ['LinkedIn.com.'])).toBe('HOST_EXCLUDED');
    expect(await code('https://xn--bcher-kva.example/', ['b\u00fccher.example'])).toBe('HOST_EXCLUDED');
    expect(await code('https://b\u00fccher.example/', ['xn--bcher-kva.example'])).toBe('HOST_EXCLUDED');
    expect(await code('https://other.example/', ['linkedin.com', ''])).toBe('allowed');
  });
});

describe('DNS lookup timeout', () => {
  it('a lookup that never answers is a TimeoutError, not a hang', async () => {
    const hang: LookupAll = () => new Promise(() => {});
    await expect(vetUrl('https://slow.example/', hang, { lookupTimeoutMs: 20 })).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(await fetchPage({ fetch: (async () => new Response('x')) as unknown as typeof fetch, lookupHost: hang }, 'https://slow.example/', { timeoutMs: 20, maxBytes: 1000, maxRedirects: 1, pace: new Pacer(0, 1, async () => {}), robots: new Map(), neverFetchHosts: [] })).toMatchObject({ ok: false, kind: 'unknown', reasonCode: 'SOURCE_ERROR' }); // robots.txt could not be read in time
  });
});

describe('connecting to the vetted address (DNS rebinding)', () => {
  it('vettedLookup answers with the vetted address whatever the name, in both callback shapes', () => {
    const l = vettedLookup([{ address: '93.184.216.34', family: 4 }]);
    let got: unknown[] = [];
    l('anything.example', {}, (...a) => { got = a; });
    expect(got).toEqual([null, '93.184.216.34', 4]);
    l('rebound.example', { all: true }, (...a) => { got = a; });
    expect(got).toEqual([null, [{ address: '93.184.216.34', family: 4 }]]);
  });
  it('safeFetch resolves once per request and hands the vetted lookup to the connection (a Agent), never the system resolver', async () => {
    let lookups = 0;
    const inits: (RequestInit & { dispatcher?: unknown })[] = [];
    const fake = (async (_u: string, init: RequestInit) => { inits.push(init); return new Response('ok'); }) as unknown as typeof fetch;
    const lookupHost: LookupAll = async () => { lookups++; return [{ address: lookups === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }]; };
    await safeFetch({ fetch: fake, lookupHost }, 'https://rebind.example/', {}, {});
    expect(lookups).toBe(1);
    expect(inits[0]!.dispatcher).toBeTruthy();
  });
  it('safeFetch overrides a caller redirect option with manual', async () => {
    const seen: (RequestInit | undefined)[] = [];
    const fake = (async (_u: string, init?: RequestInit) => { seen.push(init); return new Response(null, { status: 302, headers: { location: 'http://x.example/' } }); }) as unknown as typeof fetch;
    const res = await safeFetch({ fetch: fake, lookupHost: PUBLIC }, 'https://a.example/', { redirect: 'follow' }, {});
    expect(seen[0]!.redirect).toBe('manual');
    expect(res.status).toBe(302);
  });
  it('safeFetch makes no connection for a blocked address', async () => {
    let calls = 0;
    const fake = (async () => { calls++; return new Response('x'); }) as unknown as typeof fetch;
    await expect(safeFetch({ fetch: fake, lookupHost: async () => [{ address: '169.254.169.254', family: 4 }] }, 'https://metadata.example/', {})).rejects.toMatchObject({ code: 'ADDRESS_BLOCKED' });
    expect(calls).toBe(0);
  });
});

describe('fetchPage on the guard', () => {
  const opts = (extra: Partial<FetchPageOpts> = {}): FetchPageOpts => ({ timeoutMs: 1000, maxBytes: 100_000, maxRedirects: 3, pace: new Pacer(0, 1, async () => {}), robots: new Map(), neverFetchHosts: never, ...extra });
  const mk = (route: (url: string) => Response) => {
    const urls: string[] = [];
    const fn = (async (u: string) => { urls.push(u); return route(u); }) as unknown as typeof fetch;
    return { urls, deps: { fetch: fn, lookupHost: PUBLIC } };
  };
  const html = () => new Response('<html>hi</html>', { headers: { 'content-type': 'text/html' } });
  const notFound = () => new Response(null, { status: 404 });

  it('a robots.txt redirect to a link-local address is never followed (fail closed)', async () => {
    const { urls, deps } = mk((u) => (u.endsWith('/robots.txt') ? new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }) : html()));
    expect(await fetchPage(deps, 'https://site.example/', opts())).toMatchObject({ ok: false, kind: 'unknown', reasonCode: 'SOURCE_ERROR' });
    expect(urls.some((u) => u.includes('169.254'))).toBe(false);
    expect(urls).toEqual(['https://site.example/robots.txt']);
  });
  it('a robots.txt redirect to another host is unknown, a same-host one is followed', async () => {
    const other = mk((u) => (u.endsWith('/robots.txt') && u.startsWith('https://site.example') ? new Response(null, { status: 301, headers: { location: 'https://elsewhere.example/robots.txt' } }) : html()));
    expect(await fetchPage(other.deps, 'https://site.example/', opts())).toMatchObject({ ok: false, reasonCode: 'SOURCE_ERROR' });
    expect(other.urls).toEqual(['https://site.example/robots.txt']);
    const same = mk((u) => (u === 'https://site.example/robots.txt' ? new Response(null, { status: 301, headers: { location: 'https://www.site.example/robots.txt' } }) : u.endsWith('/robots.txt') ? notFound() : html()));
    expect(await fetchPage(same.deps, 'https://site.example/', opts())).toMatchObject({ ok: true });
  });
  it('a page redirect to port 6379 on the same host stops at the guard', async () => {
    const { urls, deps } = mk((u) => (u.endsWith('/robots.txt') ? notFound() : new Response(null, { status: 302, headers: { location: 'https://site.example:6379/' } })));
    expect(await fetchPage(deps, 'https://site.example/', opts())).toMatchObject({ ok: false, kind: 'unknown', reasonCode: 'URL_NOT_ALLOWED' });
    expect(urls.some((u) => u.includes('6379'))).toBe(false);
  });
  it('a private address, an excluded host and an IP literal give unknown codes without a request', async () => {
    const { urls, deps } = mk(() => html());
    expect(await fetchPage({ ...deps, lookupHost: async () => [{ address: '10.1.1.1', family: 4 }] }, 'https://site.example/', opts())).toMatchObject({ kind: 'unknown', reasonCode: 'ADDRESS_BLOCKED' });
    expect(await fetchPage(deps, 'https://www.linkedin.com/company/x', opts())).toMatchObject({ kind: 'unknown', reasonCode: 'HOST_EXCLUDED' });
    expect(await fetchPage(deps, 'http://2130706433/', opts())).toMatchObject({ kind: 'unknown', reasonCode: 'ADDRESS_BLOCKED' });
    expect(urls).toEqual([]);
  });
  it('a redirect to an excluded host is recorded, not fetched; the start host is vetted too', async () => {
    const { urls, deps } = mk((u) => (u.endsWith('/robots.txt') ? notFound() : new Response(null, { status: 302, headers: { location: 'https://linkedin.com/x' } })));
    expect(await fetchPage(deps, 'https://site.example/', opts())).toMatchObject({ ok: true, finalUrl: 'https://linkedin.com/x', html: '' });
    expect(urls.some((u) => u.includes('linkedin'))).toBe(false);
  });
  it('the run deadline stops the fetch between requests; every request is counted', async () => {
    const { urls, deps } = mk((u) => (u.endsWith('/robots.txt') ? notFound() : html()));
    expect(await fetchPage(deps, 'https://site.example/', opts({ deadline: 1000, now: () => 2000 }))).toMatchObject({ ok: false, kind: 'unknown', reasonCode: 'TIMEOUT' });
    expect(urls).toEqual([]);
    let t = 0;
    let n = 0;
    const r = await fetchPage(deps, 'https://site.example/', opts({ deadline: 1, now: () => t++, onRequest: () => { n++; } })); // the clock passes the deadline after the first requests
    expect(r.ok).toBe(false);
    const ok = await fetchPage(deps, 'https://site.example/', opts({ onRequest: () => { n++; } }));
    expect(ok.ok).toBe(true);
    expect(n).toBeGreaterThanOrEqual(2);
  });
  it('a 200 with a non-text content type is unknown UNEXPECTED_CONTENT_TYPE', async () => {
    const { deps } = mk((u) => (u.endsWith('/robots.txt') ? notFound() : new Response('%PDF', { headers: { 'content-type': 'application/pdf' } })));
    expect(await fetchPage(deps, 'https://site.example/', opts())).toMatchObject({ ok: false, kind: 'unknown', reasonCode: 'UNEXPECTED_CONTENT_TYPE' });
  });
  it('TLS error then a refused http port is unknown TLS_ERROR, never "no site"', async () => {
    const fn = (async (u: string) => {
      if (u.startsWith('https://')) throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code: 'CERT_HAS_EXPIRED' }) });
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) });
    }) as unknown as typeof fetch;
    expect(await fetchPage({ fetch: fn, lookupHost: PUBLIC }, 'https://site.example/', opts())).toMatchObject({ ok: false, kind: 'unknown', reasonCode: 'TLS_ERROR' });
  });
  it('TLS detection is by error code, not by message', async () => {
    const fn = (async () => { throw Object.assign(new TypeError('certificate trouble in the message only'), {}); }) as unknown as typeof fetch;
    expect(await fetchPage({ fetch: fn, lookupHost: PUBLIC }, 'https://site.example/', opts())).toMatchObject({ reasonCode: 'SOURCE_ERROR' });
  });
});
