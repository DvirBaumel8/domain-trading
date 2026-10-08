// Task 2: CAP-12 same name on other extensions (`same_name`). RDAP is a fake lookup, the sites are MSW handlers (a few failure kinds that
// MSW cannot produce, such as DNS and TLS errors, are thrown by a fetch wrapper). Nothing touches the network.
import { readFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import type { RdapLookup, RdapLookupFn } from '../../src/core/rdap.js';
import { readEvidence } from '../../src/modules/selection/evidence.js';
import { DEFAULT_SELECTION_VALUES } from '../../src/modules/selection/settings.js';
import type { ScreeningDeps } from '../../src/modules/selection/types.js';
import { testDb as db } from '../helpers/db.js';
import { patchActiveSettings, screeningHarness } from '../helpers/screening.js';
import { fixture, respond } from '../helpers/screening-fixtures.js';
import { mswServer } from '../setup/network.js';

const SLD = 'promptinjectionaudit';
const COM = `${SLD}.com`;
const page = (n: string) => readFileSync(new URL(`../fixtures/screening/sites/${n}`, import.meta.url), 'utf8');
const html = (body: string, status = 200) => new HttpResponse(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const robots404 = (host: string) => http.get(`https://${host}/robots.txt`, () => new HttpResponse(null, { status: 404 }));

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());

const facts = { registrar: 'Fake', created_at: '2020-01-01T00:00:00Z', expires_at: null, updated_at: null, statuses: [], nameservers: [] };
const registered = (): RdapLookup => ({ outcome: 'registered', reasonCode: null, httpStatus: 200, url: 'https://rdap.example/x', retrievedAt: new Date(), body: '{}', facts });
const notRegistered = (): RdapLookup => ({ outcome: 'not_registered', reasonCode: null, httpStatus: 404, url: 'https://rdap.example/x', retrievedAt: new Date(), body: null, facts: null });
const unknownRdap = (): RdapLookup => ({ outcome: 'unknown', reasonCode: 'TIMEOUT', httpStatus: null, url: 'https://rdap.example/x', retrievedAt: new Date(), body: null, facts: null });
const fakeRdap = (table: Record<string, RdapLookup>, fallback: RdapLookup = notRegistered()): RdapLookupFn => async (domain) => table[domain] ?? fallback;

const nxdomain = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) });
type Rule = 'nxdomain' | 'timeout' | 'timeout_page' | 'tls_refused' | 'tls' | 'error' | 'serve';
interface SiteFetch { fn: typeof fetch; calls: string[]; events: string[] }
/** Site hosts of our name: `serve` (MSW answers), or an error thrown like undici throws it. Every other site host is DNS NXDOMAIN. */
function siteFetch(rules: Record<string, Rule>, events: string[] = []): SiteFetch {
  const calls: string[] = [];
  const fn = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input instanceof Request ? input.url : input);
    const u = new URL(url);
    if (!u.hostname.startsWith(`${SLD}.`) || u.hostname === COM) return globalThis.fetch(input, init);
    calls.push(url);
    events.push(`fetch ${u.hostname}${u.pathname}`);
    const rule = rules[u.hostname] ?? 'nxdomain';
    if (rule === 'serve' || (rule === 'tls' && u.protocol === 'http:')) return globalThis.fetch(input, init);
    if (rule === 'nxdomain') throw nxdomain();
    if (rule === 'timeout_page' && u.pathname === '/robots.txt') return globalThis.fetch(input, init);
    if (rule === 'timeout' || rule === 'timeout_page') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    if (rule === 'tls_refused') throw u.protocol === 'https:' ? Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' }) }) : Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
    if (rule === 'tls') throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' }) });
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  return { fn, calls, events };
}

const GATES = DEFAULT_SELECTION_VALUES.run.gates;
beforeEach(async () => {
  // The release step (Gavriel drafts v1.2, Dvir activates it): same_name joins the default plan after ext_dates.
  const withSame = (l: string[]) => l.flatMap((c) => (c === 'ext_dates' ? [c, 'same_name'] : [c]));
  await patchActiveSettings(['run', 'gates', 'default'], withSame(GATES.default!));
  mswServer.use(http.get('https://data.iana.org/rdap/dns.json', () => respond(fixture('iana-dns.json'))));
});

