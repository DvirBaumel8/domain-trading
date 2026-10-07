// v2.7.0 (CR-010): provenance (T10-4), date safety (T10-5), 4-at-a-time adaptive RDAP for test sets (T10-7), reuse without pacing or per-sibling queries.
import { http } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RdapLookup, RdapLookupFn } from '../../src/rdap.js';
import { HOST_BREAKER_REFUSALS, Pacer, TEST_SET_RDAP_CONCURRENCY, TEST_SET_RDAP_MIN_MS, lookupCached, pacerFor, prefetchStored } from '../../src/screening/rdap-batch.js';
import { siblingsBt1 } from '../../src/screening/siblings.js';
import type { ScreeningDeps } from '../../src/screening/types.js';
import { testDb as db } from '../helpers/db.js';
import { screeningHarness, type ScreeningHarness } from '../helpers/screening.js';
import { fixture, respond } from '../helpers/screening-fixtures.js';
import { mswServer } from '../setup/network.js';

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());

const facts = (created: string | null) => ({ registrar: 'Fake Registrar', created_at: created, expires_at: null, updated_at: null, statuses: [], nameservers: [] });
const registered = (created: string | null): RdapLookup => ({ outcome: 'registered', reasonCode: null, httpStatus: 200, url: 'https://rdap.example/domain/x', retrievedAt: new Date(), body: '{"ldhName":"x"}', facts: facts(created) });
const notRegistered = (): RdapLookup => ({ outcome: 'not_registered', reasonCode: null, httpStatus: 404, url: 'https://rdap.example/domain/x', retrievedAt: new Date(), body: null, facts: null });
const limited = (retryAfterMs: number | null = null): RdapLookup => ({ outcome: 'unknown', reasonCode: 'RATE_LIMITED', httpStatus: 429, url: 'https://rdap.example/domain/x', retrievedAt: new Date(), body: null, facts: null, retryAfterMs });
const sibs = (tokens: string[]) => siblingsBt1(tokens).map((l) => `${l}.com`);
const SIBS = sibs(['super', 'pro']);

function counting(): { fn: RdapLookupFn; calls: string[] } {
  const calls: string[] = [];
  return { calls, fn: async (d) => { calls.push(d); return notRegistered(); } };
}
async function h(rdapLookup: RdapLookupFn): Promise<ScreeningHarness> {
  mswServer.use(http.get('https://data.iana.org/rdap/dns.json', () => respond(fixture('iana-dns.json'))));
  const x = await screeningHarness({ screening: { rdapLookup } });
  app = x.app;
  return x;
}
const FEAT = { registered_share: 0.9, alt_tld_before_n: 0, prior_history: 1, n_words: 2, sld_chars: 8, is_geo: 0 };
const reg = (domain: string, asOf = '2024-06-01') => ({ domain, role: 'fit', label: 'sold', source: 'old', slice: 'R', as_of: asOf, features: FEAT });
async function seed(domains: string[], checkedAt: string): Promise<void> {
  await db.insertInto('rdap_lookups').values(domains.map((domain) => ({ domain, outcome: 'not_registered', reason_code: null, http_status: 404, facts: null, evidence_id: null, checked_at: new Date(checkedAt) }))).execute();
}
async function rescore(x: ScreeningHarness, name: string, extra: object = {}): Promise<string> {
  const r = await x.post('/selection/test-sets', { name, purpose: 'rescore', sibling_method: 'bt1@v1', slices: ['R'], ...extra });
  expect(r.statusCode, r.body).toBe(202);
  await app!.screeningWorker.runToEnd(r.json().run_id);
  return r.json().run_id as string;
}
const censusFields = async (runId: string) => (await db.selectFrom('screening_results').select('fields').where('run_id', '=', runId).where('check_id', '=', 'census').executeTakeFirstOrThrow()).fields as any;
const sibCalls = (c: string[]) => c.filter((d) => SIBS.includes(d));

