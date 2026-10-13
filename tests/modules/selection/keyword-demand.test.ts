// v4.2.0 (CR-044 item 3): POST/GET /demand/keywords and the `demand` screening input. (CR-046 item 2): the `companies` screening input (Companies House).
// Companies House is an MSW handler; nothing touches the network.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { delay, http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { testDb as db } from '../../helpers/db.js';
import { patchActiveSettings, screeningHarness, type ScreeningHarness } from '../../helpers/screening.js';
import { issueToken } from '../../helpers/tokens.js';
import { mswServer } from '../../setup/network.js';
import { demandCheck } from '../../../src/modules/selection/checks/demand.js';
import { DEFAULT_SELECTION_VALUES } from '../../../src/modules/selection/settings.js';

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());

const real = readFileSync(new URL('../../fixtures/keywords/keyword-planner-stats-2026-10-13.csv', import.meta.url));
const b64 = (b: Buffer) => b.toString('base64');
const utf16 = (s: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);
const HEAD = ['Keyword', 'Currency', 'Segmentation', 'Avg. monthly searches', 'Three month change', 'YoY change', 'Competition', 'Competition (indexed value)'].join('\t');
const sheet = (...rows: string[]) => ['Keyword Stats', '1 Sep 2025 - 31 Aug 2026', HEAD, ...rows].join('\n');
const row = (kw: string, avg: string, comp = '40') => [kw, 'USD', '', avg, '1%', '2%', 'x', comp].join('\t');