async function run(o: { lookup?: ScreeningDeps['lookupHost']; rdap?: RdapLookupFn; sites: SiteFetch; sleep?: (ms: number) => Promise<void>; names?: object[]; extra?: object; setup?: (h: Awaited<ReturnType<typeof screeningHarness>>) => Promise<void> }) {
  const screening: Partial<ScreeningDeps> = { rdapLookup: o.rdap ?? fakeRdap({}), siteFetch: o.sites.fn, ...(o.lookup ? { lookupHost: o.lookup } : {}), ...(o.sleep ? { sleep: o.sleep } : {}) };
  const h = await screeningHarness({ screening });
  app = h.app;
  await o.setup?.(h);
  const { body } = await h.runDone({ mode: 'full', checks: ['form', 'same_name'], names: o.names ?? [{ domain: COM, lane: 'S3' }], ...o.extra });
  const n = body.names[0];
  return { body, h, n, id: (body.run_id ?? body.id) as string, r: n.results.find((x: any) => x.check === 'same_name') };
}
const ext = (r: any, tld: string) => r.fields.extensions.find((e: any) => e.tld === tld);

describe('same_name (CAP-12)', () => {
  it('promptinjectionaudit.com: .net trades under our exact name -> FLAG SAME_NAME_OPERATOR with the operator URL', async () => {
    mswServer.use(robots404(`${SLD}.net`), http.get(`https://${SLD}.net/`, () => html(page('synthetic-business-title.html'))));
    const { r } = await run({ rdap: fakeRdap({ [`${SLD}.net`]: registered() }), sites: siteFetch({ [`${SLD}.net`]: 'serve' }) });
    expect(r).toMatchObject({ status: 'FLAG', reason_code: 'SAME_NAME_OPERATOR', gate: 'G8', rule_ids: ['CAP-12', 'TN-1'] });
    expect(r.fields.same_name_operators).toEqual([{ url: `https://${SLD}.net/`, tld: 'net', business_use: 'business_name', business_name: 'Prompt Injection Audit' }]);
    expect(r.fields.tlds_taken_n).toBe(1);
    expect(r.fields.exact_sld_other_tld_active).toBe(true);
    expect(ext(r, 'net')).toMatchObject({ registered: 'yes', site_state: 'in_use', business_use: 'business_name' });
    // the operator page is stored as evidence: URL, hash and the visible text (no raw HTML)
    const ev = await readEvidence(db, ext(r, 'net').evidence_id);
    expect(ev).toMatchObject({ source: 'site', url: `https://${SLD}.net/`, http_status: 200 });
    expect(ev!.text).toContain('Prompt Injection Audit');
    expect(ev!.text).not.toContain('<html');
  });

  it('the check runs in the default plan right after ext_dates', async () => {
    mswServer.use(robots404(`${SLD}.net`), http.get(`https://${SLD}.net/`, () => html(page('synthetic-service.html'))));
    const sites = siteFetch({ [`${SLD}.net`]: 'serve' });
    const h = await screeningHarness({ screening: { rdapLookup: fakeRdap({ [`${SLD}.net`]: registered() }), siteFetch: sites.fn } });
    app = h.app;
    const { body } = await h.runDone({ mode: 'full', names: [{ domain: COM, lane: 'S3' }] });
    const order = body.names[0].results.map((x: any) => x.check);
    expect(order.indexOf('same_name')).toBe(order.indexOf('ext_dates') + 1);
    expect(body.names[0].results.find((x: any) => x.check === 'same_name')).toMatchObject({ status: 'FLAG', reason_code: 'SAME_NAME_OPERATOR', fields: { same_name_operators: [{ business_use: 'service_description', business_name: null }] } });
  });

  it('every extension free or without a site -> PASS, exact_sld_other_tld_active false; .co/.io/.us have no RDAP but DNS NXDOMAIN -> registered_no_site', async () => {
    const { r } = await run({ sites: siteFetch({}) });
    expect(r).toMatchObject({ status: 'PASS', reason_code: null, fields: { tlds_taken_n: 0, unknown_sites_n: 0, exact_sld_other_tld_active: false, same_name_operators: [] } });
    expect(ext(r, 'net')).toMatchObject({ registered: 'no', site_state: 'unregistered' });
    for (const t of ['co', 'io', 'us']) expect(ext(r, t)).toMatchObject({ registered: 'unknown', registration_reason_code: 'NO_REGISTRY_SERVICE', site_state: 'registered_no_site', reason_code: 'DNS_NXDOMAIN' });
  });

  it('a registered extension with no site (connection refused, 404) and a parked page are not operators', async () => {
    mswServer.use(robots404(`${SLD}.org`), http.get(`https://${SLD}.org/`, () => html(page('synthetic-parked.html'))), robots404(`${SLD}.info`), http.get(`https://${SLD}.info/`, () => html('not here', 404)));
    const { r } = await run({ rdap: fakeRdap({ [`${SLD}.org`]: registered(), [`${SLD}.info`]: registered(), [`${SLD}.ai`]: registered() }), sites: siteFetch({ [`${SLD}.org`]: 'serve', [`${SLD}.info`]: 'serve' }) });
    expect(r.status).toBe('PASS');
    expect(ext(r, 'org')).toMatchObject({ site_state: 'parked_or_for_sale' });
    expect(ext(r, 'info')).toMatchObject({ site_state: 'registered_no_site', reason_code: 'HTTP_4XX' });
    expect(ext(r, 'ai')).toMatchObject({ registered: 'yes', site_state: 'registered_no_site', reason_code: 'DNS_NXDOMAIN' });
    expect(r.fields.tlds_taken_n).toBe(3);
  });

  it('a product-name-only operator page is a PASS and records business_use product_name (it does not feed TN-1)', async () => {
    mswServer.use(robots404(`${SLD}.net`), http.get(`https://${SLD}.net/`, () => html(page('synthetic-product.html'))));
    const { r } = await run({ rdap: fakeRdap({ [`${SLD}.net`]: registered() }), sites: siteFetch({ [`${SLD}.net`]: 'serve' }) });
    expect(r).toMatchObject({ status: 'PASS', fields: { same_name_operators: [], exact_sld_other_tld_active: true } });
    expect(ext(r, 'net')).toMatchObject({ site_state: 'in_use', business_use: 'product_name' });
  });

  it('a redirect to another site is recorded and not followed; a www redirect is followed', async () => {
    mswServer.use(
      robots404(`${SLD}.net`), http.get(`https://${SLD}.net/`, () => new HttpResponse(null, { status: 301, headers: { location: 'https://other-company.example/start' } })),
      robots404(`${SLD}.org`), http.get(`https://${SLD}.org/`, () => new HttpResponse(null, { status: 302, headers: { location: `https://www.${SLD}.org/home` } })),
      robots404(`www.${SLD}.org`), http.get(`https://www.${SLD}.org/home`, () => html(page('synthetic-unrelated.html'))),
    );
    const sites = siteFetch({ [`${SLD}.net`]: 'serve', [`${SLD}.org`]: 'serve', [`www.${SLD}.org`]: 'serve' });
    const { r } = await run({ rdap: fakeRdap({ [`${SLD}.net`]: registered(), [`${SLD}.org`]: registered() }), sites });
    expect(r.status).toBe('PASS');
    expect(ext(r, 'net')).toMatchObject({ site_state: 'redirect_off_domain', final_url: 'https://other-company.example/start' });
    expect(ext(r, 'org')).toMatchObject({ site_state: 'in_use', business_use: 'none', final_url: `https://www.${SLD}.org/home` });
    expect(sites.calls.some((u) => u.includes('other-company'))).toBe(false);
  });
});