describe('provenance and date safety (CR-010 T10-4, T10-5)', () => {
  it('V27-1 siblings carry checked_at and reused; a second set within the age limit reuses all 20 with 0 registry calls; GET shows lookups and timing', async () => {
    const rdap = counting();
    const x = await h(rdap.fn);
    await x.post('/selection/labelled-names', { rows: [reg('superpro.com')] });
    const first = await rescore(x, 'RS-A');
    expect(sibCalls(rdap.calls)).toHaveLength(20);
    const f1 = await censusFields(first);
    expect(f1.siblings.every((s: any) => s.reused === false && !Number.isNaN(Date.parse(s.checked_at)))).toBe(true);
    const before = rdap.calls.length;
    const second = await rescore(x, 'RS-B');
    expect(rdap.calls.length).toBe(before); // fully stored census: nothing asked
    const f2 = await censusFields(second);
    expect(f2.siblings.every((s: any) => s.reused === true)).toBe(true);
    expect(f2.siblings[0].checked_at).toBe(f1.siblings[0].checked_at);
    const got = (await x.get('/selection/test-sets/RS-B')).json();
    expect(got).toMatchObject({ max_answer_age_days: 7, lookups: { fresh: 0, rate_limited: 0 } }); // census 20 + ext_dates reused; ext extensions with no registry stay unknown
    expect(got.lookups.reused).toBeGreaterThanOrEqual(20);
    expect(got.timing.started_at).toMatch(/[+-]\d\d:\d\d$/);
    expect(got.timing.finished_at).toMatch(/[+-]\d\d:\d\d$/);
    expect(typeof got.timing.minutes).toBe('number');
    const a = (await x.get('/selection/test-sets/RS-A')).json();
    expect(a.lookups.fresh).toBeGreaterThanOrEqual(20);
    expect(a.lookups.reused).toBe(0);
  });

  it('V27-2 an answer read before the item as_of is not reused; one read after it (within the age) is', async () => {
    const rdap = counting();
    const x = await h(rdap.fn);
    await x.post('/selection/labelled-names', { rows: [reg('superpro.com', '2026-09-20')] });
    await seed(SIBS, '2026-09-10T00:00:00Z'); // before as_of 2026-09-20, within 30 days of the harness clock (2026-10-06)
    const early = await rescore(x, 'RS-EARLY', { max_answer_age_days: 30 });
    expect(sibCalls(rdap.calls)).toHaveLength(20);
    expect((await censusFields(early)).siblings.every((s: any) => s.reused === false)).toBe(true);
    await db.deleteFrom('rdap_lookups').execute();
    rdap.calls.length = 0;
    await seed(SIBS, '2026-09-25T00:00:00Z');
    const late = await rescore(x, 'RS-LATE', { max_answer_age_days: 30 });
    expect(sibCalls(rdap.calls)).toHaveLength(0);
    expect((await censusFields(late)).siblings.every((s: any) => s.reused === true && s.checked_at === '2026-09-25T00:00:00.000Z')).toBe(true);
  });

  it('V27-3 features_as_of now reuses answers within max_answer_age_days only; 0 never reuses; older than the limit is asked again', async () => {
    const rdap = counting();
    const x = await h(rdap.fn);
    await x.post('/selection/labelled-names', { rows: [reg('superpro.com')] });
    await seed(SIBS, '2026-10-01T00:00:00Z'); // 5 days before the harness clock
    const now7 = await rescore(x, 'RS-N7', { features_as_of: 'now' });
    expect(sibCalls(rdap.calls)).toHaveLength(0);
    expect((await censusFields(now7)).siblings.every((s: any) => s.reused === true)).toBe(true);
    const now3 = await rescore(x, 'RS-N3', { features_as_of: 'now', max_answer_age_days: 3 });
    expect(sibCalls(rdap.calls)).toHaveLength(20);
    expect((await censusFields(now3)).siblings.every((s: any) => s.reused === false)).toBe(true);
    rdap.calls.length = 0;
    const now0 = await rescore(x, 'RS-N0', { features_as_of: 'now', max_answer_age_days: 0 });
    expect(sibCalls(rdap.calls)).toHaveLength(20);
    expect((await censusFields(now0)).siblings.every((s: any) => s.reused === false)).toBe(true);
  });

  it('V27-4 max_answer_age_days is validated (integer 0..30), stored and shown; sets without it read 7; POST /screening/runs refuses the internal flags', async () => {
    const x = await h(counting().fn);
    await x.post('/selection/labelled-names', { rows: [reg('superpro.com')] });
    for (const bad of [-1, 31, 1.5, '7']) {
      const r = await x.post('/selection/test-sets', { name: 'RS-BAD', purpose: 'rescore', slices: ['R'], max_answer_age_days: bad });
      expect([r.statusCode, r.json().error.code]).toEqual([422, 'VALIDATION_ERROR']);
    }
    await rescore(x, 'RS-D'); // default
    await rescore(x, 'RS-30', { max_answer_age_days: 30 });
    expect((await x.get('/selection/test-sets/RS-D')).json().max_answer_age_days).toBe(7);
    expect((await x.get('/selection/test-sets/RS-30')).json().max_answer_age_days).toBe(30);
    await db.updateTable('test_sets').set({ max_answer_age_days: null }).where('name', '=', 'RS-D').execute();
    expect((await x.get('/selection/test-sets/RS-D')).json().max_answer_age_days).toBe(7);
    const run = await x.post('/screening/runs', { mode: 'full', checks: ['census'], test_set: { max_answer_age_days: 0 }, names: [{ domain: 'superpro.com', lane: 'S3' }] });
    expect(run.statusCode).toBe(422);
  });

  it('V27-5 ext_dates entries carry checked_at and reused, and reuse follows the same rules', async () => {
    const rdap = counting();
    const x = await h(rdap.fn);
    await x.post('/selection/labelled-names', { rows: [reg('superpro.com')] });
    const a = await rescore(x, 'RS-X1');
    const b = await rescore(x, 'RS-X2');
    const ext = async (id: string) => (await db.selectFrom('screening_results').select('fields').where('run_id', '=', id).where('check_id', '=', 'ext_dates').executeTakeFirstOrThrow()).fields as any;
    const ea = await ext(a);
    const eb = await ext(b);
    const known = (e: any) => e.extensions.filter((r: any) => r.status !== 'unknown');
    expect(known(ea).length).toBeGreaterThan(0);
    expect(ea.extensions.every((r: any) => typeof r.checked_at === 'string' && typeof r.reused === 'boolean')).toBe(true);
    expect(known(ea).every((r: any) => r.reused === false)).toBe(true);
    expect(known(eb).every((r: any) => r.reused === true)).toBe(true);
  });
});