async function h(over: Record<string, unknown> = {}): Promise<ScreeningHarness> {
  const x = await screeningHarness({ screening: { sleep: async () => {}, siteFetch: ((i: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => globalThis.fetch(i, init)) as typeof fetch, ...over } });
  app = x.app;
  return x;
}
const resultOf = (body: any, check: string, i = 0) => body.names[i].results.find((r: any) => r.check === check);

describe('POST/GET /demand/keywords', () => {
  it('KD-1 the real export is stored (10 keywords, 2 segmentation rows skipped), is audited, and GET reads the values back', async () => {
    const x = await h();
    const res = await x.post('/demand/keywords', { file_base64: b64(real), location: 'United States', month: '2026-10' });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ rows: 10, skipped: 2, date_range_line: '1 בספטמבר 2025 - 31 באוגוסט 2026', upload_id: expect.any(Number), audit_id: expect.any(String) });
    expect(await db.selectFrom('keyword_demand').select('id').execute()).toHaveLength(10);
    expect(await db.selectFrom('keyword_demand_uploads').select(['location', 'month', 'rows_n', 'skipped_n']).execute()).toEqual([{ location: 'United States', month: '2026-10', rows_n: 10, skipped_n: 2 }]);
    const g = await x.get('/demand/keywords?keyword=CBAM%20Compliance');
    expect(g.statusCode, g.body).toBe(200);
    expect(g.json()).toMatchObject({ keyword: 'cbam compliance', avg_monthly_searches: 50, competition_index: 47, three_month_change: '0%', yoy_change: '0%', location: 'United States', month: '2026-10' });
    expect(g.json().uploaded_at).toMatch(/[+-]\d{2}:\d{2}$/);
    const unmeasured = await x.get('/demand/keywords?keyword=ets2%20compliance');
    expect(unmeasured.json()).toMatchObject({ keyword: 'ets2 compliance', avg_monthly_searches: null, competition_index: null });
    const audit = await db.selectFrom('audit_log').select(['path', 'request']).where('path', '=', '/demand/keywords').execute();
    expect(audit).toHaveLength(1);
    const logged = JSON.stringify(audit[0]!.request);
    expect(logged).not.toContain(b64(real).slice(0, 60)); // the bytes are not copied into the audit log
    expect(logged).toContain('characters]');
  });

  it('KD-2 a missing required header is 422 KEYWORD_CSV_INVALID with the header names, and nothing is stored', async () => {
    const x = await h();
    const bad = utf16(['Title', 'Range', ['Keyword', 'Currency'].join('\t'), 'a b\tUSD'].join('\n'));
    const res = await x.post('/demand/keywords', { file_base64: b64(bad) });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({ code: 'KEYWORD_CSV_INVALID', details: { missing_headers: ['Avg. monthly searches', 'Competition (indexed value)'] } });
    expect((await x.post('/demand/keywords', { file_base64: b64(utf16(sheet())) })).json().error.code).toBe('KEYWORD_CSV_INVALID'); // no keyword rows
    expect((await x.post('/demand/keywords', { file_base64: 'not base64 !!' })).statusCode).toBe(422);
    expect((await x.post('/demand/keywords', { file_base64: b64(real), month: '2026-13' })).statusCode).toBe(422);
    expect((await x.post('/demand/keywords', { file_base64: b64(real), extra: 1 })).statusCode).toBe(422);
    expect(await db.selectFrom('keyword_demand_uploads').select('id').execute()).toHaveLength(0);
  });

  it('KD-3 a file over the size limit is 422; a READ token cannot upload; the same Idempotency-Key replays and stores one upload', async () => {
    const x = await h();
    const big = Buffer.alloc(1_000_001, 0x61);
    expect((await x.post('/demand/keywords', { file_base64: b64(big) })).json().error.code).toBe('KEYWORD_CSV_INVALID');
    const r = await issueToken('read');
    const k = randomUUID();
    const w = await issueToken('write', 'gavriel2');
    expect((await x.app.inject({ method: 'POST', url: '/demand/keywords', headers: { ...r.auth, 'idempotency-key': k }, payload: { file_base64: b64(real) } })).statusCode).toBe(403);
    const a = await x.app.inject({ method: 'POST', url: '/demand/keywords', headers: { ...w.auth, 'idempotency-key': k }, payload: { file_base64: b64(real) } });
    const b = await x.app.inject({ method: 'POST', url: '/demand/keywords', headers: { ...w.auth, 'idempotency-key': k }, payload: { file_base64: b64(real) } });
    expect(a.statusCode).toBe(201);
    expect(b.json()).toEqual(a.json());
    expect(await db.selectFrom('keyword_demand_uploads').select('id').execute()).toHaveLength(1);
    const noKey = await x.app.inject({ method: 'POST', url: '/demand/keywords', headers: w.auth, payload: { file_base64: b64(real) } });
    expect(noKey.statusCode).toBe(400);
  });

  it('KD-4 GET: 404 KEYWORD_NOT_FOUND, 422 without keyword; the newest upload wins and a newer null makes it unmeasured; the tables are append-only', async () => {
    const x = await h();
    expect((await x.get('/demand/keywords?keyword=nothing%20here')).json().error.code).toBe('KEYWORD_NOT_FOUND');
    expect((await x.get('/demand/keywords')).statusCode).toBe(422);
    await x.post('/demand/keywords', { file_base64: b64(utf16(sheet(row('roofer drone', '100')))) });
    await x.post('/demand/keywords', { file_base64: b64(utf16(sheet(row('roofer drone', '250', '70'), row('other', '5')))) });
    expect((await x.get('/demand/keywords?keyword=roofer%20drone')).json()).toMatchObject({ avg_monthly_searches: 250, competition_index: 70 });
    await x.post('/demand/keywords', { file_base64: b64(utf16(sheet(row('roofer drone', '')))) });
    expect((await x.get('/demand/keywords?keyword=roofer%20drone')).json().avg_monthly_searches).toBeNull();
    await expect(db.deleteFrom('keyword_demand').execute()).rejects.toThrow();
    await expect(db.updateTable('keyword_demand_uploads').set({ rows_n: 1 }).execute()).rejects.toThrow();
  });
});