describe('same_name fails closed (Review Focus 2)', () => {
  // .org is registered and answers, but its page cannot be read: never "no operator".
  const org = `${SLD}.org`;
  const cases: { name: string; code: string; rule?: Rule; handlers: () => void }[] = [
    { name: '503 on the page', code: 'HTTP_5XX', handlers: () => mswServer.use(robots404(org), http.get(`https://${org}/`, () => html('down', 503))) },
    { name: '429 on the page', code: 'HTTP_5XX', handlers: () => mswServer.use(robots404(org), http.get(`https://${org}/`, () => html('slow down', 429))) },
    { name: '403 (bot block or login wall)', code: 'HTTP_4XX', handlers: () => mswServer.use(robots404(org), http.get(`https://${org}/`, () => html('blocked', 403))) },
    { name: 'robots.txt Disallow: /', code: 'ROBOTS_DISALLOWED', handlers: () => mswServer.use(http.get(`https://${org}/robots.txt`, () => new HttpResponse('User-agent: *\nDisallow: /\n', { headers: { 'content-type': 'text/plain' } })), http.get(`https://${org}/`, () => html(page('synthetic-business-title.html')))) },
    { name: 'robots.txt answers 503', code: 'SOURCE_ERROR', handlers: () => mswServer.use(http.get(`https://${org}/robots.txt`, () => new HttpResponse(null, { status: 503 }))) },
    { name: 'timeout on the page', code: 'TIMEOUT', rule: 'timeout_page', handlers: () => mswServer.use(robots404(org)) },
    { name: 'timeout on robots.txt', code: 'SOURCE_ERROR', rule: 'timeout', handlers: () => {} },
    { name: 'TLS error (and http does not answer)', code: 'SOURCE_ERROR', rule: 'tls', handlers: () => mswServer.use(http.all(`http://${org}/*`, () => new HttpResponse(null, { status: 503 }))) },
    { name: 'redirect loop', code: 'TOO_MANY_REDIRECTS', handlers: () => mswServer.use(robots404(org), http.get(`https://${org}/`, () => new HttpResponse(null, { status: 301, headers: { location: `https://${org}/` } }))) },
    { name: 'a page over 512 KB', code: 'TRUNCATED', handlers: () => mswServer.use(robots404(org), http.get(`https://${org}/`, () => html(`<html><body>${'a '.repeat(400_000)}</body></html>`))) },
  ];
  it.each(cases)('$name -> site_state unknown and FLAG SITE_UNKNOWN naming the host (never PASS)', async ({ code, rule, handlers }) => {
    handlers();
    const { r } = await run({ rdap: fakeRdap({ [org]: registered() }), sites: siteFetch({ [org]: rule ?? 'serve' }) });
    expect(r).toMatchObject({ status: 'FLAG', reason_code: 'SITE_UNKNOWN', fields: { unknown_sites_n: 1, exact_sld_other_tld_active: null, same_name_operators: [] } });
    expect(r.reason).toContain(org);
    expect(ext(r, 'org')).toMatchObject({ site_state: 'unknown', business_use: null });
    // the TLS case ends in the http attempt's own failure; every other case keeps its code
    expect(ext(r, 'org').reason_code).toBe(code);
  });

  it('a TLS error falls back to http once, and a readable http page is then used', async () => {
    mswServer.use(http.get(`http://${org}/robots.txt`, () => new HttpResponse(null, { status: 404 })), http.get(`http://${org}/`, () => html(page('synthetic-service.html'))));
    const sites = siteFetch({ [org]: 'tls' });
    const { r } = await run({ rdap: fakeRdap({ [org]: registered() }), sites });
    expect(r).toMatchObject({ status: 'FLAG', reason_code: 'SAME_NAME_OPERATOR' });
    expect(sites.calls.filter((u) => u.startsWith('http://'))).toHaveLength(2); // robots + page
  });

  it('an operator elsewhere wins over an unreadable site; other unknown sites stay listed', async () => {
    mswServer.use(robots404(`${SLD}.net`), http.get(`https://${SLD}.net/`, () => html(page('synthetic-business-title.html'))), robots404(org), http.get(`https://${org}/`, () => html('down', 503)));
    const { r } = await run({ rdap: fakeRdap({ [`${SLD}.net`]: registered(), [org]: registered() }), sites: siteFetch({ [`${SLD}.net`]: 'serve', [org]: 'serve' }) });
    expect(r).toMatchObject({ status: 'FLAG', reason_code: 'SAME_NAME_OPERATOR', fields: { unknown_sites_n: 1, unknown_sites: [{ tld: 'org', host: org, reason_code: 'HTTP_5XX' }] } });
  });

  it('every registry and every site unknown -> UNKNOWN ALL_EXT_UNKNOWN (a failed lookup is never "not registered")', async () => {
    const { r } = await run({ rdap: fakeRdap({}, unknownRdap()), sites: siteFetch({ [`${SLD}.net`]: 'error', [`${SLD}.org`]: 'error', [`${SLD}.co`]: 'error', [`${SLD}.io`]: 'error', [`${SLD}.ai`]: 'error', [`${SLD}.info`]: 'error', [`${SLD}.us`]: 'error' }) });
    expect(r).toMatchObject({ status: 'UNKNOWN', reason_code: 'ALL_EXT_UNKNOWN', fields: { exact_sld_other_tld_active: null } });
  });

  it('a missing signature list is UNKNOWN LIST_MISSING', async () => {
    const { r } = await run({ sites: siteFetch({}), setup: async () => { await db.connection().execute(async (conn) => { await sql`SET session_replication_role = replica`.execute(conn); await sql`DELETE FROM selection_lists WHERE name = 'sig_parked'`.execute(conn); await sql`SET session_replication_role = origin`.execute(conn); }); } });
    expect(r).toMatchObject({ status: 'UNKNOWN', reason_code: 'LIST_MISSING' });
  });
});

