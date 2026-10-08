// Real sockets, offline: undici's own fetch + the vetted-IP Agent against a server on 127.0.0.1. The address and port rules are relaxed
// ONLY here, through the explicit `testAllow` option that no production code path sets.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isBlockedAddress, safeFetch } from '../../src/core/safe-fetch.js';

let server: http.Server;
let port: string;
const hits: { host: string | undefined; url: string | undefined }[] = [];
beforeAll(async () => {
  server = http.createServer((q, r) => {
    hits.push({ host: q.headers.host, url: q.url });
    if (q.url === '/redirect') { r.writeHead(302, { location: 'http://elsewhere.invalid/target' }); r.end(); return; }
    r.writeHead(200, { 'content-type': 'text/html' });
    r.end('<html>integration ok</html>');
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  port = String((server.address() as AddressInfo).port);
});
afterAll(() => { server.close(); });

const testAllow = () => ({ addresses: new Set(['127.0.0.1']), ports: new Set([port]) });
const lookupHost = async () => [{ address: '127.0.0.1', family: 4 }];

describe('safeFetch with undici fetch on real sockets', () => {
  it('connects to the vetted address for an unresolvable host name and returns the response (the node version in use is printed)', async () => {
    const before = hits.length;
    const res = await safeFetch({ lookupHost }, `http://itest.invalid:${port}/page`, { headers: { 'user-agent': 'itest' } }, { testAllow: testAllow() });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('integration ok');
    expect(hits.length).toBe(before + 1);
    expect(hits.at(-1)).toEqual({ host: `itest.invalid:${port}`, url: '/page' });
    console.info(`safe-fetch integration ran on node ${process.version}`);
  });

  it('without the test-only allowance the same request is refused before any connection', async () => {
    const before = hits.length;
    await expect(safeFetch({ lookupHost }, `http://itest.invalid:${port}/page`, {}, {})).rejects.toMatchObject({ code: 'URL_NOT_ALLOWED' });
    await expect(safeFetch({ lookupHost }, 'http://itest.invalid/page', {}, {})).rejects.toMatchObject({ code: 'ADDRESS_BLOCKED' });
    expect(hits.length).toBe(before);
    expect(isBlockedAddress('127.0.0.1')).toBe(true); // the production rule itself is unchanged
  });

  it('redirect: manual is forced: a caller asking for follow still gets the 3xx, and the target is never requested', async () => {
    const before = hits.length;
    const res = await safeFetch({ lookupHost }, `http://itest.invalid:${port}/redirect`, { redirect: 'follow' }, { testAllow: testAllow() });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://elsewhere.invalid/target');
    expect(hits.length).toBe(before + 1);
  });

  it('reads the body repeatedly across requests (the per-request Agent is closed after the body)', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await safeFetch({ lookupHost }, `http://itest.invalid:${port}/loop`, {}, { testAllow: testAllow() });
      expect(await res.text()).toContain('integration ok');
    }
  });

  it('a cancelled body closes cleanly', async () => {
    const res = await safeFetch({ lookupHost }, `http://itest.invalid:${port}/cancel`, {}, { testAllow: testAllow() });
    await res.body!.cancel();
    // the cancel released the socket cleanly: the next request is served as usual
    const next = await safeFetch({ lookupHost }, `http://itest.invalid:${port}/loop`, {}, { testAllow: testAllow() });
    expect(await next.text()).toContain('integration ok');
  });
});