describe('the demand screening input', () => {
  const NAME = 'rooferdrone.com';
  it('KD-5 a name with a measured keyword (its split tokens joined by spaces) gets demand {keyword, avg_monthly_searches, competition_index, as_of}', async () => {
    const x = await h();
    await x.post('/demand/keywords', { file_base64: b64(utf16(sheet(row('roofer drone', '1,300', '61')))) });
    const { body } = await x.runDone({ mode: 'full', checks: ['form', 'demand'], names: [{ domain: NAME, lane: 'S3' }] });
    const r = resultOf(body, 'demand');
    expect(r).toMatchObject({ status: 'PASS', gate: 'G8', fields: { demand: { keyword: 'roofer drone', avg_monthly_searches: 1300, competition_index: 61 } } });
    expect(r.fields.demand.as_of).toMatch(/[+-]\d{2}:\d{2}$/);
    expect(r.upstream_calls).toBe(0);
  });

  it('KD-6 no upload, an unlisted keyword or a null number is {status: "unmeasured"} (UNKNOWN, never a reject); the scout words are tried second', async () => {
    const x = await h();
    const a = await x.runDone({ mode: 'full', checks: ['form', 'demand'], names: [{ domain: NAME, lane: 'S3' }] });
    expect(resultOf(a.body, 'demand')).toMatchObject({ status: 'UNKNOWN', reason_code: 'KEYWORD_NOT_IN_UPLOAD', fields: { demand: { status: 'unmeasured' } } });
    await x.post('/demand/keywords', { file_base64: b64(utf16(sheet(row('roofer drone', ''), row('roofer drones', '77')))) });
    const b = await x.runDone({ mode: 'full', checks: ['form', 'demand'], names: [{ domain: NAME, lane: 'S3' }] });
    expect(resultOf(b.body, 'demand').fields.demand).toEqual({ status: 'unmeasured' });
    await x.post('/demand/keywords', { file_base64: b64(utf16(sheet(row('rooferdrone', '40')))) });
    // the scout words (a run name has none; the check reads them from the item) are the second candidate
    const ctx = { db, run: { mode: 'live' }, item: { domain: NAME, words: ['rooferdrone'] }, latest: () => ({ fields: { tokens: ['roofer', 'drone'] } }) } as never;
    expect((await demandCheck.run(ctx)).fields["demand"]).toMatchObject({ keyword: 'rooferdrone', avg_monthly_searches: 40 });
    expect(resultOf(b.body, 'demand').status).not.toBe('FAIL'); // the input never changes a verdict
    expect(b.body.names[0].status).toBe(a.body.names[0].status);
  });

  it('KD-7 demand.enabled false removes the check from the plan; a past as_of is UNKNOWN AS_OF_NOT_SUPPORTED', async () => {
    const x = await h();
    const asOf = await x.runDone({ mode: 'full', checks: ['form', 'demand'], names: [{ domain: NAME, lane: 'S3', as_of: '2026-01-01T00:00:00Z' }] });
    expect(resultOf(asOf.body, 'demand')).toMatchObject({ status: 'UNKNOWN', reason_code: 'AS_OF_NOT_SUPPORTED' });
    await patchActiveSettings(['demand'], { ...DEFAULT_SELECTION_VALUES.demand, enabled: false });
    const off = await x.runDone({ mode: 'full', checks: ['form', 'demand'], names: [{ domain: 'rooferdrones.com', lane: 'S3' }] });
    expect(resultOf(off.body, 'demand')).toBeUndefined();
  });
});

