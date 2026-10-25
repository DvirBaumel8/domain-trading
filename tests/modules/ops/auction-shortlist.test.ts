// v5.45.0 (G-127): the datasave step auctionShortlist, GET /auctions/shortlist and GET /auctions/funnel. Test ids AS545-*; rules in docs/internal/auctions.md "Shortlist".
// Outside calls: RDAP and DNS are fakes, the IANA bootstrap and the Web Risk lookup are MSW (unhandled requests fail).
import { maxBidRule } from '../../../src/modules/ops/auctions/shortlist-score.js';
import { gzipSync } from 'node:zlib';
import { http, HttpResponse } from 'msw';
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withDbScope } from '../../../src/core/db-stats.js';
import type { RdapLookup } from '../../../src/core/rdap.js';
import { LiftTrainJob } from '../../../src/modules/engine/index.js';
import { runAuctionShortlist } from '../../../src/modules/ops/auctions/shortlist.js';
import { DatasaveJob } from '../../../src/modules/ops/jobs/datasave/datasave.js';
import type { ScreeningDeps } from '../../../src/modules/selection/index.js';
import { makeApp } from '../../helpers/app.js';
import { insertBidPlan } from '../../helpers/bid-plans.js';
import { insertOwnedDomain, testDb as db } from '../../helpers/db.js';
import { patchActiveSettings, putList } from '../../helpers/screening.js';
import { fixture, respond } from '../../helpers/screening-fixtures.js';
import { issueToken } from '../../helpers/tokens.js';
import { mswServer } from '../../setup/network.js';

const NOW = Date.parse('2026-10-25T15:00:00Z');
const DATE = '2026-10-25';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let clock: { t: number };
let rdapTable: Record<string, RdapLookup>;
let rdapCalls: string[];
let rdapThrowFor: Set<string>;
let app: FastifyInstance | null = null;

const facts = { registrar: 'Fake Registrar', created_at: '2019-01-01T00:00:00Z', expires_at: '2026-11-01T00:00:00Z', updated_at: null, statuses: ['active'], nameservers: [] };
const registered = (): RdapLookup => ({ outcome: 'registered', reasonCode: null, httpStatus: 200, url: 'https://rdap.example/x', retrievedAt: new Date(), body: '{}', facts });
const free = (): RdapLookup => ({ outcome: 'not_registered', reasonCode: null, httpStatus: 404, url: 'https://rdap.example/x', retrievedAt: new Date(), body: null, facts: null });

