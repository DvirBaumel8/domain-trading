// CR-002 Amendment B: the manual HIST-2 record (POST /screening/runs/{id}/manual, check "history"). The Internet Archive is never
// automated (sources.wayback false): the name waits for the record, and the record decides the history gate exactly as the automated check would.
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { GATE_OF } from '../../src/screening/checks/index.js';
import { planFor } from '../../src/screening/engine.js';
import { outcome } from '../../src/screening/types.js';
import { currentLists } from '../../src/screening/lists.js';
import { testDb as db } from '../helpers/db.js';
import { putBrandLists, screeningHarness, type ScreeningHarness } from '../helpers/screening.js';

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());
async function h(): Promise<ScreeningHarness> {
  await putBrandLists(['zzbrand'], ['zzbigco'], ['zzevent']);
  const x = await screeningHarness();
  app = x.app;
  // The seeded rows pre-date every manual record, so a history record recomputes them in the same run (Task 3); offline, with PASS stubs, and
  // the worker is awaited after each post so the polls below read the settled run.
  for (const id of Object.keys(GATE_OF) as (keyof typeof GATE_OF)[]) {
    x.app.screeningWorker.checks[id] = { id, gate: GATE_OF[id], ruleIds: ['X'], lists: [], run: async () => outcome('PASS', null, null) };
  }
  const post = x.post;
  x.post = async (url, payload) => { const r = await post(url, payload); await x.app.screeningWorker.idle(); return r; };
  return x;
}

const DOMAIN = 'officeprepexample.com';
const URL1 = 'https://web.archive.org/web/20190412093000/http://officeprepexample.com/';
const URL2 = 'https://web.archive.org/web/20210301000000/http://officeprepexample.com/about';

/** A finished live S7 run on the full plan: every check PASS (no network) except `history`, which is MANUAL_REQUIRED, as the live run leaves it. */
async function seedRun(domains: string[] = [DOMAIN], history: 'MANUAL_REQUIRED' | 'FAIL' = 'MANUAL_REQUIRED'): Promise<string> {
  const sel = await db.selectFrom('selection_settings').select(['id', 'values']).where('label', '=', 'v1').executeTakeFirstOrThrow();
  const plan = planFor(sel.values as never, 'S7');
  const lists = await currentLists(db, ['brand', 'bigco']);
  const id = `run_${randomUUID()}`;
  await db.insertInto('screening_runs').values({
    id, created_by: 'test', mode: 'live', backtest: false, settings_id: sel.id, settings_label: 'v1', buy_hold: true, tranche_id: null,
    input: JSON.stringify({ names: domains.map((d, idx) => ({ idx, domain: d, lane: 'S7', leads_ab: 0 })) }),
    gate_plan: JSON.stringify({ S7: plan }), list_versions: JSON.stringify(Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, v.version]))),
    status: 'done', deadline_at: new Date(Date.now() + 3_600_000), finished_at: new Date(),
  }).execute();
  for (const [idx, d] of domains.entries()) {
    for (const check of plan) {
      const manual = check === 'history';
      await db.insertInto('screening_results').values({
        run_id: id, item_idx: idx, domain: d, lane: 'S7', check_id: check, gate: GATE_OF[check as keyof typeof GATE_OF], rule_ids: ['X'],
        status: manual ? history : 'PASS', reason_code: manual ? (history === 'FAIL' ? 'HARMFUL_HISTORY' : 'MANUAL_SOURCE') : null, reason: null, fields: JSON.stringify({}),
        checked_at: new Date(), settings_label: 'v1', list_versions: '{}', duration_ms: 0, upstream_calls: 0, source: 'auto',
      }).execute();
    }
  }
  return id;
}

const rec = (x: ScreeningHarness, over: object = {}, top: object = {}) => ({
  domain: DOMAIN, check: 'history', checked_at: new Date(x.clock.t - 3_600_000).toISOString(),
  result: { result: 'PASS', first_capture_year: 2019, last_capture_year: 2021, evidence_urls: [URL1], checked_by: 'gavriel', ...over }, ...top,
});
const nameOf = async (x: ScreeningHarness, id: string, domain = DOMAIN) => (await x.get(`/screening/runs/${id}?domain=${domain}`)).json().names[0];
const res = (n: any, check: string) => n.results.find((r: any) => r.check === check);
const openTranche = async (x: ScreeningHarness) => (await x.post('/tranches', { name: `T-${randomUUID().slice(0, 6)}` })).json().id as string;
const join = (x: ScreeningHarness, t: string, run_id: string) => x.post(`/tranches/${t}/members`, { action: 'add', domain: DOMAIN, run_id });

