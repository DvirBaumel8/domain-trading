// rdapLookup (CR-001 CAP-03 #1-#4, Review Focus 2) against recorded Verisign fixtures.
import { http, HttpResponse, delay } from 'msw';
import { describe, expect, it } from 'vitest';
import { rdapLookup, rdapStatus } from '../../src/rdap.js';
import { mswServer } from '../setup/network.js';
import { fixture, RANDOM_COM, respond } from '../helpers/screening-fixtures.js';

const COM = 'https://rdap.verisign.com/com/v1/domain/:d';
const serve = (rel: string) => mswServer.use(http.get(COM, () => respond(fixture(rel))));

describe('rdapLookup', () => {
  it('CAP-03 #1: promptinjectionaudit.com is registered at GoDaddy, created 2026-10-04T13:16Z, expires 2027-10-04', async () => {
    serve('rdap/promptinjectionaudit_com.json');
    const r = await rdapLookup('promptinjectionaudit.com');
    expect(r).toMatchObject({ outcome: 'registered', reasonCode: null, httpStatus: 200 });
    expect(r.facts?.registrar).toContain('GoDaddy');
    expect(r.facts?.created_at).toMatch(/^2026-10-04T13:16:\d\d\.\d{3}Z$/);
    expect(r.facts?.expires_at).toMatch(/^2027-10-04/);
    expect(r.facts?.statuses).toContain('client transfer prohibited');
    expect(r.facts?.nameservers).toEqual(['ns21.domaincontrol.com', 'ns22.domaincontrol.com']);
    expect(r.body).toContain('PROMPTINJECTIONAUDIT.COM');
  });

  it('CAP-03 #2: tampaplumbingpros.com is registered', async () => {
    serve('rdap/tampaplumbingpros_com.json');
    expect((await rdapLookup('tampaplumbingpros.com')).outcome).toBe('registered');
  });

  it('CAP-03 #3: a random 30-letter name is not_registered (404)', async () => {
    serve(`rdap/${RANDOM_COM.replace('.', '_')}.json`);
    expect(await rdapLookup(RANDOM_COM)).toMatchObject({ outcome: 'not_registered', reasonCode: null, httpStatus: 404, facts: null });
  });

  it('CAP-03 #4: a server slower than the timeout is unknown TIMEOUT', async () => {
    mswServer.use(http.get(COM, async () => {
      await delay(500);
      return new HttpResponse(null, { status: 404 });
    }));
    expect(await rdapLookup('slow.com', { timeoutMs: 50 })).toMatchObject({ outcome: 'unknown', reasonCode: 'TIMEOUT' });
  });

  it('a 404 is "not registered" only as an RDAP answer: an HTML 404 (a proxy, an error page) is unknown SOURCE_ERROR; rdapStatus reads it the same way', async () => {
    for (const ct of ['text/html', null]) {
      mswServer.use(http.get(COM, () => new HttpResponse('<html>Not found</html>', { status: 404, headers: ct ? { 'content-type': ct } : {} })));
      expect(await rdapLookup('nothere.com')).toMatchObject({ outcome: 'unknown', reasonCode: 'SOURCE_ERROR', httpStatus: 404 });
    }
    mswServer.use(http.get(COM, () => new HttpResponse('{"errorCode":404}', { status: 404, headers: { 'content-type': 'application/json' } })));
    expect((await rdapLookup('nothere.com')).outcome).toBe('not_registered');
    mswServer.use(http.get(COM, () => new HttpResponse(null, { status: 404 })));
    expect(await rdapStatus('nothere.com')).toBe('rdap_unknown');
  });

  it('429 is unknown RATE_LIMITED and carries Retry-After in ms', async () => {
    mswServer.use(http.get(COM, () => new HttpResponse(null, { status: 429, headers: { 'retry-after': '3' } })));
    expect(await rdapLookup('busy.com')).toMatchObject({ outcome: 'unknown', reasonCode: 'RATE_LIMITED', httpStatus: 429, retryAfterMs: 3000 });
    mswServer.use(http.get(COM, () => new HttpResponse(null, { status: 429 })));
    expect((await rdapLookup('busy.com')).retryAfterMs).toBeNull();
  });

  it('Review Focus 2: 200 with an HTML body, invalid JSON, JSON for another name or without ldhName is unknown SOURCE_ERROR, never registered', async () => {
    for (const body of ['<html><body>Maintenance</body></html>', '{"ldhName":', '{"ldhName":"OTHER.COM"}', '{"objectClassName":"nameserver","ldhName":"TARGET.COM"}', '{"errorCode":200}', '[]', 'null']) {
      mswServer.use(http.get(COM, () => new HttpResponse(body, { status: 200, headers: { 'content-type': 'text/html' } })));
      expect(await rdapLookup('target.com')).toMatchObject({ outcome: 'unknown', reasonCode: 'SOURCE_ERROR', httpStatus: 200, facts: null });
    }
  });

  it('5xx and network errors are unknown SOURCE_ERROR', async () => {
    mswServer.use(http.get(COM, () => new HttpResponse(null, { status: 503 })));
    expect(await rdapLookup('x.com')).toMatchObject({ outcome: 'unknown', reasonCode: 'SOURCE_ERROR', httpStatus: 503 });
    mswServer.use(http.get(COM, () => HttpResponse.error()));
    expect(await rdapLookup('x.com')).toMatchObject({ outcome: 'unknown', reasonCode: 'SOURCE_ERROR', httpStatus: null });
  });

  it('uses the given base URL and the honest User-Agent', async () => {
    let seen = { path: '', ua: '' };
    mswServer.use(http.get('https://rdap.identitydigital.services/rdap/domain/:d', ({ request }) => {
      seen = { path: new URL(request.url).pathname, ua: request.headers.get('user-agent') ?? '' };
      return respond(fixture('rdap-ext/netextend_info.json'));
    }));
    const r = await rdapLookup('netextend.info', { baseUrl: 'https://rdap.identitydigital.services/rdap/' });
    expect(seen.path).toBe('/rdap/domain/netextend.info');
    expect(seen.ua).toMatch(/^domain-trading-api\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/DvirBaumel8\/domain-trading\)$/);
    expect(r).toMatchObject({ outcome: 'registered', facts: { created_at: '2005-04-19T08:30:37.922Z' } });
  });

  it('rdapStatus delegates: a 200 that is not a domain object is rdap_unknown, not registered', async () => {
    serve('rdap/promptinjectionaudit_com.json');
    expect(await rdapStatus('promptinjectionaudit.com')).toBe('registered');
    mswServer.use(http.get(COM, () => new HttpResponse('<html/>', { status: 200 })));
    expect(await rdapStatus('x.com')).toBe('rdap_unknown');
  });
});
