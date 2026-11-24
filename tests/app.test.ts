import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppDeps } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashToken } from '../src/http/auth.js';
import type { RegistrarAdapter } from '../src/registrars/index.js';
import type { Quote } from '../src/registrars/types.js';
import { parseState } from '../src/state.js';

const TOKEN = 'dt_fake-test-token';
const auth = { authorization: `Bearer ${TOKEN}` };
const approval = { approved_on: '2026-10-04', ref: 'r' };
const state = parseState(JSON.stringify({
  domains: [
    { domain: 'sold.com', display_name: 'Sold.com', deal_id: 'D-001', registrar: 'porkbun', expiry_date: '2027-10-04', status: 'sold' },
    { domain: 'kept.com', display_name: 'Kept.com', deal_id: 'D-002', registrar: 'godaddy', expiry_date: '2027-10-04', status: 'owned' },
  ],
  ledger: [
    { id: 1, date: '2026-10-04', type: 'purchase', domain: 'sold.com', amount_cents: -1108, note: 'n', approval },
    { id: 2, date: '2026-10-05', type: 'purchase', domain: 'kept.com', amount_cents: -2419, note: 'n', approval },
    { id: 3, date: '2026-10-06', type: 'cost', domain: null, amount_cents: -499, note: 'n', approval: null },
    { id: 4, date: '2026-11-01', type: 'sale', domain: 'sold.com', amount_cents: 148_800, note: 'n', approval },
    { id: 5, date: '2026-11-02', type: 'adjustment', domain: 'kept.com', amount_cents: 19, note: 'n', approval: null },
  ],
}));

const adapter = (q: Partial<Quote> | Error = {}): RegistrarAdapter & { calls: number } => ({
  name: 'porkbun', calls: 0,
  capabilities: { canQuote: true, canRegister: true, canManageNs: true, customNs: true, prepaid: true, freePrivacy: true, afternicFastTransfer: true, sandbox: false },
  async quote() {
    this.calls++;
    if (q instanceof Error) throw q;
    return { available: true, premium: false, firstYearCents: 1108, renewalCents: 1108, privacyCentsPerYear: 0, currency: 'USD', minDurationYears: 1, raw: {}, ...q };
  },
});

let app: FastifyInstance;
afterEach(() => app.close());
const make = (o: Partial<AppDeps> = {}) => (app = buildApp({
  config: loadConfig({ RENDER_GIT_COMMIT: 'abc' }, JSON.stringify({ tester: hashToken(TOKEN) })), state, logger: false, rdap: async () => 'not_registered', adapters: [adapter()], fetchFn: async () => { throw new Error('no outside call in this test'); }, ...o,
}));
const get = (url: string, headers: Record<string, string> = auth) => app.inject({ method: 'GET', url, headers });

describe('health and access', () => {
  it('/health/ping is open and names the version and commit', async () => {
    make();
    const r = await get('/health/ping', {});
    expect([r.statusCode, r.json()]).toEqual([200, { status: 'ok', version: expect.stringMatching(/^\d+\./), commit: 'abc' }]);
  });
  it('every other route, and an unknown one, needs a token', async () => {
    make();
    for (const url of ['/health', '/check?domain=x.com', '/portfolio', '/portfolio/kept.com', '/ledger', '/report', '/registrar-status', '/listings', '/sales', '/auctions?domains=x.com', '/trademarks/12345678', '/nope']) {
      for (const h of [{}, { authorization: 'Bearer wrong' }, { authorization: TOKEN }] as Record<string, string>[]) {
        const r = await get(url, h);
        expect([url, r.statusCode, r.json().error.code]).toEqual([url, 401, 'UNAUTHORIZED']);
      }
      await app.close(); make(); // a fresh failure counter
    }
  });
  it('no tokens configured: refused', async () => {
    make({ config: loadConfig({}) });
    expect((await get('/portfolio')).statusCode).toBe(401);
  });
  it('a trailing slash, an encoded path or a query cannot open a private route', async () => {
    make();
    for (const url of ['/portfolio/', '/%70ortfolio', '/portfolio?x=/health/ping', '/health/ping/../../portfolio', '/health/ping/x']) expect((await get(url, {})).statusCode, url).toBe(401);
  });
  it('21 wrong tokens: 429 with Retry-After; a good token still works; the block ends', async () => {
    let t = 0;
    make({ now: () => t });
    for (let i = 0; i < 20; i++) expect((await get('/report', {})).statusCode).toBe(401);
    const r = await get('/report', {});
    expect([r.statusCode, r.json().error.code, r.headers['retry-after']]).toEqual([429, 'RATE_LIMITED', '600']);
    expect((await get('/report')).statusCode).toBe(200);
    t += 600_001;
    expect((await get('/report', {})).statusCode).toBe(401);
  });
  it('61 calls in a minute with one token: 429', async () => {
    let t = 0;
    make({ now: () => t });
    for (let i = 0; i < 60; i++) expect((await get('/report')).statusCode).toBe(200);
    expect((await get('/report')).statusCode).toBe(429);
    t += 60_001;
    expect((await get('/report')).statusCode).toBe(200);
  });
  it('nothing can be written: no POST, PUT, PATCH or DELETE route', async () => {
    make();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      for (const url of ['/buy', '/portfolio', '/portfolio/kept.com', '/ledger', '/jobs/run', '/sold/kept.com', '/listings', '/auctions', '/registrar-status']) {
        const r = await app.inject({ method, url, headers: auth });
        expect([method, url, r.statusCode, r.json().error.code]).toEqual([method, url, 404, 'NOT_FOUND']);
      }
    }
  });
});

