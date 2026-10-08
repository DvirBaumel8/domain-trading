import { http, HttpResponse, delay } from 'msw';
import { describe, expect, it } from 'vitest';
import { rdapStatus } from '../../src/core/rdap.js';
import { mswServer } from '../setup/network.js';

const URL_ = 'https://rdap.verisign.com/com/v1/domain/:d';

describe('rdapStatus', () => {
  it('404 → not_registered', async () => {
    mswServer.use(http.get(URL_, () => new HttpResponse(null, { status: 404, headers: { 'content-type': 'application/rdap+json' } })));
    expect(await rdapStatus('free.com')).toBe('not_registered');
  });
  it('a 404 that is not an RDAP answer (HTML error page, no content type) → rdap_unknown, never not_registered', async () => {
    mswServer.use(http.get(URL_, () => new HttpResponse('<html>Not Found</html>', { status: 404, headers: { 'content-type': 'text/html' } })));
    expect(await rdapStatus('free.com')).toBe('rdap_unknown');
    mswServer.use(http.get(URL_, () => new HttpResponse(null, { status: 404 })));
    expect(await rdapStatus('free.com')).toBe('rdap_unknown');
  });
  it('200 → registered', async () => {
    mswServer.use(http.get(URL_, () => HttpResponse.json({ ldhName: 'TAKEN.COM' })));
    expect(await rdapStatus('taken.com')).toBe('registered');
  });
  it('other status, network error or timeout → rdap_unknown', async () => {
    mswServer.use(http.get(URL_, () => new HttpResponse(null, { status: 503 })));
    expect(await rdapStatus('x.com')).toBe('rdap_unknown');
    mswServer.use(http.get(URL_, () => HttpResponse.error()));
    expect(await rdapStatus('x.com')).toBe('rdap_unknown');
    mswServer.use(http.get(URL_, async () => {
      await delay(500);
      return new HttpResponse(null, { status: 404 });
    }));
    expect(await rdapStatus('x.com', { timeoutMs: 50 })).toBe('rdap_unknown');
  });
  it('requests the Verisign .com path for the exact domain', async () => {
    let seen = '';
    mswServer.use(http.get(URL_, ({ request }) => {
      seen = new URL(request.url).pathname;
      return new HttpResponse(null, { status: 404 });
    }));
    await rdapStatus('examplecityroofing.com');
    expect(seen).toBe('/com/v1/domain/examplecityroofing.com');
  });
});
