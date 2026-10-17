// v5.11.0 (CR-062): NameBio from the free endpoints only, with attribution. NB-1..NB-14. MSW only: no request ever leaves the machine.
import { readFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../../../src/config.js';
import {
  NameBioRateLimited, NameBioRequestRefused, fetchDropOrderFile, parseDropOrderFile, assertNameBioRequest, namebioPost, refreshNameBio, verisignDropOrder, parseRetailStatsCsv, keywordCounts,
} from '../../../src/modules/selection/namebio.js';
import { DEFAULT_SELECTION_VALUES } from '../../../src/modules/selection/settings.js';
import type { ScreeningDeps } from '../../../src/modules/selection/types.js';
import { testDb as db } from '../../helpers/db.js';
import { testEnv } from '../../helpers/env.js';
import { patchActiveSettings, screeningHarness } from '../../helpers/screening.js';
import { mswServer } from '../../setup/network.js';

const sample = readFileSync(new URL('../../fixtures/screening/namebio/retailstats-sample.csv', import.meta.url), 'utf8');
const ON = { ...DEFAULT_SELECTION_VALUES, sources: { ...DEFAULT_SELECTION_VALUES.sources, namebio: true } };
const API = 'https://api.namebio.com';
const RS_CSV = 'https://api.namebio.com/retailstats-download';
const TLD_CSV = 'https://api.namebio.com/tldstats-download';
const DROP = 'https://api.namebio.com/verisign-download';
let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

const answer = (n: number) => ({ exact: { sale_count: n, price_sum: n * 1000, price_avg: 1000, price_max: 5000, price_stddev: 12.5 }, start: { sale_count: n + 1, price_sum: 1, price_avg: 2, price_max: 3, price_stddev: 4 }, end: { sale_count: n + 2, price_sum: 1, price_avg: 2, price_max: 3, price_stddev: 4 }, middle: { sale_count: n + 3, price_sum: 1, price_avg: 2, price_max: 3, price_stddev: 4 } });

/** A fake clock: sleeping advances it. */
function clock(t0 = Date.parse('2026-10-17T08:00:00Z')) {
  const c = { t: t0, sleeps: [] as number[] };
  return { c, now: () => c.t, sleep: async (ms: number) => { c.sleeps.push(ms); c.t += ms; } };
}
const depsOf = (k: ReturnType<typeof clock>, namebio?: ScreeningDeps['namebio']): ScreeningDeps => ({ fetch: globalThis.fetch, sleep: k.sleep, ...(namebio && { namebio }) } as ScreeningDeps);
const intake = (domain: string, words: string[] | null = null) => db.insertInto('candidate_intake').values({ domain, lane: 'S3', source: 'test', token_name: 'scout', status: 'queued', ...(words && { words }) }).execute();
const hits = { rs: [] as string[], other: 0 };
function serveRetail(handler?: (kw: string, n: number) => Response | null) {
  hits.rs = [];
  mswServer.use(http.post(`${API}/retailstats`, async ({ request }) => {
    const kw = ((await request.json()) as { keyword: string }).keyword;
    hits.rs.push(kw);
    return handler?.(kw, hits.rs.length) ?? HttpResponse.json(answer(hits.rs.length));
  }));
}

describe('NameBio free endpoints (CR-062)', () => {
  it('NB-1 allow-list: only POST api.namebio.com /retailstats /tldstats /verisign, and https namebio.com files; any other path or host is refused before sending', async () => {
    for (const p of ['/retailstats', '/tldstats', '/verisign']) expect(assertNameBioRequest(`${API}${p}`, 'POST').pathname).toBe(p);
    for (const p of ['comps', 'checkdomain', 'dailysales', 'topsales', 'keywordstats', 'search']) {
      expect(() => assertNameBioRequest(`${API}/${p}`, 'POST')).toThrow(NameBioRequestRefused);
    }
    expect(() => assertNameBioRequest(`${API}/retailstats`, 'GET')).toThrow(NameBioRequestRefused);
    expect(() => assertNameBioRequest(`${API}/retailstats-download`, 'POST')).toThrow(NameBioRequestRefused);
    expect(() => assertNameBioRequest(`${API}/comps-download`, 'GET')).toThrow(NameBioRequestRefused);
    for (const p of ['retailstats-download', 'tldstats-download', 'verisign-download']) expect(assertNameBioRequest(`${API}/${p}`, 'GET').pathname).toBe(`/${p}`);
    expect(() => assertNameBioRequest(`${API}/retailstats?x=1`, 'POST')).toThrow(NameBioRequestRefused);
    expect(() => assertNameBioRequest('http://api.namebio.com/retailstats', 'POST')).toThrow(NameBioRequestRefused);
    expect(() => assertNameBioRequest('https://evil.example/retailstats', 'POST')).toThrow(NameBioRequestRefused);
    expect(() => assertNameBioRequest('https://namebio.com.evil.example/x.csv', 'GET')).toThrow(NameBioRequestRefused);
    expect(() => assertNameBioRequest('https://namebio.com/x.csv', 'POST')).toThrow(NameBioRequestRefused);
    expect(assertNameBioRequest('https://namebio.com/files/x.csv', 'GET').hostname).toBe('namebio.com');
    // namebioPost with a paid path throws without a request (no MSW handler: an unhandled request would fail the test differently)
    const k = clock();
    await expect(namebioPost(db, { fetch: globalThis.fetch, ...k }, 'comps' as never, {})).rejects.toThrow(NameBioRequestRefused);
    expect(await db.selectFrom('namebio_calls').select('id').execute()).toHaveLength(0);
  });

  it('NB-2 AC-1: per-keyword fetch stores source, source_url and fetched_at; GET returns placement stats with attribution; nothing in engine_sales', async () => {
    const k = clock();
    serveRetail();
    await intake('cloudhosting.com', ['cloud', 'hosting']);
    const r = await refreshNameBio(db, depsOf(k), ON, k.now);
    expect(r).toMatchObject({ mode: 'api', rows_written: 2, requests: 2, errors: [] });
    expect(hits.rs.sort()).toEqual(['cloud', 'hosting']);
    const row = await db.selectFrom('namebio_keyword_stats').selectAll().where('keyword', '=', 'cloud').executeTakeFirstOrThrow();
    expect(row).toMatchObject({ source: 'namebio_free', source_url: `${API}/retailstats` });
    expect(row.fetched_at.getTime()).toBe(k.c.t);
    expect(await db.selectFrom('engine_sales').select('id').execute()).toHaveLength(0);

    const x = await screeningHarness({ start: k.c.t });
    app = x.app;
    await patchActiveSettings(['sources', 'namebio'], true);
    const g = await x.get('/selection/namebio?keywords=cloud,hosting,nothere');
    expect(g.statusCode).toBe(200);
    const body = g.json();
    expect(body).toMatchObject({ source: 'namebio_free', attribution: 'Data from NameBio', attribution_url: 'https://namebio.com', stale: false, data_as_of: '2026-10-17' });
    expect(body.keywords.nothere).toBeNull();
    expect(body.keywords.cloud).toMatchObject({ exact_count: 1, start_count: 2, end_count: 3, middle_count: 4, placements: { exact: { sale_count: 1, price_sum: 1000, price_avg: 1000, price_max: 5000, price_stddev: 12.5 } } });
  });

  it('NB-3 AC-3: older than namebio.max_cache_age_hours -> stale true', async () => {
    const k = clock();
    serveRetail();
    await intake('cloudhosting.com', ['cloud', 'hosting']);
    await refreshNameBio(db, depsOf(k), ON, k.now);
    const x = await screeningHarness({ start: k.c.t + 47 * 3_600_000 });
    app = x.app;
    await patchActiveSettings(['sources', 'namebio'], true);
    expect((await x.get('/selection/namebio?keywords=cloud')).json()).toMatchObject({ stale: false });
    x.clock.t = k.c.t + 49 * 3_600_000;
    expect((await x.get('/selection/namebio?keywords=cloud')).json()).toMatchObject({ stale: true, status: 'UNKNOWN', reason_code: 'STALE_DATA', attribution: 'Data from NameBio', source: 'namebio_free' });
  });

  it('NB-4 rate limit: retailstats at most 4 a minute, sequential; the count survives a restart (persisted)', async () => {
    const k = clock();
    serveRetail();
    for (let i = 0; i < 6; i++) await intake(`word${i}.com`, [`word${i}`]);
    const r = await refreshNameBio(db, depsOf(k), ON, k.now);
    expect(r).toMatchObject({ requests: 6, rows_written: 6, errors: [] });
    expect(k.c.sleeps.length).toBeGreaterThanOrEqual(1); // waited for the minute window before the 5th call
    const calls = (await db.selectFrom('namebio_calls').select('called_at').orderBy('called_at').execute()).map((c) => c.called_at.getTime());
    expect(calls).toHaveLength(6);
    for (let i = 4; i < 6; i++) expect(calls[i]! - calls[i - 4]!).toBeGreaterThanOrEqual(60_000); // never 5 inside any 60 s
    // "restart": a fresh clock object at the same time still sees the persisted calls
    await db.deleteFrom('namebio_keyword_stats').execute();
    const k2 = clock(k.c.t);
    await refreshNameBio(db, depsOf(k2), ON, k2.now);
    expect(k2.c.sleeps.length).toBeGreaterThanOrEqual(1);
  });

  it('NB-5 HTTP 429: wait 60 s, retry once; a second 429 is a rate-limit error that stops the step', async () => {
    const k = clock();
    serveRetail((kw, n) => (n === 1 ? new Response('slow down', { status: 429 }) : null));
    await intake('alpha.com', ['alpha']);
    const ok = await refreshNameBio(db, depsOf(k), ON, k.now);
    expect(ok).toMatchObject({ rows_written: 1, errors: [] });
    expect(k.c.sleeps).toContain(60_000);
    expect(hits.rs).toEqual(['alpha', 'alpha']);

    await db.deleteFrom('namebio_keyword_stats').execute();
    const k2 = clock(k.c.t + 3_600_000);
    serveRetail(() => new Response('slow down', { status: 429 }));
    const bad = await refreshNameBio(db, depsOf(k2), ON, k2.now);
    expect(bad).toMatchObject({ rows_written: 0 });
    expect((bad as { errors: string[] }).errors[0]).toMatch(/alpha: .*rate limit/i);
    expect(hits.rs).toEqual(['alpha', 'alpha']); // one retry only
  });

  it('NB-6 a rate-limit error body (HTTP 200) is treated like a 429', async () => {
    const k = clock();
    serveRetail((kw, n) => (n === 1 ? HttpResponse.json({ error: 'Rate limit exceeded' }) : null));
    await intake('beta.com', ['beta']);
    const r = await refreshNameBio(db, depsOf(k), ON, k.now);
    expect(r).toMatchObject({ rows_written: 1 });
    expect(k.c.sleeps).toContain(60_000);
  });

  it('NB-7 verisign: at most 100 domains a call and 5 calls per 24 h (persisted)', async () => {
    const k = clock();
    let n = 0;
    mswServer.use(http.post(`${API}/verisign`, () => { n++; return HttpResponse.json({ ok: true }); }));
    const d = { fetch: globalThis.fetch, ...k };
    await expect(verisignDropOrder(db, d, [])).rejects.toThrow(NameBioRequestRefused);
    await expect(verisignDropOrder(db, d, Array.from({ length: 101 }, (_, i) => `a${i}.com`))).rejects.toThrow(NameBioRequestRefused);
    for (let i = 0; i < 5; i++) await verisignDropOrder(db, d, ['a.com']);
    await expect(verisignDropOrder(db, d, ['a.com'])).rejects.toThrow(NameBioRateLimited);
    expect(n).toBe(5);
    k.c.t += 24 * 3_600_000 + 1000;
    await verisignDropOrder(db, d, ['a.com']);
    expect(n).toBe(6);
  });

  it('NB-8 CSV path: with the URL set the step downloads the file and upserts; no per-keyword request; once a day; logs file bytes and rows', async () => {
    const k = clock();
    let downloads = 0;
    mswServer.use(http.get(RS_CSV, () => { downloads++; return new HttpResponse(sample, { headers: { 'content-type': 'text/csv' } }); }));
    serveRetail();
    await intake('plumbing.com', ['plumbing']);
    const r = await refreshNameBio(db, depsOf(k, { retailstatsCsvUrl: RS_CSV }), ON, k.now);
    expect(r).toMatchObject({ mode: 'csv', rows_written: 5, file_bytes: Buffer.byteLength(sample), requests: 1, errors: [] });
    expect(downloads).toBe(1);
    expect(hits.rs).toEqual([]);
    const row = await db.selectFrom('namebio_keyword_stats').selectAll().where('keyword', '=', 'plumbing').executeTakeFirstOrThrow();
    expect(row).toMatchObject({ source: 'namebio_free', source_url: RS_CSV });
    k.c.t += 3_600_000;
    expect(await refreshNameBio(db, depsOf(k, { retailstatsCsvUrl: RS_CSV }), ON, k.now)).toMatchObject({ rows_written: 0, requests: 0 });
    expect(downloads).toBe(1);
    k.c.t += 24 * 3_600_000;
    await refreshNameBio(db, depsOf(k, { retailstatsCsvUrl: RS_CSV }), ON, k.now);
    expect(downloads).toBe(2);
    expect(await db.selectFrom('engine_sales').select('id').execute()).toHaveLength(0);
  });

  it('NB-9 TLDStats CSV is stored in namebio_tld_stats', async () => {
    const k = clock();
    mswServer.use(http.get(TLD_CSV, () => new HttpResponse('tld,sale_count,price_avg\ncom,1200,3400\n.net,300,900\n')));
    const r = await refreshNameBio(db, depsOf(k, { tldstatsCsvUrl: TLD_CSV }), ON, k.now);
    expect(r).toMatchObject({ mode: 'csv', rows_written: 2 });
    const rows = await db.selectFrom('namebio_tld_stats').selectAll().orderBy('tld').execute();
    expect(rows.map((x) => x.tld)).toEqual(['com', 'net']);
    expect(rows[0]).toMatchObject({ source: 'namebio_free', source_url: TLD_CSV, stats: { sale_count: 1200, price_avg: 3400 } });
  });

  it('NB-10 a CSV URL outside namebio.com is refused before any request (config and module); a changed CSV header stops the refresh', async () => {
    expect(() => loadConfig(testEnv({ NAMEBIO_RETAILSTATS_CSV_URL: 'https://evil.example/x.csv' }))).toThrow(/NAMEBIO_RETAILSTATS_CSV_URL/);
    expect(() => loadConfig(testEnv({ NAMEBIO_TLDSTATS_CSV_URL: 'https://api.namebio.com/comps' }))).toThrow(/NAMEBIO_TLDSTATS_CSV_URL/);
    expect(loadConfig(testEnv({ NAMEBIO_RETAILSTATS_CSV_URL: RS_CSV })).namebio).toEqual({ retailstatsCsvUrl: RS_CSV, tldstatsCsvUrl: undefined, dropOrderUrl: undefined });
    expect(loadConfig(testEnv()).namebio).toEqual({ retailstatsCsvUrl: undefined, tldstatsCsvUrl: undefined, dropOrderUrl: undefined });
    expect(loadConfig(testEnv({ NAMEBIO_DROP_ORDER_URL: DROP })).namebio.dropOrderUrl).toBe(DROP);
    expect(() => loadConfig(testEnv({ NAMEBIO_DROP_ORDER_URL: 'https://api.namebio.com/dailysales' }))).toThrow(/NAMEBIO_DROP_ORDER_URL/);
    const k = clock();
    const r = await refreshNameBio(db, depsOf(k, { retailstatsCsvUrl: 'https://evil.example/x.csv' }), ON, k.now);
    expect((r as { errors: string[] }).errors[0]).toMatch(/refused/);
    mswServer.use(http.get(RS_CSV, () => new HttpResponse('word,count\nplumbing,3\n')));
    const r2 = await refreshNameBio(db, depsOf(k, { retailstatsCsvUrl: RS_CSV }), ON, k.now);
    expect((r2 as { errors: string[] }).errors[0]).toMatch(/header/);
    expect(() => parseRetailStatsCsv('')).toThrow(/header/);
    expect(await db.selectFrom('namebio_keyword_stats').select('keyword').execute()).toHaveLength(0);
  });

  it('NB-11 AC-5: sources.namebio false -> nothing is fetched, the step is skipped, GET says SOURCE_DISABLED with attribution', async () => {
    const k = clock();
    mswServer.use(http.all(/namebio\.com/, () => { hits.other++; return new HttpResponse('x'); }));
    hits.other = 0;
    await intake('cloudhosting.com', ['cloud']);
    expect(await refreshNameBio(db, depsOf(k, { retailstatsCsvUrl: RS_CSV }), DEFAULT_SELECTION_VALUES, k.now)).toEqual({ skipped: true, reason: 'SOURCE_DISABLED' });
    expect(hits.other).toBe(0);
    const x = await screeningHarness();
    app = x.app;
    expect((await x.get('/selection/namebio?keywords=cloud')).json()).toMatchObject({ status: 'UNKNOWN', reason_code: 'SOURCE_DISABLED', source: 'namebio_free', attribution: 'Data from NameBio', attribution_url: 'https://namebio.com' });
  });

  it('NB-12 AC-4 / R-7: the summary carries db bytes before and after, rows written and file bytes', async () => {
    const k = clock();
    mswServer.use(http.get(RS_CSV, () => new HttpResponse(sample)));
    const r = await refreshNameBio(db, depsOf(k, { retailstatsCsvUrl: RS_CSV }), ON, k.now) as { db_bytes_before: number; db_bytes_after: number; rows_written: number; file_bytes: number };
    expect(r.db_bytes_before).toBeGreaterThan(0);
    expect(r.db_bytes_after).toBeGreaterThanOrEqual(r.db_bytes_before);
    expect(r).toMatchObject({ rows_written: 5, file_bytes: sample.length });
  });

  it('NB-13 the daily job step reports the NameBio summary in its details', async () => {
    const { makeApp } = await import('../../helpers/app.js');
    const k = clock();
    mswServer.use(http.get('https://data.iana.org/rdap/dns.json', () => HttpResponse.json({ services: [[['com'], ['https://rdap.verisign.com/com/v1/']]] })));
    app = await makeApp({ now: () => k.c.t, adapters: [] });
    await patchActiveSettings(['sources', 'namebio'], true);
    await patchActiveSettings(['sources', 'popularity'], false);
    const run = await app.jobRunner.run('daily');
    expect(run.steps.referenceRefresh!.summary).toMatchObject({ namebio: { mode: 'api', rows_written: 0, requests: 0, errors: [] } });
    expect((run.steps.referenceRefresh!.summary as { namebio: { db_bytes_before: number } }).namebio.db_bytes_before).toBeGreaterThan(0);
  });

  it('NB-14 keywordCounts with an empty store is stale with every stat null; an old row is stale', async () => {
    const k = clock();
    expect(await keywordCounts(db, ['cloud'], ON, k.now)).toMatchObject({ cache_date: null, stale: true, stats: { cloud: null }, source: 'namebio_free' });
    await db.insertInto('namebio_keyword_stats').values({ keyword: 'cloud', placements: JSON.stringify({ exact: { sale_count: 2, price_sum: null, price_avg: null, price_max: null, price_stddev: null } }), source: 'namebio_free', source_url: 'u', fetched_at: new Date(k.c.t - 72 * 3_600_000) } as never).execute();
    const r = await keywordCounts(db, ['cloud'], ON, k.now);
    expect(r).toMatchObject({ stale: true, cache_date: '2026-10-14', stats: { cloud: { exact_count: 2, start_count: null } } });
  });

  it('NB-15 drop-order file: parsed defensively; fetched at most once a day', async () => {
    const k = clock();
    let n = 0;
    mswServer.use(http.get(DROP, () => { n++; return new HttpResponse('# header\r\nExample.com\nfoo-bar.com, 2026-10-20\n\nnot a domain\nbaz.net.\nexample.com\n', { headers: { 'content-type': 'text/plain' } }); }));
    expect(parseDropOrderFile('a.com\n\n???\nb.org\tx')).toEqual(['a.com', 'b.org']);
    const d = { fetch: globalThis.fetch, ...k };
    expect(await fetchDropOrderFile(db, d, DROP)).toEqual(['example.com', 'foo-bar.com', 'baz.net']);
    await expect(fetchDropOrderFile(db, d, DROP)).rejects.toThrow(NameBioRateLimited);
    expect(n).toBe(1);
    k.c.t += 25 * 3_600_000;
    await fetchDropOrderFile(db, d, DROP);
    expect(n).toBe(2);
    await expect(fetchDropOrderFile(db, d, 'https://api.namebio.com/dailysales')).rejects.toThrow(NameBioRequestRefused);
  });
});