const deps = (rdap: RdapLookupFn, sleeps: number[] = []): ScreeningDeps => ({ rdapLookup: rdap, sleep: async (ms: number) => { sleeps.push(ms); } } as unknown as ScreeningDeps);
const opts = (pace: Pacer) => ({ maxAgeHours: 0, evidenceMaxBytes: 1000, pace });

describe('RDAP pacing for test-set runs (CR-010 T10-7)', () => {

  it('V27-6 test-set runs get a 4-at-a-time, 250 ms pacer; other runs keep the settings', () => {
    expect([TEST_SET_RDAP_CONCURRENCY, TEST_SET_RDAP_MIN_MS]).toEqual([4, 250]);
    const mk = (testSet?: object) => pacerFor({ shared: new Map(), run: { testSet }, settings: { run: { rdap_min_ms_between: 1000, rdap_concurrency: 1 } }, deps: { sleep: async () => {} } } as never);
    expect([mk({ maxAnswerAgeDays: 7, asOfIsNow: false }).maxConcurrency, mk({ maxAnswerAgeDays: 7, asOfIsNow: false }).minGapMs]).toEqual([4, 250]);
    expect([mk().maxConcurrency, mk().minGapMs]).toEqual([1, 1000]);
  });

  it('V27-7 at most 4 lookups are in flight, and starts are at least 250 ms apart', async () => {
    let inFlight = 0, max = 0;
    const starts: number[] = [];
    let t = 0;
    const waits: Promise<void>[] = [];
    const rdap: RdapLookupFn = async () => { inFlight++; max = Math.max(max, inFlight); starts.push(t); await new Promise((r) => setTimeout(r, 5)); inFlight--; return notRegistered(); };
    const sleeps: number[] = [];
    const pace = new Pacer(250, 4, async (ms: number) => { sleeps.push(ms); t += ms; }, () => t);
    await Promise.all(Array.from({ length: 12 }, (_, i) => lookupCached(db, deps(rdap), `p${i}pace.com`, opts(pace))));
    void waits;
    expect(max).toBeLessThanOrEqual(4);
    expect(max).toBeGreaterThan(1);
    const sorted = [...starts].sort((a, b) => a - b);
    // every start is at least the minimum gap after the one before it (the pacer's own clock)
    // the real pacing signal: all but the first lookup waited exactly one gap for its slot, so the shared clock moved 11 gaps in all
    // (the recorded start times share one fake clock that every waiter advances, so they are not compared one by one)
    expect(sleeps).toEqual(Array.from({ length: 11 }, () => 250));
    expect(t).toBe(11 * 250);
    expect(sorted[11]! - sorted[0]!).toBeGreaterThanOrEqual(11 * 250 - 1);
  });

  it('V27-8 a 429 halves the rate (gap doubles to the cap, one at a time after two), is counted, and a lookup that keeps failing stays UNKNOWN RATE_LIMITED, never not_registered', async () => {
    const pace = new Pacer(250, 4, async () => {});
    const rdap: RdapLookupFn = async () => limited(null);
    const a = await lookupCached(db, deps(rdap), 'slowa.com', opts(pace));
    expect(a).toMatchObject({ outcome: 'unknown', reasonCode: 'RATE_LIMITED', rateLimited: 1 });
    expect([pace.minGapMs, pace.maxConcurrency]).toEqual([500, 4]);
    const b = await lookupCached(db, deps(rdap), 'slowb.com', opts(pace));
    expect(b.outcome).toBe('unknown');
    expect([pace.minGapMs, pace.maxConcurrency]).toEqual([1000, 1]);
    for (let i = 0; i < 5; i++) await lookupCached(db, deps(rdap), `slow${i}x.com`, opts(pace));
    expect(pace.minGapMs).toBe(4000);
    expect(pace.slowdowns).toBe(5); // v2.11.1: the breaker opens at the 5th refusal in a row
    // Retry-After within 10 s is honoured: sleeps, retries, counts both
    const sleeps: number[] = [];
    let n = 0;
    const p2 = new Pacer(250, 4, async () => {});
    const r = await lookupCached(db, deps(async () => (++n === 1 ? limited(2000) : registered('2020-01-01T00:00:00Z')), sleeps), 'retryme.com', opts(p2));
    expect(r).toMatchObject({ outcome: 'registered', rateLimited: 1 });
    expect(sleeps).toContain(2000);
    expect(await db.selectFrom('rdap_lookups').select('outcome').where('domain', '=', 'slowa.com').execute()).toEqual([{ outcome: 'unknown' }]);
  });

  it('V27-9 lookups.rate_limited on GET counts the 429s of a run; the unknown siblings stay unknown', async () => {
    let n = 0;
    const x = await h(async (d) => (SIBS.includes(d) && n++ < 3 ? limited(null) : notRegistered()));
    await x.post('/selection/labelled-names', { rows: [reg('superpro.com')] });
    await rescore(x, 'RS-429');
    const got = (await x.get('/selection/test-sets/RS-429')).json();
    expect(got.lookups.rate_limited).toBe(3);
    expect(got.lookups.unknown).toBeGreaterThanOrEqual(3);
  });
});