describe('books', () => {
  it('/portfolio: each domain with what it cost and sold for', async () => {
    make();
    expect((await get('/portfolio')).json().domains).toMatchObject([
      { domain: 'sold.com', status: 'sold', buy_date: '2026-10-04', renewals_used: 0, cost_cents: 1108, cost: '$11.08', sold_for_cents: 148_800, sold_for: '$1,488.00' },
      { domain: 'kept.com', status: 'owned', registrar: 'godaddy', cost_cents: 2400, cost: '$24.00', sold_for_cents: null, sold_for: null },
    ]);
  });
  it('/portfolio/{domain}: with its ledger rows; any letter case; 404 and 422', async () => {
    make();
    expect((await get('/portfolio/Kept.com')).json()).toMatchObject({ domain: 'kept.com', ledger: [{ id: 2, amount: '-$24.19' }, { id: 5 }] });
    expect((await get('/portfolio/other.com')).json().error.code).toBe('DOMAIN_NOT_FOUND');
    expect((await get('/portfolio/other.net')).json().error.code).toBe('TLD_NOT_SUPPORTED');
  });
  it('/ledger and /report add up', async () => {
    make();
    const ledger = (await get('/ledger')).json();
    expect([ledger.entries.length, ledger.total_cents, ledger.total]).toEqual([5, 144_793, '$1,447.93']);
    expect((await get('/report')).json()).toEqual({
      domains_owned: 1, domains_sold: 1, max_domains: 40, spent_cents: 4007, spent: '$40.07', sales_cents: 148_800, sales: '$1,488.00', net_cents: 144_793, net: '$1,447.93',
    });
  });
});

describe('/check', () => {
  it('a free name: the price now, the renewal and the two-year total', async () => {
    make();
    const r = (await get('/check?domain=New.com')).json();
    expect(r).toMatchObject({ domain: 'new.com', availability: 'available', winner: { registrar: 'porkbun', first_year: '$11.08', two_year_cents: 2216 }, warnings: [] });
    expect(r.checked_at).toMatch(/\+0[23]:00$/);
  });
  it('a taken name, a premium name and a failing registrar have no winner', async () => {
    make({ rdap: async () => 'registered', adapters: [adapter({ available: false })] });
    expect((await get('/check?domain=a.com')).json()).toMatchObject({ availability: 'taken', winner: null });
    await app.close();
    make({ adapters: [adapter({ premium: true })] });
    expect((await get('/check?domain=a.com')).json()).toMatchObject({ winner: null, quotes: [{ exclusion_reason: 'PREMIUM' }] });
    await app.close();
    make({ adapters: [adapter(new Error('boom'))] });
    expect((await get('/check?domain=a.com')).json()).toMatchObject({ availability: 'unknown', winner: null, quotes: [{ error_code: 'ADAPTER_FAILED' }] });
  });
  it('no registrar keys: answers "unknown", no quotes', async () => {
    make({ adapters: [] });
    expect((await get('/check?domain=a.com')).json()).toMatchObject({ availability: 'unknown', quotes: [], winner: null });
  });
  it('asks the registrar once a minute per name', async () => {
    let t = 0;
    const a = adapter();
    make({ adapters: [a], now: () => t });
    await get('/check?domain=a.com'); await get('/check?domain=a.com');
    expect(a.calls).toBe(1);
    t += 60_001;
    await get('/check?domain=a.com');
    expect(a.calls).toBe(2);
  });
  it('bad input', async () => {
    make();
    expect((await get('/check')).statusCode).toBe(400);
    expect((await get('/check?domain=a.b.com')).json().error.code).toBe('DOMAIN_INVALID');
    expect((await get('/check?domain=a.net')).json().error.code).toBe('TLD_NOT_SUPPORTED');
  });
});