describe('the companies screening input (Companies House)', () => {
  const NAME = 'rooferdrone.com';
  const CH = 'https://api.company-information.service.gov.uk/search/companies';
  const KEY = 'ch-fake-key-for-tests';
  const answer = (items: unknown[]) => HttpResponse.json({ total_results: items.length, items });

  it('CH-2 sends HTTP Basic (key as the user name, empty password), q = the split tokens, items_per_page 20; counts whole-word matches, keeps title/number/status, active first', async () => {
    let seen: { auth: string | null; q: string | null; n: string | null } | null = null;
    mswServer.use(http.get(CH, ({ request }) => {
      const u = new URL(request.url);
      seen = { auth: request.headers.get('authorization'), q: u.searchParams.get('q'), n: u.searchParams.get('items_per_page') };
      return answer([
        { title: 'ROOFER DRONE LTD', company_number: '111', company_status: 'dissolved', address_snippet: 'a street', officers: [] },
        { title: 'Roofer Drone Services Limited', company_number: '222', company_status: 'active', date_of_creation: '2020-01-01' },
        { title: 'Roofer Drones Ltd', company_number: '333', company_status: 'active' },
      ]);
    }));
    const x = await h({ companiesHouseApiKey: KEY });
    const { body } = await x.runDone({ mode: 'full', checks: ['form', 'companies'], names: [{ domain: NAME, lane: 'S3' }] });
    expect(seen).toEqual({ auth: `Basic ${Buffer.from(`${KEY}:`).toString('base64')}`, q: 'roofer drone', n: '20' });
    const r = resultOf(body, 'companies');
    expect(r).toMatchObject({ status: 'PASS', gate: 'G8', upstream_calls: 1 });
    expect(r.fields.companies).toEqual({ uk_matches_n: 2, items: [{ title: 'Roofer Drone Services Limited', company_number: '222', company_status: 'active' }, { title: 'ROOFER DRONE LTD', company_number: '111', company_status: 'dissolved' }] });
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(JSON.stringify(r)).not.toContain('a street');
  });

  it('CH-3 no key: UNKNOWN SOURCE_DISABLED and no call; companies.enabled false removes the check from the plan', async () => {
    let calls = 0;
    mswServer.use(http.get(CH, () => { calls++; return answer([]); }));
    const x = await h();
    const a = await x.runDone({ mode: 'full', checks: ['form', 'companies'], names: [{ domain: NAME, lane: 'S3' }] });
    expect(resultOf(a.body, 'companies')).toMatchObject({ status: 'UNKNOWN', reason_code: 'SOURCE_DISABLED', upstream_calls: 0, fields: { companies: { uk_matches_n: null, items: [] } } });
    expect(calls).toBe(0);
    await patchActiveSettings(['companies'], { ...DEFAULT_SELECTION_VALUES.companies, enabled: false });
    const b = await x.runDone({ mode: 'full', checks: ['form', 'companies'], names: [{ domain: 'rooferdrones.com', lane: 'S3' }] });
    expect(resultOf(b.body, 'companies')).toBeUndefined();
  });

  it('CH-4 HTTP 429, 500, a network error and a timeout are UNKNOWN (RATE_LIMITED, SOURCE_ERROR, SOURCE_ERROR, TIMEOUT), never a reject', async () => {
    const x = await h({ companiesHouseApiKey: KEY });
    const run = async (handler: Parameters<typeof http.get>[1], extra: Record<string, unknown> = {}) => {
      mswServer.use(http.get(CH, handler));
      if (extra.timeout_ms) await patchActiveSettings(['companies'], { ...DEFAULT_SELECTION_VALUES.companies, timeout_ms: extra.timeout_ms });
      const { body } = await x.runDone({ mode: 'full', checks: ['form', 'companies'], names: [{ domain: NAME, lane: 'S3' }] });
      return resultOf(body, 'companies');
    };
    expect(await run(() => new HttpResponse(null, { status: 429 }))).toMatchObject({ status: 'UNKNOWN', reason_code: 'RATE_LIMITED', upstream_calls: 1 });
    expect(await run(() => new HttpResponse('boom', { status: 500 }))).toMatchObject({ status: 'UNKNOWN', reason_code: 'SOURCE_ERROR' });
    expect(await run(() => new HttpResponse('boom', { status: 401 }))).toMatchObject({ status: 'UNKNOWN', reason_code: 'SOURCE_ERROR' });
    expect(await run(() => HttpResponse.error())).toMatchObject({ status: 'UNKNOWN', reason_code: 'SOURCE_ERROR' });
    expect(await run(() => HttpResponse.text('not json'))).toMatchObject({ status: 'UNKNOWN', reason_code: 'SOURCE_ERROR' });
    expect(await run(async () => { await delay('infinite'); return HttpResponse.json({}); }, { timeout_ms: 500 })).toMatchObject({ status: 'UNKNOWN', reason_code: 'TIMEOUT' });
  });

  it('CH-5 calls are paced: max_per_minute 30 puts 2000 ms between two names\' calls (sleep is injected)', async () => {
    mswServer.use(http.get(CH, () => answer([])));
    const sleeps: number[] = [];
    const x = await h({ companiesHouseApiKey: KEY, sleep: async (ms: number) => { sleeps.push(ms); } });
    await patchActiveSettings(['companies'], { ...DEFAULT_SELECTION_VALUES.companies, max_per_minute: 30 });
    const { body } = await x.runDone({ mode: 'full', checks: ['form', 'companies'], names: [{ domain: NAME, lane: 'S3' }, { domain: 'rooferdrones.com', lane: 'S3' }] });
    expect(resultOf(body, 'companies', 0).fields.companies.uk_matches_n).toBe(0);
    expect(resultOf(body, 'companies', 1).status).toBe('PASS');
    expect(sleeps.some((s) => s > 1500 && s <= 2000)).toBe(true);
  });

  it('CH-6 the check is not in the pack requirements: a plan with demand and companies does not make a pack incomplete', async () => {
    const { requiredChecks } = await import('../../../src/modules/selection/pack.js');
    const req = requiredChecks('S3', ['form', 'lookalikes', 'demand', 'companies'] as never, DEFAULT_SELECTION_VALUES);
    expect(req).not.toContain('demand');
    expect(req).not.toContain('companies');
    expect(req).not.toContain('lookalikes');
    expect(req).toContain('form');
  });
});