describe('speed of reuse (CR-010)', () => {
  it('V27-10 a stored answer never goes through the pacer and a prefetched map makes no per-domain query', async () => {
    await seed(['one.com', 'two.com'], '2026-10-05T00:00:00Z');
    const now = () => Date.parse('2026-10-06T00:00:00Z');
    const stored = await prefetchStored(db, ['one.com', 'two.com', 'three.com'], { maxAgeHours: 48, now });
    expect([...stored.keys()].sort()).toEqual(['one.com', 'two.com']);
    let paced = 0;
    const pace = { run: async () => { paced++; throw new Error('must not be asked'); }, slowDown() {} } as unknown as Pacer;
    const rdap: RdapLookupFn = async () => { throw new Error('no registry call expected'); };
    const r = await lookupCached(db, { rdapLookup: rdap, sleep: async () => {} } as unknown as ScreeningDeps, 'one.com', { maxAgeHours: 48, evidenceMaxBytes: 1000, pace, now, prefetched: stored });
    expect(r).toMatchObject({ outcome: 'not_registered', cached: true, rateLimited: 0 });
    expect(paced).toBe(0);
    // notBefore later than the stored answer: not reusable
    expect((await prefetchStored(db, ['one.com'], { maxAgeHours: 48, notBefore: new Date('2026-10-05T12:00:00Z'), now })).size).toBe(0);
    // an unknown row is never an answer
    await db.insertInto('rdap_lookups').values({ domain: 'four.com', outcome: 'unknown', reason_code: 'TIMEOUT', http_status: null, facts: null, evidence_id: null, checked_at: new Date('2026-10-05T00:00:00Z') }).execute();
    expect((await prefetchStored(db, ['four.com'], { maxAgeHours: 48, now })).size).toBe(0);
    expect((await prefetchStored(db, ['one.com'], { maxAgeHours: 0, now })).size).toBe(0);
  });
});