describe('outside sources (CR-116): an error or a missing key is never clean, ok or empty', () => {
  const KEYS = {
    PORKBUN_API_KEY: 'pk1_fake', PORKBUN_SECRET_API_KEY: 'sk1_fake', GOOGLE_WEB_RISK_API_KEY: 'fake-wr', GODADDY_DOMAINS_PAT: 'fake-pat',
    GODADDY_API_KEY: 'fake-gk', GODADDY_API_SECRET: 'fake-gs', AFTERNIC_API_KEY: 'fake-ak', AFTERNIC_API_SECRET: 'fake-as', USPTO_API_KEY: 'fake-us',
  };
  const owned = parseState(JSON.stringify({
    domains: [
      { domain: 'pork.com', display_name: 'Pork.com', deal_id: 'D-001', registrar: 'porkbun', expiry_date: '2027-10-09', status: 'owned' },
      { domain: 'daddy.com', display_name: 'Daddy.com', deal_id: 'D-002', registrar: 'godaddy', expiry_date: '2027-10-04', status: 'owned' },
      { domain: 'gone.com', display_name: 'Gone.com', deal_id: 'D-003', registrar: 'godaddy', expiry_date: '2027-10-04', status: 'dropped' },
    ],
    ledger: ['pork.com', 'daddy.com', 'gone.com'].map((domain, i) => ({ id: i + 1, date: '2026-10-04', type: 'purchase', domain, amount_cents: -1108, note: 'n', approval })),
  }));
  type Call = { url: string; method: string; headers: Headers; body: string | null };
  let calls: Call[];
  type Reply = { status?: number; body: unknown } | Error;
  /** Answers each call by the first pattern its URL contains. */
  const withReplies = (replies: Record<string, Reply>, env: Record<string, string> = KEYS, o: Partial<AppDeps> = {}) => {
    calls = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: (init?.body as string | undefined) ?? null });
      const r = Object.entries(replies).find(([k]) => url.includes(k))?.[1] ?? new Error(`unexpected ${url}`);
      if (r instanceof Error) throw r;
      return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
    };
    return make({ config: loadConfig(env, JSON.stringify({ tester: hashToken(TOKEN) })), state: owned, fetchFn, ...o });
  };
  const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
  const BAD: [string, Reply, string][] = [['a timeout', timeout, 'TIMEOUT'], ['a network error', new Error('x'), 'NETWORK'], ['HTTP 403', { status: 403, body: { code: 'NOT_ELIGIBLE' } }, 'HTTP_ERROR'], ['HTTP 500', { status: 500, body: 'oops' }, 'HTTP_ERROR'], ['not JSON', { body: '<html>' }, 'BAD_RESPONSE'], ['another shape', { body: { hello: 1 } }, 'BAD_RESPONSE']];

  describe('Web Risk in /check', () => {
    const risk = async () => (await get('/check?domain=new.com')).json().web_risk;
    it('clean only when both addresses answered with nothing; the key is in a header only', async () => {
      withReplies({ 'webrisk.googleapis.com': { body: {} } });
      expect(await risk()).toMatchObject({ status: 'clean', threat_types: [], error_code: null });
      expect(calls.map((c) => new URL(c.url).searchParams.get('uri')).sort()).toEqual(['http://new.com/', 'https://new.com/']);
      for (const c of calls) {
        expect(new URL(c.url).searchParams.getAll('threatTypes')).toEqual(['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE']);
        expect([c.url.includes('fake-wr'), c.headers.get('x-goog-api-key')]).toEqual([false, 'fake-wr']);
      }
    });
    it('flagged, with the threat types, even when the other address failed', async () => {
      withReplies({ 'uri=http%3A': { body: { threat: { threatTypes: ['SOCIAL_ENGINEERING'], expireTime: 'x' } } }, 'uri=https%3A': timeout });
      expect(await risk()).toMatchObject({ status: 'flagged', threat_types: ['SOCIAL_ENGINEERING'] });
    });
    it.each(BAD)('%s is an error, also when only one address failed', async (_n, reply, code) => {
      withReplies({ 'uri=http%3A': { body: {} }, 'uri=https%3A': reply });
      expect(await risk()).toMatchObject({ status: 'error', error_code: code });
    });
    it('no key: missing_key, and the price still answers', async () => {
      withReplies({}, {});
      const r = (await get('/check?domain=new.com')).json();
      expect([r.web_risk.status, r.availability, calls.length]).toEqual(['missing_key', 'available', 0]);
    });
    it('stops at the daily free limit with an error, and starts again the next day', async () => {
      let t = Date.parse('2026-11-24T00:00:00Z');
      withReplies({ 'webrisk.googleapis.com': { body: {} } }, KEYS, { now: () => t });
      for (let i = 0; i < 750; i++) { await get(`/check?domain=n${i}.com`); t += 1100; }
      expect(calls.length).toBe(1500);
      expect((await get('/check?domain=last.com')).json().web_risk).toMatchObject({ status: 'error', error_code: 'DAILY_LIMIT' });
      t += 86_400_000;
      expect((await get('/check?domain=last.com')).json().web_risk.status).toBe('clean');
    });
  });

  describe('/registrar-status', () => {
    const pb = { status: 'SUCCESS', domain: { domain: 'pork.com', expireDate: '2027-10-09 10:00:00', autoRenew: 0, securityLock: 1 } };
    const good = {
      '/domain/get/pork.com': { body: pb }, '/domain/getNs/pork.com': { body: { status: 'SUCCESS', ns: ['NS2.afternic.com', 'ns1.afternic.com'] } },
      'api.godaddy.com/v3': { body: { items: [{ domain: 'DADDY.com', expiresAt: '2027-11-04T00:00:00Z', autoRenew: true, transferLock: true, nameServers: ['ns1.afternic.com'] }], links: [{ rel: 'self' }] } },
    };
    const rows = async () => (await get('/registrar-status')).json().domains;
    it('expiry, auto-renew, lock and nameservers of every owned name, against our record', async () => {
      withReplies(good);
      expect(await rows()).toEqual([
        { domain: 'pork.com', registrar: 'porkbun', status: 'ok', error: null, expiry_date: '2027-10-09', recorded_expiry_date: '2027-10-09', expiry_matches: true, auto_renew: false, locked: true, nameservers: ['ns1.afternic.com', 'ns2.afternic.com'] },
        { domain: 'daddy.com', registrar: 'godaddy', status: 'ok', error: null, expiry_date: '2027-11-04', recorded_expiry_date: '2027-10-04', expiry_matches: false, auto_renew: true, locked: true, nameservers: ['ns1.afternic.com'] },
      ]);
      expect(calls.every((c) => c.method === 'GET' && c.body === null)).toBe(true);
      expect(calls.find((c) => c.url.includes('godaddy'))!.headers.get('authorization')).toBe('Bearer fake-pat');
    });
    it('no keys: each row says missing_key and nothing is known', async () => {
      withReplies({}, {});
      expect(await rows()).toMatchObject([{ status: 'missing_key', auto_renew: null, expiry_matches: null }, { status: 'missing_key', auto_renew: null, nameservers: null }]);
      expect(calls).toEqual([]);
    });
    it.each(BAD)('%s: an error in that row; the other registrar still answers', async (_n, reply, code) => {
      withReplies({ ...good, '/domain/getNs/pork.com': reply });
      expect(await rows()).toMatchObject([{ status: 'error', error: { source: 'porkbun', reason: code }, auto_renew: null }, { status: 'ok' }]);
      await app.close();
      withReplies({ ...good, 'api.godaddy.com/v3': reply });
      expect(await rows()).toMatchObject([{ status: 'ok' }, { status: 'error', error: { source: 'godaddy', reason: code }, auto_renew: null }]);
    });
    it('a name that is not in the account, and a list that was cut', async () => {
      withReplies({ ...good, 'api.godaddy.com/v3': { body: { items: [], links: [] } } });
      expect((await rows())[1]).toMatchObject({ status: 'error', error: { reason: 'NOT_IN_ACCOUNT' } });
      await app.close();
      withReplies({ ...good, 'api.godaddy.com/v3': { body: { items: [], links: [{ rel: 'next' }] } } });
      expect((await rows())[1]).toMatchObject({ status: 'error', error: { reason: 'BAD_RESPONSE' } });
    });
    it('a missing field or another name in the answer is an error, not a default', async () => {
      withReplies({ ...good, '/domain/get/pork.com': { body: { ...pb, domain: { ...pb.domain, autoRenew: undefined } } }, 'api.godaddy.com/v3': { body: { items: [{ domain: 'daddy.com', expiresAt: '2027-11-04T00:00:00Z' }] } } });
      expect(await rows()).toMatchObject([{ status: 'error' }, { status: 'error' }]);
      await app.close();
      withReplies({ ...good, '/domain/get/pork.com': { body: { ...pb, domain: { ...pb.domain, domain: 'other.com' } } } });
      expect((await rows())[0]).toMatchObject({ status: 'error', error: { reason: 'BAD_RESPONSE' } });
    });
  });

  const LISTING = { name: 'Pork.com', listStatus: 'ACTIVE', hidden: false, fastTransferStatus: 'ACTIVE', buynowPrice: 1_488_000_000, floorPrice: 0, minbidPrice: 100_000_000, leasingEnabled: false, intakeLeads: 0, intakeViews: 3 };
  const SALE = { name: 'pork.com', status: 'PENDING', saleType: 'BUYNOW', salePrice: 1_488_000_000, commission: 223_200_000, soldAt: '2026-11-20T00:00:00Z', authCode: 'SECRET-CODE' };
  const AVAILABLE = { availabilities: [{ domainName: 'a.com', status: 'AVAILABLE', listing: { listingId: 7, listingType: 'EXPIRY_AUCTIONS', currencyId: 'USD', auctionEndAt: '2026-12-01T18:00:00Z', priceCurrent: 50_000_000, priceNextBid: 55_000_000, priceTransfer: 11_990_000, priceRenewal: 21_990_000 } }, { domainName: 'B.com', status: 'UNAVAILABLE' }] };
  const XML = '<?xml version="1.0"?><ns2:T xmlns:ns1="a" xmlns:ns2="b"><ns1:ApplicationNumberText>78787878</ns1:ApplicationNumberText><ns2:MarkCurrentStatusDate>2019-05-01-04:00</ns2:MarkCurrentStatusDate><ns2:MarkCurrentStatusExternalDescriptionText>Registered &amp; renewed</ns2:MarkCurrentStatusExternalDescriptionText><ns2:MarkVerbalElementText>ACME</ns2:MarkVerbalElementText></ns2:T>';
  const ROUTES: [string, string, unknown][] = [
    ['/listings', '/customers/my/domains', { domains: [LISTING], pagination: { total: 1 } }],
    ['/sales', '/customers/my/sales', { sales: [SALE], pagination: { total: 1 } }],
    ['/auctions?domains=a.com,b.com', '/listings/available', AVAILABLE],
    ['/trademarks/78787878', '/casestatus/sn78787878/info.xml', XML],
  ];

  it('/listings: prices in cents; the key goes in the header', async () => {
    withReplies({ [ROUTES[0]![1]]: { body: ROUTES[0]![2] } });
    expect((await get('/listings')).json().listings).toEqual([{ domain: 'pork.com', list_status: 'ACTIVE', hidden: false, fast_transfer_status: 'ACTIVE', lease_to_own: false, leads: 0, views: 3, buy_now_cents: 148_800, buy_now: '$1,488.00', floor_cents: 0, floor: '$0.00', min_offer_cents: 10_000, min_offer: '$100.00' }]);
    expect([calls[0]!.method, calls[0]!.headers.get('authorization')]).toEqual(['GET', 'sso-key fake-ak:fake-as']);
  });
  it('/sales: from before our first purchase; the transfer code is never shown', async () => {
    withReplies({ [ROUTES[1]![1]]: { body: ROUTES[1]![2] } });
    const r = await get('/sales');
    expect(r.json().sales).toEqual([{ domain: 'pork.com', status: 'PENDING', sale_type: 'BUYNOW', sold_at: '2026-11-20T00:00:00Z', disbursed_at: null, price_cents: 148_800, price: '$1,488.00', commission_cents: 22_320, commission: '$223.20' }]);
    expect(r.body).not.toContain('SECRET-CODE');
    expect(new URL(calls[0]!.url).searchParams.get('soldAtStartDate')).toBe('2026-10-01T00:00:00Z');
  });
  it('/auctions: the price now, the next bid, renewal and transfer; only the availability check is called', async () => {
    withReplies({ [ROUTES[2]![1]]: { body: ROUTES[2]![2] } });
    expect((await get('/auctions?domains=A.com,%20b.com,a.com')).json().auctions).toMatchObject([
      { domain: 'a.com', for_sale: true, listing_id: 7, price_cents: 5000, next_bid: '$55.00', renewal_cents: 2199, transfer_cents: 1199 },
      { domain: 'b.com', for_sale: false, price_cents: null },
    ]);
    expect([calls.length, calls[0]!.body, calls[0]!.headers.get('authorization')]).toEqual([1, '{"domains":["a.com","b.com"]}', 'sso-key fake-gk:fake-gs']);
  });
  it('/auctions: a name left out of the answer is an error, not "not for sale"; bad input is 400', async () => {
    withReplies({ [ROUTES[2]![1]]: { body: ROUTES[2]![2] } });
    expect((await get('/auctions?domains=a.com,c.com')).json().error.code).toBe('SOURCE_ERROR');
    for (const u of ['/auctions', '/auctions?domains=', `/auctions?domains=${Array.from({ length: 51 }, (_, i) => `n${i}.com`).join(',')}`]) expect((await get(u)).statusCode, u).toBeGreaterThanOrEqual(400);
    expect(calls.length).toBe(1);
  });
  it('/trademarks/{serial}: one status by serial number', async () => {
    withReplies({ [ROUTES[3]![1]]: { body: XML } });
    expect((await get('/trademarks/78787878')).json()).toMatchObject({ serial: '78787878', mark: 'ACME', status: 'Registered & renewed', status_date: '2019-05-01' });
    expect(calls[0]!.headers.get('uspto-api-key')).toBe('fake-us');
    for (const s of ['1', 'abcdefgh', '123456789']) expect((await get(`/trademarks/${s}`)).statusCode).toBe(400);
    await app.close();
    withReplies({ '/casestatus/sn11111111': { body: XML } });
    expect((await get('/trademarks/11111111')).statusCode).toBe(502); // another mark's record
  });
  it('/listings and /sales: a cut page is an error', async () => {
    withReplies({ '/customers/my/domains': { body: { domains: [LISTING], pagination: { total: 2 } } }, '/customers/my/sales': { body: { sales: [], pagination: { total: 1 } } } });
    for (const u of ['/listings', '/sales']) expect((await get(u)).statusCode, u).toBe(502);
  });

  it.each(ROUTES)('%s without its key: 503 and no outside call; half a pair is no key', async (url) => {
    for (const env of [{}, { GODADDY_API_KEY: 'x', AFTERNIC_API_SECRET: 'y', USPTO_API_KEY: ' ' }] as Record<string, string>[]) {
      withReplies({}, env);
      const r = await get(url);
      expect([r.statusCode, r.json().error.code, r.json().error.details.reason, calls.length]).toEqual([503, 'SOURCE_KEY_MISSING', 'KEY_MISSING', 0]);
      await app.close();
    }
    make();
  });
  it.each(ROUTES.flatMap(([url, host]) => BAD.map(([n, reply, code]) => [url, n, host, reply, code] as const)))('%s: %s is 502', async (_url, _n, host, reply, code) => {
    withReplies({ [host]: reply });
    const r = await get(_url);
    expect([r.statusCode, r.json().error.code]).toEqual([502, 'SOURCE_ERROR']);
    // the XML route takes any text, so "not JSON" is a bad record there
    expect(r.json().error.details.reason).toBe(code);
    if (code === 'HTTP_ERROR' && (reply as { status: number }).status === 403) expect(r.json().error.details).toMatchObject({ http_status: 403, source_code: 'NOT_ELIGIBLE' });
  });

  it('no key is ever in an answer, and /health only says which are set', async () => {
    withReplies({ 'webrisk': { body: {} }, 'api.': { status: 401, body: { code: 'fake-ak', message: 'fake-as' } } });
    for (const u of ['/health', '/check?domain=new.com', '/registrar-status', '/trademarks/78787878']) {
      const { body } = await get(u);
      for (const k of Object.values(KEYS)) if (k !== 'fake-ak') expect(body, u).not.toContain(k);
    }
    expect((await get('/health')).json().keys_set).toEqual({ porkbun: true, web_risk: true, godaddy: true, godaddy_auctions: true, afternic: true, uspto_tsdr: true });
  });
});