function screeningDeps(extra: Partial<ScreeningDeps> = {}): ScreeningDeps {
  return {
    fetch: globalThis.fetch, sleep: async () => {}, checkService: {} as never,
    rdapLookup: async (d: string) => { rdapCalls.push(d); if (rdapThrowFor.has(d)) throw new Error('rdap exploded'); return rdapTable[d] ?? free(); },
    dnsQuery: async () => ({ rcode: 3, answers: [] }), resolveNs: async () => { throw new Error('DNS blocked in tests'); }, resolve4: async () => { throw new Error('DNS blocked in tests'); },
    siteFetch: ((i: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => globalThis.fetch(i, init)) as typeof fetch, lookupHost: async () => [{ address: '93.184.216.34', family: 4 }],
    ...extra,
  };
}

interface Live { price?: number; bids?: number; inH?: number; age?: number | null; views?: number | null; valuation?: number | null; date?: string; type?: string }
const live = (domain: string, o: Live = {}) => db.insertInto('godaddy_auctions_live').values({
  data_date: o.date ?? DATE, domain, end_time: new Date(NOW + (o.inH ?? 30) * HOUR), auction_type: o.type ?? 'Bid', price_cents: o.price ?? 5000, bid_count: o.bids ?? 4,
  domain_age: o.age === undefined ? 6 : o.age, valuation_cents: o.valuation === undefined ? 90_000 : o.valuation, pageviews: o.views === undefined ? null : o.views,
}).execute();

const WORDS_A = ['bright', 'blue', 'smart', 'green', 'quiet', 'solid', 'happy', 'fresh'];
const WORDS_B = ['widgets', 'garden', 'coffee', 'studio', 'market', 'bridge', 'harbor', 'planet'];
const nameN = (i: number): string => `${WORDS_A[i % 8]}${WORDS_B[Math.floor(i / 8) % 8]}.com`;

const runStep = (extra: Partial<Parameters<typeof runAuctionShortlist>[0]> = {}) => runAuctionShortlist({ db, now: () => clock.t, ...extra });
const shortlist = (date = DATE) => db.selectFrom('auction_shortlist').selectAll().where('data_date', '=', date).orderBy('rank').execute();

beforeEach(async () => {
  clock = { t: NOW }; rdapTable = {}; rdapCalls = []; rdapThrowFor = new Set();
  mswServer.use(http.get('https://data.iana.org/rdap/dns.json', () => respond(fixture('iana-dns.json'))));
  await patchActiveSettings(['sources', 'surbl'], false);
  await patchActiveSettings(['sources', 'popularity'], false);
  await putList('brand', ['zzbrand']);
  await putList('bigco', ['zzbigco']);
});
afterEach(async () => { await app?.close(); app = null; });

describe('AS545 shortlist: filters and score', () => {
  it('AS545-5: only in-range live auctions that end inside the horizon, with bids, .com, not owned, no open bid plan, and passing the name rules, are listed (counts per filter in the step summary)', async () => {
    await live('brightwidgets.com');
    await live('bluecoffee.com', { inH: 71 });
    await live('smartgarden.com', { inH: 80 }); // beyond the 72 h horizon
    await live('greenstudio.com', { inH: -2 }); // already ended
    await live('quietmarket.com', { price: 26_000 }); // over the S8 cap
    await live('solidbridge.com', { bids: 0 });
    await live('happyharbor.com', { date: '2026-10-24' }); // an older data date
    await live('freshplanet.com');
    await live('brightstudio.com'); // owned
    await live('bluemarket.com'); // open bid plan
    await putList('brand', ['harbor'], 2);
    await live('harborcoffee.com'); // BRAND-1
    await live('x1y2.com'); // SPELL-1
    await insertOwnedDomain(db, { domain: 'brightstudio.com' });
    await insertBidPlan(db, { domain: 'bluemarket.com', kind: 'auction' });
    const r = await runStep() as Record<string, any>;
    expect(r).toMatchObject({ status: 'ok', data_date: DATE, score_version: 'auction-v2', shortlisted_n: 3 });
    expect(r.dropped).toMatchObject({ owned_n: 1, open_plan_n: 1, name_rules: { 'BRAND-1': 1, 'SPELL-1': 1 } });
    expect((await shortlist()).map((x) => x.domain).sort()).toEqual(['bluecoffee.com', 'brightwidgets.com', 'freshplanet.com']);
  });

  it('AS545-6: rows carry rank, score, version, parts, price, bids, end time, valuation (stored, not scored), a maximum bid in whole $5 and reasons; the better name ranks first', async () => {
    await live('brightstudio.com', { price: 3000, bids: 9, age: 8 });
    await live('solidharborcoffeeplanet.com', { price: 3000, bids: 9, age: 8, valuation: 5_000_000 }); // 4 words and long: lower shape
    const r = await runStep() as Record<string, any>;
    expect(r.shortlisted_n).toBe(2);
    const rows = await shortlist();
    expect(rows.map((x) => x.domain)).toEqual(['brightstudio.com', 'solidharborcoffeeplanet.com']);
    expect(rows[0]!.rank).toBe(1);
    expect(rows[0]!.score).toBeGreaterThan(rows[1]!.score);
    expect(rows[0]).toMatchObject({ score_version: 'auction-v2', price_cents: 3000, bids: 9, valuation_cents: 90_000, domain_age: 8, dropped_reason: null, prebid_id: null });
    // the suggested maximum: 20% of the expected net resale ($1,000 less 20% commission = $160), scaled by the score (full from 70), whole $5 (v5.45.0 review)
    expect(rows[0]!.max_bid_suggested_cents).toBe(maxBidRule({ capCents: 25_000, resaleCents: 100_000, commission: 0.2, score: Number(rows[0]!.score) }));
    expect(rows[0]!.max_bid_suggested_cents).toBeLessThanOrEqual(16_000);
    expect(rows[0]!.max_bid_suggested_cents % 500).toBe(0);
    expect(rows[1]!.valuation_cents).toBe(5_000_000); // shown, but does not lift the rank
    expect((rows[0]!.parts as { name: { points: number } }).name.points).toBeGreaterThan(0);
    expect(rows[0]!.reasons.join(' ')).toContain('2 words');
  });

  it('AS545-7: the list is replaced per data date (a second run replaces, another date is untouched) and is cut to shortlist_size', async () => {
    for (let i = 0; i < 6; i++) await live(nameN(i));
    await sql`update settings set shortlist_size = 4`.execute(db);
    await runStep();
    expect(await shortlist()).toHaveLength(4);
    await db.insertInto('auction_shortlist').values({ data_date: '2026-10-24', domain: 'old.com', rank: 1, score: 50, score_version: 'auction-v2', parts: '{}', price_cents: 100, bids: 1, end_time: new Date(NOW), max_bid_suggested_cents: 500, reasons: [], generated_at: new Date(NOW) }).execute();
    await db.deleteFrom('godaddy_auctions_live').where('domain', '=', nameN(0)).execute();
    await runStep();
    const rows = await shortlist();
    expect(rows).toHaveLength(4);
    expect(rows.map((x) => x.domain)).not.toContain(nameN(0));
    expect(await shortlist('2026-10-24')).toHaveLength(1);
  });

  it('AS545-8: no live data is a no_data step answer; the step does not fail on an empty day', async () => {
    expect(await runStep()).toMatchObject({ status: 'no_data', shortlisted_n: 0 });
    await live('brightstudio.com', { inH: 100 });
    expect(await runStep()).toMatchObject({ status: 'ok', shortlisted_n: 0 });
  });

  it('AS545-9: BRAND-TYPO-2 against the stored popularity list: a typo or look-alike of a brand is dropped, an ordinary-word brand is kept with a note; no list or an old list skips it', async () => {
    await live('paypall.com'); await live('brightstudio.com'); await live('targetmarketing.com');
    const none = await runStep() as Record<string, any>;
    expect(none.brand_typo).toBe('off');
    await patchActiveSettings(['sources', 'popularity'], true);
    expect((await runStep() as Record<string, any>).brand_typo).toBe('no_list');
    const body = '1,paypal.com,com\n2,target.com,com';
    await db.insertInto('reference_files').values({ name: 'popularity_list', source_url: 'https://downloads.majestic.com/majestic_million.csv', fetched_at: new Date(NOW), data_date: DATE, sha256: 'as545', bytes: body.length, body_gz: gzipSync(Buffer.from(body, 'utf8')), same_as_id: null }).execute();
    const r = await runStep() as Record<string, any>;
    expect(r.brand_typo).toBe('on');
    expect(r.dropped.brand_typo_n).toBe(1);
    const rows = await shortlist();
    expect(rows.map((x) => x.domain).sort()).toEqual(['brightstudio.com', 'targetmarketing.com']);
    expect(rows.find((x) => x.domain === 'targetmarketing.com')!.reasons.join(' ')).toContain('brand-like');
  });
});

describe('AS545 shortlist: endings', () => {
  it('AS545-10: the five other endings of the top names are asked (RDAP) when unknown or older than 30 days, stored in engine_endings, and the score uses the answers; fresh answers are not asked again', async () => {
    await live('brightstudio.com'); await live('bluecoffee.com'); await live('smartgarden.com');
    rdapTable['brightstudio.net'] = registered(); rdapTable['brightstudio.org'] = registered();
    // bluecoffee: a fresh answer for all five endings (not asked); smartgarden: .net answered 40 days ago (asked again), the rest never asked
    for (const tld of ['net', 'org', 'co', 'io', 'ai']) await sql`insert into engine_endings (name, tld, registered, checked_at) values ('bluecoffee', ${tld}, false, ${new Date(NOW - 5 * DAY)})`.execute(db);
    await sql`insert into engine_endings (name, tld, registered, checked_at) values ('smartgarden', 'net', false, ${new Date(NOW - 40 * DAY)})`.execute(db);
    await sql`update settings set shortlist_prebid_n = 0`.execute(db);
    const r = await runStep({ screening: screeningDeps() }) as Record<string, any>;
    expect(r.endings).toMatchObject({ wanted_n: 2, status: 'ok', partial: false });
    expect(r.endings.asked).toBe(10);
    expect(rdapCalls.filter((c) => c.startsWith('bluecoffee.') && !c.endsWith('.com'))).toEqual([]);
    const ends = await db.selectFrom('engine_endings').select(['name', 'tld', 'registered']).where('name', '=', 'brightstudio').execute();
    expect(ends).toHaveLength(5);
    expect(ends.filter((e) => e.registered).map((e) => e.tld).sort()).toEqual(['net', 'org']);
    const sm = await db.selectFrom('engine_endings').select(['tld', 'registered']).where('name', '=', 'smartgarden').where('tld', '=', 'net').execute();
    expect(sm.length).toBeGreaterThanOrEqual(1);
    const rows = await shortlist();
    const bw = rows.find((x) => x.domain === 'brightstudio.com')!;
    expect((bw.parts as { name: { endings_known: number; endings_registered: number } }).name).toMatchObject({ endings_known: 5, endings_registered: 2 });
    expect(bw.reasons.join(' ')).toContain('.net, .org');
    expect(rows[0]!.domain).toBe('brightstudio.com'); // the registered endings lift it above the equal-shape names
  });

  it('AS545-11: an unanswered ask stays unknown (the part is rescaled, not zero); the time budget stops asking and reports partial; no screening deps skips the endings', async () => {
    await live('brightstudio.com'); await live('bluecoffee.com');
    // every RDAP answer takes 90 s on the clock; the budget is 60 s: each worker asks once and stops
    const slow = screeningDeps({ rdapLookup: async (d: string) => { clock.t += 90_000; rdapCalls.push(d); return { ...free(), outcome: 'unknown', reasonCode: 'TIMEOUT' } as RdapLookup; } });
    await sql`update settings set shortlist_prebid_n = 0`.execute(db);
    const r = await runStep({ screening: slow, endingsBudgetMs: 60_000 }) as Record<string, any>;
    expect(r.endings.partial).toBe(true);
    expect(r.endings.unknown).toBe(r.endings.asked);
    const rows = await shortlist();
    for (const x of rows) expect((x.parts as { name: { endings_value: number | null } }).name.endings_value).toBeNull();
    clock.t = NOW;
    await db.deleteFrom('engine_endings').execute();
    const off = await runStep() as Record<string, any>;
    expect(off.endings.status).toBe('not_configured');
    expect(off.prebid.status).toBe('not_configured');
  });
});

describe('AS545 shortlist: automatic pre-bid', () => {
  const prebids = () => db.selectFrom('prebid_checks').select(['id', 'domain', 'venue', 'verdict', 'token_name', 'audit_id']).orderBy('id').execute();

  it('AS545-12: the top shortlist_prebid_n names get a stored pre-bid (venue godaddy, by datasave, audit null) and the shortlist row points at it; the rest get none', async () => {
    for (let i = 0; i < 5; i++) await live(nameN(i));
    rdapTable[nameN(0)] = registered();
    for (let i = 0; i < 5; i++) rdapTable[nameN(i)] = registered();
    await sql`update settings set shortlist_prebid_n = 3`.execute(db);
    const r = await runStep({ screening: screeningDeps() }) as Record<string, any>;
    expect(r.prebid).toMatchObject({ checked_n: 3, pass_n: 3, fail_n: 0, errors_n: 0, status: 'ok' });
    const pb = await prebids();
    expect(pb).toHaveLength(3);
    expect(pb[0]).toMatchObject({ venue: 'godaddy', verdict: 'pass', token_name: 'datasave', audit_id: null });
    const rows = await shortlist();
    expect(rows.slice(0, 3).map((x) => x.prebid_id)).toEqual(pb.map((p) => p.id));
    expect(rows.slice(0, 3).every((x) => x.prebid_verdict === 'pass')).toBe(true);
    expect(rows.slice(3).every((x) => x.prebid_id === null)).toBe(true);
    const stored = (await db.selectFrom('prebid_checks').select('answer').where('id', '=', pb[0]!.id).executeTakeFirstOrThrow()).answer as { checks: unknown[]; domain: string; manual_required: unknown[] };
    expect(stored.checks.length).toBe(14);
    expect(stored.manual_required).toHaveLength(2);
  });

  it('AS545-13: a second run on the same day reuses a pre-bid younger than 12 hours (no new row)', async () => {
    await live(nameN(0)); rdapTable[nameN(0)] = registered();
    await runStep({ screening: screeningDeps() });
    clock.t = NOW + 2 * HOUR;
    const r = await runStep({ screening: screeningDeps() }) as Record<string, any>;
    expect(r.prebid).toMatchObject({ reused_n: 1, checked_n: 1 });
    expect(await prebids()).toHaveLength(1);
    clock.t = NOW + 20 * HOUR;
    await live(nameN(0), { inH: 40, date: '2026-10-26' });
    await runStep({ screening: screeningDeps() });
    expect(await prebids()).toHaveLength(2);
  });

  it('AS545-14: a FAIL drops the name from the served list (kept in the table with the reason) and the next name takes its pre-bid slot', async () => {
    for (let i = 0; i < 4; i++) { await live(nameN(i)); rdapTable[nameN(i)] = registered(); }
    await sql`update settings set shortlist_prebid_n = 2`.execute(db);
    const failing = (await (async () => { await runStep(); return (await shortlist())[0]!.domain; })());
    const failKey = failing.slice(0, -4);
    mswServer.use(http.get('https://webrisk.googleapis.com/v1/uris:search', ({ request }) => {
      const uri = new URL(request.url).searchParams.get('uri') ?? '';
      return uri.includes(failKey) ? HttpResponse.json({ threat: { threatTypes: ['MALWARE'], expireTime: '2026-12-01T00:00:00Z' } }) : HttpResponse.json({});
    }));
    const r = await runStep({ screening: screeningDeps({ webRiskApiKey: 'fake-web-risk-key' }) }) as Record<string, any>;
    expect(r.prebid).toMatchObject({ fail_n: 1, pass_n: 2, checked_n: 3 });
    const rows = await shortlist();
    const bad = rows.find((x) => x.domain === failing)!;
    expect(bad).toMatchObject({ prebid_verdict: 'fail' });
    expect(bad.dropped_reason).toContain('WEB-RISK-1');
    expect(r.served_n).toBe(3);
    const owner = (await issueToken('read')).auth;
    app = await makeApp({ now: () => NOW });
    const res = await app.inject({ method: 'GET', url: '/auctions/shortlist', headers: owner });
    expect(res.json().rows.map((x: { domain: string }) => x.domain)).not.toContain(failing);
    expect(res.json().rows).toHaveLength(3);
  });

  it('AS545-15: a pre-bid that throws for one name never fails the step; the next names are checked', async () => {
    for (let i = 0; i < 3; i++) { await live(nameN(i)); rdapTable[nameN(i)] = registered(); }
    await sql`update settings set shortlist_prebid_n = 2`.execute(db);
    await runStep();
    const first = (await shortlist())[0]!.domain;
    rdapThrowFor.add(first);
    const r = await runStep({ screening: screeningDeps() }) as Record<string, any>;
    expect(r.status).toBe('ok');
    expect(r.prebid.errors_n).toBe(1);
    expect(r.prebid.checked_n).toBe(2);
    expect(await shortlist()).toHaveLength(3);
    expect((await shortlist()).find((x) => x.domain === first)!.prebid_id).toBeNull();
  });
});

describe('AS545 bulk work', () => {
  it('AS545-16: the step needs the same number of queries for 12 and 60 candidates (no row-by-row work, no screening deps)', async () => {
    const seed = async (n: number) => { await db.deleteFrom('godaddy_auctions_live').execute(); for (let i = 0; i < n; i++) await live(nameN(i)); };
    await seed(12);
    const a = await withDbScope('as545-16a', () => runStep());
    await seed(60);
    const b = await withDbScope('as545-16b', () => runStep());
    expect((b.value as Record<string, unknown>).candidates_n).toBe(60);
    expect(b.stats.queries).toBeLessThanOrEqual(a.stats.queries + 2);
    expect(b.stats.queries).toBeLessThan(40);
  });

  it('AS545-17: the endings fetch and the shortlist write use batches: 40 names x 5 endings take a bounded number of queries', async () => {
    for (let i = 0; i < 40; i++) await live(nameN(i));
    await sql`update settings set shortlist_endings_n = 40, shortlist_size = 40, shortlist_prebid_n = 0`.execute(db);
    const r = await withDbScope('as545-17', () => runStep({ screening: screeningDeps() }));
    expect((r.value as Record<string, any>).endings.asked).toBe(200);
    expect(r.stats.queries).toBeLessThan(60);
  });

  it('AS545-18: the datasave job step wraps it and the retention step deletes shortlist rows older than shortlist_keep_days', async () => {
    await live(nameN(0));
    const job = new DatasaveJob({ db, now: () => NOW, snapshotDir: '/tmp/as545-none' });
    expect(await job.auctionShortlist()).toMatchObject({ status: 'ok', shortlisted_n: 1 });
    await db.insertInto('auction_shortlist').values({ data_date: '2026-06-01', domain: 'old.com', rank: 1, score: 50, score_version: 'auction-v2', parts: '{}', price_cents: 100, bids: 1, end_time: new Date(NOW), max_bid_suggested_cents: 500, reasons: [], generated_at: new Date(NOW) }).execute();
    const ret = await job.snapshotRetention() as Record<string, unknown>;
    expect(ret.shortlist_rows_deleted).toBe(1);
    expect((await db.selectFrom('auction_shortlist').select('domain').execute()).map((x) => x.domain)).toEqual([nameN(0)]);
  });
});

describe('AS545 routes', () => {
  const get = (url: string, auth: Record<string, string>) => app!.inject({ method: 'GET', url, headers: auth });

  it('AS545-19: GET /auctions/shortlist: READ and bots may read, a data token is 403, no token 401; rows carry the score, parts, suggested maximum, the pre-bid (id, verdict, flags) and the settings used; limit and date work', async () => {
    for (let i = 0; i < 4; i++) { await live(nameN(i)); rdapTable[nameN(i)] = registered(); }
    rdapTable['bluewidgets.net'] = registered();
    mswServer.use(
      http.get('https://bluewidgets.net/robots.txt', () => new HttpResponse(null, { status: 404 })),
      http.get('https://bluewidgets.net/', () => new HttpResponse('<html><body>' + 'We sell widgets to small shops and ship them worldwide every week. '.repeat(10) + '</body></html>', { status: 200, headers: { 'content-type': 'text/html' } })),
    );
    await runStep({ screening: screeningDeps() });
    app = await makeApp({ now: () => NOW });
    expect((await app.inject({ method: 'GET', url: '/auctions/shortlist' })).statusCode).toBe(401);
    expect((await get('/auctions/shortlist', (await issueToken('data')).auth)).statusCode).toBe(403);
    const res = await get('/auctions/shortlist', (await issueToken('bots')).auth);
    expect(res.statusCode, res.body).toBe(200);
    const j = res.json();
    expect(j).toMatchObject({ data_date: DATE, total: 4, settings: { shortlist_size: 25, shortlist_prebid_n: 10, shortlist_horizon_hours: 72, shortlist_endings_n: 50, score_version: 'auction-v2' } });
    expect(j.generated_at).toMatch(/\+0[23]:00$/);
    const top = j.rows[0];
    expect(top).toMatchObject({ rank: 1, domain: 'bluewidgets.com', price_cents: 5000, price: '$50.00', valuation_cents: 90_000, bids: 4 });
    expect(top.max_bid_suggested_cents).toBe(maxBidRule({ capCents: 25_000, resaleCents: 100_000, commission: 0.2, score: Number(top.score) }));
    expect(top.end_time).toMatch(/\+0[23]:00$/);
    expect(top.parts.name).toBeDefined();
    expect(top.reasons.length).toBeGreaterThan(2);
    expect(top.prebid).toMatchObject({ verdict: 'flag', id: expect.any(Number) });
    expect(top.prebid.flags.map((f: { id: string }) => f.id)).toContain('SAME_NAME_ENDINGS');
    expect(Date.parse(top.prebid.valid_until) - Date.parse(top.prebid.checked_at)).toBe(72 * HOUR);
    expect(j.rows.every((r: { prebid: unknown }) => r.prebid !== null)).toBe(true);
    const lim = (await get('/auctions/shortlist?limit=2', (await issueToken('read')).auth)).json();
    expect(lim.rows).toHaveLength(2);
    expect((await get('/auctions/shortlist?date=2026-10-20', (await issueToken('read')).auth)).json()).toMatchObject({ data_date: '2026-10-20', total: 0, rows: [] });
    expect((await get('/auctions/shortlist?date=nope', (await issueToken('read')).auth)).statusCode).toBe(400);
    expect((await get('/auctions/shortlist?limit=0', (await issueToken('read')).auth)).statusCode).toBe(400);
    expect((await get('/auctions/shortlist?x=1', (await issueToken('read')).auth)).statusCode).toBe(400);
  });

  it('AS545-20: with no shortlist yet the route answers an empty list; an auction that has ended is not served', async () => {
    app = await makeApp({ now: () => NOW });
    const auth = (await issueToken('read')).auth;
    expect((await get('/auctions/shortlist', auth)).json()).toMatchObject({ data_date: null, generated_at: null, total: 0, rows: [] });
    await live(nameN(0));
    await runStep();
    await app.close();
    app = await makeApp({ now: () => NOW + 40 * HOUR });
    expect((await get('/auctions/shortlist', (await issueToken('read')).auth)).json().rows).toEqual([]);
  });

  it('AS545-21: GET /auctions/funnel counts the steps of the range: seen, shortlisted, auto pre-bid, bot pre-bids, plans by status, imported, S8 names bought / listed / sold, traffic, sales', async () => {
    for (let i = 0; i < 4; i++) { await live(nameN(i)); rdapTable[nameN(i)] = registered(); }
    await live('olderauction.com', { date: '2026-10-10' });
    await sql`update settings set shortlist_prebid_n = 4`.execute(db);
    await runStep({ screening: screeningDeps() });
    // a bot pre-bid and a plan that was won and imported, one that was lost
    const bot = await db.insertInto('prebid_checks').values({ domain: 'brightstudio.com', venue: 'godaddy', verdict: 'pass', answer: '{}', token_name: 'gavriel', created_at: new Date(NOW) }).returning('id').executeTakeFirstOrThrow();
    expect(bot.id).toBeGreaterThan(0);
    const won = await insertBidPlan(db, { domain: 'brightstudio.com', kind: 'auction', status: 'won', createdAt: new Date(NOW - HOUR), finalPriceCents: 4000, maxBidCents: 6000 });
    await insertBidPlan(db, { domain: 'bluecoffee.com', kind: 'auction', status: 'lost', createdAt: new Date(NOW - HOUR), maxBidCents: 5000 });
    await sql`insert into bid_plan_events (plan_id, event, from_status, to_status, created_at) values (${won}, 'imported', 'won', 'won', ${new Date(NOW)})`.execute(db);
    await insertOwnedDomain(db, { domain: 'brightstudio.com', status: 'listed', lane: 'S8', buy_date: '2026-10-24' });
    await sql`insert into visit_daily (domain, date_utc, source, views_30d, leads_30d, human_hits) values ('brightstudio.com', '2026-10-25', 'afternic', 12, 2, 0)`.execute(db);
    app = await makeApp({ now: () => NOW });
    const auth = (await issueToken('read')).auth;
    const res = await get(`/auctions/funnel?from=2026-10-19&to=${DATE}`, auth);
    expect(res.statusCode, res.body).toBe(200);
    const j = res.json();
    expect(j).toMatchObject({
      from: '2026-10-19', to: DATE, seen: { live_auctions: 4 },
      shortlisted: { names: 4, served: 4 }, auto_prebid: { checked: 4, pass: 4, flag: 0, fail: 0 },
      prebids_by_bots: { checks: 3, names: 2 },
      imported: 1,
      bid_plans: { created: 2, won: 1, lost: 1, open: 0, expired: 0, withdrawn: 0, max_bid_total_cents: 11_000 },
      s8_names: { bought: 1, listed_of_bought: 1, sold_of_bought: 0, listed_now: 1 },
      traffic_of_bought: { views_30d: 12, leads_30d: 2 }, sold: { count: 0, gross_cents: 0 },
    });
    const def = (await get('/auctions/funnel', auth)).json();
    expect(def.to).toBe(DATE);
    expect(def.from).toBe('2026-10-19');
    expect((await get('/auctions/funnel?from=2026-10-25&to=2026-10-01', auth)).statusCode).toBe(400);
    expect((await get('/auctions/funnel?from=bad', auth)).statusCode).toBe(400);
    expect((await get('/auctions/funnel', (await issueToken('data')).auth)).statusCode).toBe(403);
    const empty = (await get('/auctions/funnel?from=2026-01-01&to=2026-01-07', auth)).json();
    expect(empty).toMatchObject({ seen: { live_auctions: 0 }, shortlisted: { names: 0 }, bid_plans: { created: 0 }, imported: 0, sold: { count: 0 } });
  });

  it('AS545-22: the funnel uses one query per table (bounded) however many rows there are', async () => {
    for (let i = 0; i < 20; i++) await live(nameN(i));
    await runStep();
    app = await makeApp({ now: () => NOW });
    const auth = (await issueToken('read')).auth;
    const r = await withDbScope('as545-22', async () => get('/auctions/funnel', auth));
    expect(r.value.statusCode).toBe(200);
    expect(r.stats.queries).toBeLessThanOrEqual(14); // the funnel's 8 reads plus the auth lookups
  });
});

describe('ST547 shortlist adult filter (v5.47.0, F20)', () => {
  it('ST547-5: an adult word in the name (bestnaked) and a term of the company\'s forbidden list are refused before scoring; a retired term and a word that only contains letters of one are fine', async () => {
    await live('bestnaked.com');
    await live('brightwidgets.com');
    await live('freshplanet.com');
    await live('bluecoffee.com');
    await live('smartessex.com'); // "sex" inside "essex" is not an adult word
    const t = await db.insertInto('forbidden_terms').values([{ term: 'planet', created_by: 'test' }, { term: 'coffee', created_by: 'test' }]).returning(['id', 'term']).execute();
    await db.insertInto('forbidden_term_retirements').values({ term_id: t.find((x) => x.term === 'coffee')!.id, by: 'test', audit_id: null }).execute();
    const r = await runStep() as Record<string, any>;
    const names = (await shortlist()).map((x) => x.domain).sort();
    expect(names).toEqual(['bluecoffee.com', 'brightwidgets.com', 'smartessex.com']);
    expect(r.dropped.name_rules).toMatchObject({ ADULT_TERM: 1, FORBIDDEN_TERM: 1 });
  });
});

describe('LF547 shortlist with the lift table (auction-v3)', () => {
  it('LF547-11: with a stored lift table the name part comes from the lift (auction-v3, parts.name.lift, a reason line); without one the v2 score is unchanged', async () => {
    await live('brightstudio.com', { price: 3000, bids: 9, age: 8 });
    await live('solidharborcoffeeplanet.com', { price: 3000, bids: 9, age: 8 });
    const v2 = await runStep() as Record<string, any>;
    expect(v2).toMatchObject({ score_version: 'auction-v2', lift_model: null });
    const rows2 = await shortlist();
    expect(rows2.every((x) => x.score_version === 'auction-v2')).toBe(true);
    const trained = await new LiftTrainJob({ db, now: () => NOW }).runOnce();
    expect(trained).toMatchObject({ trained: true, source: 'seed' });
    const v3 = await runStep() as Record<string, any>;
    expect(v3).toMatchObject({ score_version: 'auction-v3', lift_model: { source: 'seed' } });
    const rows3 = await shortlist();
    expect(rows3.map((x) => x.domain)).toEqual(['brightstudio.com', 'solidharborcoffeeplanet.com']); // the short two-word name still ranks above the long four-word one
    for (const x of rows3) {
      expect(x.score_version).toBe('auction-v3');
      const lift = (x.parts as any).name.lift;
      expect(lift.score).toBeGreaterThan(0); expect(lift.score).toBeLessThan(100);
      expect(lift.bins.map((b: any) => b.pattern)).toEqual(['length', 'words']); // no endings asked in this test: those patterns are skipped
      expect((x.reasons as string[]).some((l) => l.startsWith('lift '))).toBe(true);
    }
    expect((rows3[0]!.parts as any).name.lift.score).toBeGreaterThan((rows3[1]!.parts as any).name.lift.score);
    app = await makeApp({ now: () => NOW });
    const auth = (await issueToken('read')).auth;
    const j = (await app.inject({ method: 'GET', url: '/auctions/shortlist', headers: auth })).json();
    expect(j.settings.score_version).toBe('auction-v3');
    expect(j.rows[0].score_version).toBe('auction-v3');
  });
});