describe('manual HIST-2 record (CR-002 Amendment B)', () => {
  it('B7.2: without a record the name is refused MANUAL_REQUIRED', async () => {
    const x = await h();
    const id = await seedRun();
    expect((await nameOf(x, id)).pending_manual).toContain('history');
    const r = await join(x, await openTranche(x), id);
    expect([r.statusCode, r.json().error.code, r.json().error.details.check]).toEqual([409, 'MANUAL_REQUIRED', 'history']);
  });

  it('B7.1: a manual PASS satisfies the history gate (source manual, automated field shape) and the S7 name joins as main lane', async () => {
    const x = await h();
    const id = await seedRun();
    const r = await x.post(`/screening/runs/${id}/manual`, rec(x));
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ domain: DOMAIN, check: 'history', gate: 'G6', status: 'PASS', source: 'manual', recorded_by: expect.any(String) });
    expect(r.json().fields).toMatchObject({ hist2: 'PASS', hist2_fail_class: null, prior_history: 1, source_lane: 'expired_drop', com_prior_registration: 'yes', first_capture_year: 2019, last_capture_year: 2021, checked_by: 'gavriel', archive_span_yrs: 2 });
    const n = await nameOf(x, id);
    expect(n).toMatchObject({ final_status: 'would_buy', source_lane: 'expired_drop' });
    expect(res(n, 'history')).toMatchObject({ status: 'PASS', source: 'manual' });
    const t = await openTranche(x);
    const j = await join(x, t, id);
    expect(j.statusCode).toBe(200);
    expect(j.json().members[0]).toMatchObject({ domain: DOMAIN, lane: 'S7', main_lane: true });
  });

  it('a PASS with no capture year leaves prior_history and the source lane unknown (not main lane)', async () => {
    const x = await h();
    const id = await seedRun();
    const r = await x.post(`/screening/runs/${id}/manual`, rec(x, { first_capture_year: undefined, last_capture_year: undefined, evidence_urls: undefined }));
    expect(r.json().fields).toMatchObject({ prior_history: null, source_lane: 'unknown', com_prior_registration: 'unknown' });
    const j = await join(x, await openTranche(x), id);
    expect([j.statusCode, j.json().members[0].main_lane]).toEqual([200, false]);
  });

  it('B7.3: REJECT_HARMFUL is a FAIL with hist2_fail_class = category and blocks the tranche', async () => {
    const x = await h();
    const id = await seedRun();
    const r = await x.post(`/screening/runs/${id}/manual`, rec(x, { result: 'REJECT_HARMFUL', category: 'scam', evidence_urls: [URL1] }));
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ status: 'FAIL', reason_code: 'HARMFUL_HISTORY' });
    expect(r.json().fields).toMatchObject({ hist2: 'FAIL', hist2_fail_class: 'scam', evidence_urls: [URL1] });
    expect(await nameOf(x, id)).toMatchObject({ final_status: 'rejected', first_fail: { check: 'history', reason_code: 'HARMFUL_HISTORY' } });
    const j = await join(x, await openTranche(x), id);
    expect([j.statusCode, j.json().error.code]).toEqual([409, 'NOT_SCREENED_OK']);
  });

  it('B7.4: FLAG_PRIOR_BUSINESS shows as a FLAG disclosed risk, the name still joins, and the manual TM record must cover the prior name', async () => {
    const x = await h();
    const id = await seedRun();
    const tm = { domain: DOMAIN, check: 'tm_us', checked_at: new Date(x.clock.t - 3_600_000).toISOString(), evidence_url: 'https://tmsearch.uspto.gov/x', result: { phrases_queried: ['OFFICEPREPEXAMPLE'], control_ok: true, exact_or_core_live: [], generic_live: [] } };
    expect((await x.post(`/screening/runs/${id}/manual`, tm)).json().status).toBe('PASS');
    const r = await x.post(`/screening/runs/${id}/manual`, rec(x, { result: 'FLAG_PRIOR_BUSINESS', prior_business_name: 'Office Prep Solutions Inc', evidence_urls: [URL1, URL2] }));
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ status: 'FLAG', reason_code: 'PRIOR_BUSINESS_FLAGGED' });
    expect(r.json().fields).toMatchObject({ hist2: 'FLAG', prior_business_name: 'Office Prep Solutions Inc', prior_business_use: 'yes', prior_business_guard: { brand_hits: [], bigco_hits: [], cap08_required: true } });
    const n = await nameOf(x, id);
    expect(n.flags).toContain('history');
    // The TM record posted before the prior name was known no longer covers it: re-read, appended, never edited.
    expect(res(n, 'tm_us')).toMatchObject({ status: 'UNKNOWN', reason_code: 'PRIOR_NAME_NOT_QUERIED' });
    const fix = await x.post(`/screening/runs/${id}/manual`, { ...tm, result: { ...tm.result, phrases_queried: ['OFFICEPREPEXAMPLE', 'Office Prep Solutions Inc'] } });
    expect(fix.json().status).toBe('PASS');
    const j = await join(x, await openTranche(x), id);
    expect([j.statusCode, j.json().members[0].main_lane]).toEqual([200, true]);
  });

  it('A1 guard: a prior business name on the brand or big-company list FAILs the history result', async () => {
    const x = await h();
    const id = await seedRun();
    const a = await x.post(`/screening/runs/${id}/manual`, rec(x, { result: 'FLAG_PRIOR_BUSINESS', prior_business_name: 'ZzBrand Office', evidence_urls: [URL1] }));
    expect(a.json()).toMatchObject({ status: 'FAIL', reason_code: 'PRIOR_BUSINESS_BRAND_HIT' });
    const b = await x.post(`/screening/runs/${id}/manual`, rec(x, { result: 'PASS', prior_business_name: 'ZzBigco Supplies' }));
    expect(b.json()).toMatchObject({ status: 'FAIL', reason_code: 'PRIOR_BUSINESS_BIGCO_HIT' });
    expect(b.json().fields.hist2).toBe('PASS');
  });

  it('append-only: the latest record in force, earlier ones stay in the table; recorded_by and the audit row carry who, when and the evidence URLs', async () => {
    const x = await h();
    const id = await seedRun();
    expect((await x.post(`/screening/runs/${id}/manual`, rec(x))).statusCode).toBe(201);
    const second = await x.post(`/screening/runs/${id}/manual`, rec(x, { result: 'REJECT_HARMFUL', category: 'spam', evidence_urls: [URL1, URL2] }));
    expect(second.statusCode).toBe(201);
    expect(res(await nameOf(x, id), 'history')).toMatchObject({ status: 'FAIL' });
    const rows = await db.selectFrom('screening_results').select(['status', 'source', 'recorded_by', 'audit_id', 'checked_at']).where('run_id', '=', id).where('check_id', '=', 'history').orderBy('id').execute();
    expect(rows.map((r) => [r.status, r.source])).toEqual([['MANUAL_REQUIRED', 'auto'], ['PASS', 'manual'], ['FAIL', 'manual']]);
    expect(rows[2]!.recorded_by).toBeTruthy();
    const audit = await db.selectFrom('audit_log').select(['token_id', 'path', 'request', 'status_code']).where('id', '=', rows[2]!.audit_id!).executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ path: `/screening/runs/${id}/manual`, status_code: 201 });
    expect(JSON.stringify(audit.request)).toContain(URL2);
    expect(JSON.stringify(audit.request)).toContain('checked_by');
  });

  it('fail closed: an automated history FAIL is never outranked by a manual PASS; the evidence row names the first archive link', async () => {
    const x = await h();
    const id = await seedRun([DOMAIN], 'FAIL');
    const r = await x.post(`/screening/runs/${id}/manual`, rec(x, {}, { evidence_url: 'https://example.com/ignored' }));
    expect(r.statusCode).toBe(201);
    const n = await nameOf(x, id);
    expect(res(n, 'history')).toMatchObject({ status: 'FAIL', source: 'auto' });
    expect(n.final_status).toBe('rejected');
    const ev = await x.get(`/screening/evidence/${r.json().evidence[0]}`);
    expect(ev.json().url).toBe(URL1);
  });

  describe('errors', () => {
    let x!: ScreeningHarness;
    let id = '';
    beforeEach(async () => { x = await h(); id = await seedRun(); });
    const bad = async (over: object, top: object = {}) => ({ r: await x.post(`/screening/runs/${id}/manual`, rec(x, over, top)) });
    it('REJECT_HARMFUL or FLAG_PRIOR_BUSINESS without an evidence URL: 422 VALIDATION_ERROR', async () => {
      for (const over of [{ result: 'REJECT_HARMFUL', category: 'adult', evidence_urls: undefined }, { result: 'FLAG_PRIOR_BUSINESS', evidence_urls: undefined }, { result: 'FLAG_PRIOR_BUSINESS', evidence_urls: [] }]) {
        const { r } = await bad(over);
        expect([r.statusCode, r.json().error.code]).toEqual([422, 'VALIDATION_ERROR']);
      }
    });
    it('REJECT_HARMFUL without a category, or an unknown category: 422', async () => {
      expect((await bad({ result: 'REJECT_HARMFUL', evidence_urls: [URL1] })).r.statusCode).toBe(422);
      const u = (await bad({ result: 'REJECT_HARMFUL', category: 'blocklist', evidence_urls: [URL1] })).r;
      expect([u.statusCode, u.json().error.code]).toEqual([422, 'VALIDATION_ERROR']);
    });
    it('evidence must be an archive capture link', async () => {
      expect((await bad({ result: 'FLAG_PRIOR_BUSINESS', evidence_urls: ['https://example.com/page'] })).r.statusCode).toBe(422);
      expect((await bad({ result: 'FLAG_PRIOR_BUSINESS', evidence_urls: ['https://web.archive.org/web/*/officeprepexample.com'] })).r.statusCode).toBe(422);
    });
    it('capture years without an archive evidence link: 422; the same PASS with no years is fine', async () => {
      const r = await bad({ evidence_urls: undefined });
      expect([r.r.statusCode, r.r.json().error.code]).toEqual([422, 'VALIDATION_ERROR']);
      expect((await bad({ first_capture_year: undefined, last_capture_year: undefined, evidence_urls: undefined })).r.statusCode).toBe(201);
    });
    it('missing checked_by, an unknown result, or inverted years: 422', async () => {
      expect((await bad({ checked_by: undefined })).r.statusCode).toBe(422);
      expect((await bad({ result: 'MAYBE' })).r.statusCode).toBe(422);
      expect((await bad({ first_capture_year: 2021, last_capture_year: 2019 })).r.statusCode).toBe(422);
    });
    it('a domain not in the run is 404 NAME_NOT_IN_RUN', async () => {
      const r = await x.post(`/screening/runs/${id}/manual`, { ...rec(x), domain: 'other.com' });
      expect([r.statusCode, r.json().error.code]).toEqual([404, 'NAME_NOT_IN_RUN']);
    });
    it('checked_at in the future or older than the history window (168 h): 422 CHECKED_AT_INVALID', async () => {
      const fut = await x.post(`/screening/runs/${id}/manual`, { ...rec(x), checked_at: new Date(x.clock.t + 3_600_000).toISOString() });
      const old = await x.post(`/screening/runs/${id}/manual`, { ...rec(x), checked_at: new Date(x.clock.t - 200 * 3_600_000).toISOString() });
      expect([fut.statusCode, fut.json().error.code, old.statusCode, old.json().error.code]).toEqual([422, 'CHECKED_AT_INVALID', 422, 'CHECKED_AT_INVALID']);
    });
    it('web_risk and tm_us still need evidence_url', async () => {
      const r = await x.post(`/screening/runs/${id}/manual`, { domain: DOMAIN, check: 'web_risk', checked_at: new Date(x.clock.t - 1000).toISOString(), result: { raw_status: 1 } });
      expect([r.statusCode, r.json().error.code]).toEqual([422, 'VALIDATION_ERROR']);
    });
  });
});