describe('same_name guards', () => {
  it('a full run with as_of -> UNKNOWN AS_OF_NOT_SUPPORTED and no site is fetched', async () => {
    const sites = siteFetch({});
    const { r } = await run({ sites, names: [{ domain: COM, lane: 'S3', as_of: '2026-01-01T00:00:00Z' }] });
    expect(r).toMatchObject({ status: 'UNKNOWN', reason_code: 'AS_OF_NOT_SUPPORTED' });
    expect(sites.calls).toEqual([]);
  });

  it('sources.business_sites false -> UNKNOWN SOURCE_DISABLED and nothing is fetched', async () => {
    const sites = siteFetch({});
    const { r } = await run({
      sites, extra: { settings: 'v1b' },
      setup: async (h) => { expect((await h.post('/selection/settings', { label: 'v1b', set: { 'sources.business_sites': false } })).statusCode).toBe(201); },
    });
    expect(r).toMatchObject({ status: 'UNKNOWN', reason_code: 'SOURCE_DISABLED' });
    expect(sites.calls).toEqual([]);
  });

  it('pacing: consecutive site requests (robots.txt and pages, across hosts) are separated by >= same_name.min_ms_between_fetches', async () => {
    mswServer.use(robots404(`${SLD}.net`), http.get(`https://${SLD}.net/`, () => html(page('synthetic-unrelated.html'))), robots404(`${SLD}.org`), http.get(`https://${SLD}.org/`, () => html(page('synthetic-unrelated.html'))));
    const events: string[] = [];
    const sites = siteFetch({ [`${SLD}.net`]: 'serve', [`${SLD}.org`]: 'serve' }, events);
    await run({ rdap: fakeRdap({ [`${SLD}.net`]: registered(), [`${SLD}.org`]: registered() }), sites, sleep: async (ms) => { events.push(`sleep ${ms}`); } });
    const fetchIdx = events.map((e, i) => (e.startsWith('fetch ') ? i : -1)).filter((i) => i >= 0);
    expect(fetchIdx.length).toBeGreaterThanOrEqual(4);
    for (let k = 1; k < fetchIdx.length; k++) {
      const between = events.slice(fetchIdx[k - 1]! + 1, fetchIdx[k]!).filter((e) => e.startsWith('sleep '));
      const waited = Math.max(0, ...between.map((e) => Number(e.slice(6))));
      expect(waited, `before ${events[fetchIdx[k]!]}`).toBeGreaterThanOrEqual(DEFAULT_SELECTION_VALUES.same_name.min_ms_between_fetches - 250);
    }
  });

  it('every request carries the honest User-Agent and the site is never fetched with credentials or cookies', async () => {
    const seen: { ua: string | null; cookie: string | null; auth: string | null }[] = [];
    mswServer.use(
      http.get(`https://${SLD}.net/robots.txt`, ({ request }) => { seen.push({ ua: request.headers.get('user-agent'), cookie: request.headers.get('cookie'), auth: request.headers.get('authorization') }); return new HttpResponse(null, { status: 404 }); }),
      http.get(`https://${SLD}.net/`, ({ request }) => { seen.push({ ua: request.headers.get('user-agent'), cookie: request.headers.get('cookie'), auth: request.headers.get('authorization') }); return html(page('synthetic-unrelated.html')); }),
    );
    await run({ rdap: fakeRdap({ [`${SLD}.net`]: registered() }), sites: siteFetch({ [`${SLD}.net`]: 'serve' }) });
    expect(seen).toHaveLength(2);
    for (const s of seen) expect(s).toEqual({ ua: expect.stringMatching(/^domain-trading-api\/\S+ \(\+https:\/\/github\.com\//), cookie: null, auth: null });
  });
});

describe('same_name outbound guard (fix round 1)', () => {
  const org = `${SLD}.org`;
  const metadataHits: string[] = [];
  beforeEach(() => {
    metadataHits.length = 0;
    mswServer.use(http.all('http://169.254.169.254/*', ({ request }) => { metadataHits.push(request.url); return new HttpResponse('secret'); }));
  });

  it('a host that resolves to a private address is never contacted: unknown ADDRESS_BLOCKED -> FLAG SITE_UNKNOWN', async () => {
    const sites = siteFetch({ [org]: 'serve' });
    const { r } = await run({ rdap: fakeRdap({ [org]: registered() }), sites, lookup: async (h) => [{ address: h === org ? '10.0.0.7' : '93.184.216.34', family: 4 }] });
    expect(r).toMatchObject({ status: 'FLAG', reason_code: 'SITE_UNKNOWN' });
    expect(ext(r, 'org')).toMatchObject({ site_state: 'unknown', reason_code: 'ADDRESS_BLOCKED' });
    expect(sites.calls.filter((u) => u.includes(org))).toEqual([]);
  });

  it('robots.txt redirecting to the cloud metadata address is not followed (unknown, never fetched)', async () => {
    mswServer.use(http.get(`https://${org}/robots.txt`, () => new HttpResponse(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } })));
    const { r } = await run({ rdap: fakeRdap({ [org]: registered() }), sites: siteFetch({ [org]: 'serve' }) });
    expect(r).toMatchObject({ status: 'FLAG', reason_code: 'SITE_UNKNOWN' });
    expect(ext(r, 'org')).toMatchObject({ site_state: 'unknown', reason_code: 'SOURCE_ERROR' });
    expect(metadataHits).toEqual([]);
  });

  it('a page redirecting to the metadata address or to port 6379 is recorded, not fetched', async () => {
    mswServer.use(
      robots404(`${SLD}.net`), http.get(`https://${SLD}.net/`, () => new HttpResponse(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/' } })),
      robots404(org), http.get(`https://${org}/`, () => new HttpResponse(null, { status: 302, headers: { location: `https://${org}:6379/` } })),
    );
    const sites = siteFetch({ [`${SLD}.net`]: 'serve', [org]: 'serve' });
    const { r } = await run({ rdap: fakeRdap({ [`${SLD}.net`]: registered(), [org]: registered() }), sites });
    expect(ext(r, 'net')).toMatchObject({ site_state: 'redirect_off_domain', final_url: 'http://169.254.169.254/latest/' });
    expect(ext(r, 'org')).toMatchObject({ site_state: 'unknown', reason_code: 'URL_NOT_ALLOWED' });
    expect(metadataHits).toEqual([]);
    expect(sites.calls.some((u) => u.includes('6379'))).toBe(false);
  });

  it('never_fetch_hosts (and their subdomains) are refused: unknown HOST_EXCLUDED, no request', async () => {
    const sites = siteFetch({ [org]: 'serve' });
    const { r } = await run({
      rdap: fakeRdap({ [org]: registered() }), sites, extra: { settings: 'v1b' },
      setup: async (h) => { expect((await h.post('/selection/settings', { label: 'v1b', set: { 'lead.verify.never_fetch_hosts': ['linkedin.com', org] } })).statusCode).toBe(201); },
    });
    expect(ext(r, 'org')).toMatchObject({ site_state: 'unknown', reason_code: 'HOST_EXCLUDED' });
    expect(r).toMatchObject({ status: 'FLAG', reason_code: 'SITE_UNKNOWN' });
    expect(sites.calls.filter((u) => u.includes(org))).toEqual([]);
  });

  it('TLS error with a refused http port is unknown TLS_ERROR (not "no site")', async () => {
    mswServer.use(robots404(org));
    const { r } = await run({ rdap: fakeRdap({ [org]: registered() }), sites: siteFetch({ [org]: 'tls_refused' }) });
    expect(r).toMatchObject({ status: 'FLAG', reason_code: 'SITE_UNKNOWN' });
    expect(ext(r, 'org')).toMatchObject({ site_state: 'unknown', reason_code: 'TLS_ERROR' });
  });

  it('a 200 PDF on the home page is unknown UNEXPECTED_CONTENT_TYPE; a thin scripted page is CLIENT_RENDERED', async () => {
    mswServer.use(
      robots404(org), http.get(`https://${org}/`, () => new HttpResponse('%PDF-1.4', { headers: { 'content-type': 'application/pdf' } })),
      robots404(`${SLD}.net`), http.get(`https://${SLD}.net/`, () => html(page('synthetic-client-rendered.html'))),
    );
    const { r } = await run({ rdap: fakeRdap({ [org]: registered(), [`${SLD}.net`]: registered() }), sites: siteFetch({ [org]: 'serve', [`${SLD}.net`]: 'serve' }) });
    expect(ext(r, 'org')).toMatchObject({ site_state: 'unknown', reason_code: 'UNEXPECTED_CONTENT_TYPE' });
    expect(ext(r, 'net')).toMatchObject({ site_state: 'unknown', reason_code: 'CLIENT_RENDERED' });
    expect(r.reason_code).toBe('SITE_UNKNOWN');
  });

  it('legal-suffix and segment names are operators end to end; upstream_calls counts robots.txt and page requests', async () => {
    mswServer.use(robots404(`${SLD}.net`), http.get(`https://${SLD}.net/`, () => html(page('synthetic-business-ltd.html'))));
    const { r, id } = await run({ rdap: fakeRdap({ [`${SLD}.net`]: registered() }), sites: siteFetch({ [`${SLD}.net`]: 'serve' }) });
    expect(r).toMatchObject({ status: 'FLAG', reason_code: 'SAME_NAME_OPERATOR', fields: { same_name_operators: [{ business_name: 'Prompt Injection Audit Ltd', business_use: 'business_name' }] } });
    const row = await db.selectFrom('screening_results').select('upstream_calls').where('run_id', '=', id).where('check_id', '=', 'same_name').executeTakeFirstOrThrow();
    // 7 extensions: 6 RDAP lookups (all but .co/.io/.us have a base: net org ai info = 4), plus robots.txt + page for .net and a page per other host
    expect(row.upstream_calls).toBeGreaterThanOrEqual(2 + 4);
  });
});

describe('ext_dates is unchanged by the extRegistration refactor', () => {
  it('keeps its row shape, counting and statuses', async () => {
    const NET = 'netextend';
    const sites = siteFetch({});
    const rdap = fakeRdap({
      [`${NET}.com`]: { ...registered(), facts: { ...facts, created_at: '2023-05-01T00:00:00Z' } },
      [`${NET}.net`]: { ...registered(), facts: { ...facts, created_at: '2015-02-02T00:00:00Z' } },
      [`${NET}.ai`]: unknownRdap(),
    });
    const h = await screeningHarness({ screening: { rdapLookup: rdap, siteFetch: sites.fn } });
    app = h.app;
    const { body } = await h.runDone({ mode: 'full', checks: ['availability', 'ext_dates'], names: [{ domain: `${NET}.com`, lane: 'S3' }] });
    const r = body.names[0].results.find((x: any) => x.check === 'ext_dates');
    expect(r).toMatchObject({ status: 'PASS', gate: 'G8', fields: { alt_tld_before_n: 1, n_unknown_ext: 4, comparison_basis: 'com_created_at' } });
    const byTld = (t: string) => r.fields.extensions.find((e: any) => e.tld === t);
    expect(byTld('net')).toEqual({ tld: 'net', status: 'registered', created_at: '2015-02-02T00:00:00Z', counted: true, checked_at: expect.any(String), reused: false, source: 'rdap.example' });
    expect(byTld('org')).toEqual({ tld: 'org', status: 'not_registered', created_at: null, checked_at: expect.any(String), reused: false, source: 'rdap.example' });
    expect(byTld('ai')).toEqual({ tld: 'ai', status: 'unknown', created_at: null, reason_code: 'TIMEOUT', checked_at: expect.any(String), reused: false, source: 'rdap.example' });
    expect(byTld('co')).toEqual({ tld: 'co', status: 'unknown', created_at: null, reason_code: 'NO_REGISTRY_SERVICE', checked_at: expect.any(String), reused: false, source: null });
  });
});