describe('per-host circuit breaker (v2.11.1, CR-010)', () => {
  it('V2111-1 a host that refuses 5 times in a row is not asked again: UNKNOWN RATE_LIMITED at once, counted, no row; another host is unaffected', async () => {
    expect(HOST_BREAKER_REFUSALS).toBe(5);
    let biz = 0, com = 0;
    const bizPace = new Pacer(250, 4, async () => {});
    const comPace = new Pacer(250, 4, async () => {});
    const bizRdap: RdapLookupFn = async () => { biz++; return limited(null); };
    const comRdap: RdapLookupFn = async () => { com++; return notRegistered(); };
    const out = [];
    for (let i = 0; i < 8; i++) out.push(await lookupCached(db, deps(bizRdap), `brk${i}x.biz`, opts(bizPace)));
    expect(biz).toBe(5);
    for (const r of out) expect(r).toMatchObject({ outcome: 'unknown', reasonCode: 'RATE_LIMITED', rateLimited: 1 });
    expect(out.slice(5).every((r) => r.httpStatus === null && r.evidenceId === null)).toBe(true);
    expect(await db.selectFrom('rdap_lookups').select('domain').where('domain', 'like', 'brk%x.biz').execute()).toHaveLength(5);
    const c = await lookupCached(db, deps(comRdap), 'brkcom.com', opts(comPace));
    expect(c.outcome).toBe('not_registered');
    expect(com).toBe(1);
  });

  it('V2111-2 refusals queued before the breaker opens do not call the host either', async () => {
    let calls = 0;
    const pace = new Pacer(250, 1, async () => {});
    const rdap: RdapLookupFn = async () => { calls++; await new Promise((r) => setTimeout(r, 2)); return limited(null); };
    const res = await Promise.all(Array.from({ length: 9 }, (_, i) => lookupCached(db, deps(rdap), `q${i}brk.biz`, opts(pace))));
    expect(calls).toBe(5);
    for (const r of res) expect(r).toMatchObject({ outcome: 'unknown', reasonCode: 'RATE_LIMITED' });
  });

  it('V2111-3 an answer between refusals resets the streak: only 5 consecutive refusals open the breaker', async () => {
    const pace = new Pacer(250, 4, async () => {});
    let n = 0;
    const rdap: RdapLookupFn = async () => (++n % 3 === 0 ? notRegistered() : limited(null));
    for (let i = 0; i < 12; i++) await lookupCached(db, deps(rdap), `rs${i}x.biz`, opts(pace));
    expect(n).toBe(12);
    expect(pace.breakerOpen).toBe(false);
  });
});

