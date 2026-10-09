// Manual Web Risk (CAP-06) and USPTO (CAP-08) records, evidence, manual renewal quotes (CAP-17).
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { testDb as db } from '../../helpers/db.js';
import { OFFLINE, putBrandLists, screeningHarness, type ScreeningHarness } from '../../helpers/screening.js';

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());
async function h(): Promise<ScreeningHarness> {
  const x = await screeningHarness();
  app = x.app;
  return x;
}
const URL_ = 'https://transparencyreport.google.com/safe-browsing/search?url=tampapoolsco.com';
const nonGeo = (domain: string) => ({ domain, lane: 'S3' });

/** A finished run of one name with the offline plan (plus history when asked) and the manual-record helper. */
async function setup(opts: { history?: boolean; settings?: object } = {}) {
  await putBrandLists();
  const x = await h();
  let settings: string | undefined;
  if (opts.settings) {
    await x.post('/selection/settings', { label: 'v1d', set: opts.settings });
    settings = 'v1d';
  }
  const checks = opts.history ? [...OFFLINE, 'history'] : [...OFFLINE];
  const r = await x.runDone({ checks, names: [nonGeo('tampapoolsco.com')], ...(settings && { mode: 'full', settings }) });
  const record = (check: string, result: object, extra: object = {}) =>
    x.post(`/screening/runs/${r.id}/manual`, { domain: 'tampapoolsco.com', check, checked_at: '2026-10-06T07:30:00Z', evidence_url: URL_, result, ...extra });
  return { ...x, id: r.id, record };
}
const tm = (over: object = {}) => ({ phrases_queried: ['TAMPA POOLS CO', 'TAMPA POOLS'], control_ok: true, exact_or_core_live: [], generic_live: [], ...over });
const mark = { mark: 'EPOXY FLOOR', serial: '99733154', owner: 'Fusion Epoxy, Inc.', status: 'published for opposition' };

describe('POST /screening/runs/{id}/manual: web_risk', () => {
  it('a safe status with history not in the plan: UNKNOWN HISTORY_NOT_FINAL (CAP-06 #3 analogue); the evidence is stored and readable', async () => {
    const { record, get, id } = await setup();
    const r = await record('web_risk', { raw_status: 6 }, { note: 'looked at it by hand' });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({
      domain: 'tampapoolsco.com', check: 'web_risk', gate: 'G5', status: 'UNKNOWN', reason_code: 'HISTORY_NOT_FINAL', source: 'manual', cached: false,
      checked_at: '2026-10-06T10:30:00+03:00', recorded_by: 'gavriel', fields: { raw_status: 6, hist1_clean: null, evidence_url: URL_, note: 'looked at it by hand' },
    });
    const ev = r.json().evidence as number[];
    expect(ev).toHaveLength(1);
    const e = (await get(`/screening/evidence/${ev[0]}`)).json();
    expect(e).toMatchObject({ id: ev[0], source: 'manual', url: URL_, http_status: null, truncated: false, text: JSON.stringify({ raw_status: 6 }) });
    expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
    // the manual row supersedes the MANUAL_REQUIRED one
    const run = (await get(`/screening/runs/${id}`)).json();
    expect(run.names[0].results.find((x: any) => x.check === 'web_risk')).toMatchObject({ status: 'UNKNOWN', source: 'manual' });
    expect(run.names[0].final_status).toBe('unknown');
    const row = await db.selectFrom('screening_results').select(['recorded_by', 'audit_id']).where('source', '=', 'manual').executeTakeFirstOrThrow();
    expect(row.recorded_by).toBe('gavriel');
    expect(row.audit_id).toBeTruthy();
  });

  it('with web_risk.requires_clean_history off (a draft) the same record is PASS', async () => {
    const { record } = await setup({ settings: { 'web_risk.requires_clean_history': false } });
    expect((await record('web_risk', { raw_status: 6 })).json()).toMatchObject({ status: 'PASS', reason_code: null });
    expect((await record('web_risk', { raw_status: 1 })).json().status).toBe('PASS');
  });

  it('status 2 (unsafe): FAIL UNSAFE; an unrecognised status: UNKNOWN STATUS_UNRECOGNISED', async () => {
    const { record, get, id } = await setup();
    expect((await record('web_risk', { raw_status: 2, threat_types: ['MALWARE'] })).json()).toMatchObject({ status: 'FAIL', reason_code: 'UNSAFE', fields: { threat_types: ['MALWARE'] } });
    expect((await get(`/screening/runs/${id}`)).json().names[0]).toMatchObject({ final_status: 'rejected', first_fail: { check: 'web_risk', gate: 'G5', reason_code: 'UNSAFE' } });
    expect((await record('web_risk', { raw_status: 99 })).json()).toMatchObject({ status: 'UNKNOWN', reason_code: 'STATUS_UNRECOGNISED' });
  });

  it('with history in the plan: a PASS history lets a safe status pass, an unknown history keeps it UNKNOWN', async () => {
    const { record, id } = await setup({ history: true });
    // history has no implementation: NOT_RUN NOT_IMPLEMENTED is not a final PASS
    expect((await record('web_risk', { raw_status: 1 })).json()).toMatchObject({ status: 'UNKNOWN', reason_code: 'HISTORY_NOT_FINAL', fields: { hist1_clean: false } });
    await db.insertInto('screening_results').values({
      run_id: id, item_idx: 0, domain: 'tampapoolsco.com', lane: 'S3', check_id: 'history', gate: 'G6', rule_ids: [], status: 'PASS_WITH_NOTE', reason_code: 'PARKED_ONLY',
      fields: '{}', checked_at: new Date(), settings_label: 'v1', list_versions: '{}', duration_ms: 0, upstream_calls: 0, source: 'manual',
    }).execute();
    expect((await record('web_risk', { raw_status: 1 })).json()).toMatchObject({ status: 'PASS', fields: { hist1_clean: true } });
  });
});

describe('POST /screening/runs/{id}/manual: tm_us', () => {
  it('control query failed: UNKNOWN CONTROL_FAILED (CAP-08 #5), even with no marks', async () => {
    const { record } = await setup();
    expect((await record('tm_us', tm({ control_ok: false }))).json()).toMatchObject({ gate: 'G7', status: 'UNKNOWN', reason_code: 'CONTROL_FAILED' });
  });

  it('only generic live marks: FLAG TM_GENERIC_HITS with the list (CAP-08 #6)', async () => {
    const { record } = await setup();
    const r = (await record('tm_us', tm({ generic_live: [{ ...mark, mark: 'POOL PROS', serial: '1' }], dead_n: 4 }))).json();
    expect(r).toMatchObject({ status: 'FLAG', reason_code: 'TM_GENERIC_HITS', fields: { dead_n: 4, generic_live: [{ mark: 'POOL PROS' }] } });
  });

  it('a live exact or core mark: FAIL TM_LIVE_MARK (CAP-08 #1/#2 shapes); no marks and control ok: PASS', async () => {
    const { record, get, id } = await setup();
    expect((await record('tm_us', tm({ exact_or_core_live: [mark] }))).json()).toMatchObject({ status: 'FAIL', reason_code: 'TM_LIVE_MARK' });
    expect((await get(`/screening/runs/${id}`)).json().names[0].first_fail).toMatchObject({ check: 'tm_us', gate: 'G7' });
    const ok = (await record('tm_us', tm())).json();
    expect([ok.status, ok.reason_code]).toEqual(['PASS', null]);
  });

  it('web_risk and tm_us PASS records move the name from pending_manual to would_buy (the hold is on)', async () => {
    const { record, get, id } = await setup({ settings: { 'web_risk.requires_clean_history': false } });
    const before = (await get(`/screening/runs/${id}`)).json().names[0];
    expect(before.final_status).toBe('pending_manual');
    await record('web_risk', { raw_status: 6 });
    await record('tm_us', tm());
    const after = (await get(`/screening/runs/${id}`)).json();
    expect(after.names[0]).toMatchObject({ final_status: 'would_buy', pending_manual: [] });
    expect(after.funnel.by_final_status).toEqual({ would_buy: 1 });
  });
});

describe('POST /screening/runs/{id}/manual: errors', () => {
  it('404 RUN_NOT_FOUND, 404 NAME_NOT_IN_RUN (also for an invalid-input name), 422 CHECK_NOT_MANUAL, 422 on bad shapes', async () => {
    const { record, post } = await setup();
    const err = (r: { statusCode: number; json(): { error: { code: string } } }) => [r.statusCode, r.json().error.code];
    expect(err(await post('/screening/runs/run_nope/manual', { domain: 'tampapoolsco.com', check: 'web_risk', checked_at: '2026-10-06T07:30:00Z', evidence_url: URL_, result: { raw_status: 1 } }))).toEqual([404, 'RUN_NOT_FOUND']);
    expect(err(await post(`/screening/runs/${(await db.selectFrom('screening_runs').select('id').executeTakeFirstOrThrow()).id}/manual`, { domain: 'other.com', check: 'web_risk', checked_at: '2026-10-06T07:30:00Z', evidence_url: URL_, result: { raw_status: 1 } }))).toEqual([404, 'NAME_NOT_IN_RUN']);
    expect(err(await record('form', { raw_status: 1 }))).toEqual([422, 'CHECK_NOT_MANUAL']);
    expect(err(await record('nonsense', {}))).toEqual([422, 'CHECK_NOT_MANUAL']);
    expect(err(await record('web_risk', { raw_status: 'x' }))).toEqual([422, 'VALIDATION_ERROR']);
    expect(err(await record('web_risk', { raw_status: 1, extra: 1 }))).toEqual([422, 'VALIDATION_ERROR']);
    expect(err(await record('tm_us', tm({ phrases_queried: [] })))).toEqual([422, 'VALIDATION_ERROR']);
    expect(err(await record('web_risk', { raw_status: 1 }, { evidence_url: 'http://insecure.example/x' }))).toEqual([422, 'VALIDATION_ERROR']);
    expect(err(await record('web_risk', { raw_status: 1 }, { checked_at: '2027-01-01T00:00:00Z' }))).toEqual([422, 'CHECKED_AT_INVALID']);
    expect(err(await record('web_risk', { raw_status: 1 }, { checked_at: '2026-09-01T00:00:00Z' }))).toEqual([422, 'CHECKED_AT_INVALID']); // older than web_risk's 168 h window
    expect(err(await record('web_risk', { raw_status: 1 }, { checked_at: 'yesterday' }))).toEqual([422, 'VALIDATION_ERROR']);
  });
});

describe('manual records: list versions and the stored summary', () => {
  it('a manual row stores the run list versions of its check lists; the summary of a finished run is refreshed', async () => {
    const { record, id } = await setup({ settings: { 'web_risk.requires_clean_history': false } });
    const before = (await db.selectFrom('screening_runs').select('summary').where('id', '=', id).executeTakeFirstOrThrow()).summary as { by_final_status: object };
    expect(before.by_final_status).toEqual({ pending_manual: 1 });
    await record('web_risk', { raw_status: 6 });
    const tmRow = (await record('tm_us', tm())).json();
    expect(tmRow.list_versions).toMatchObject({ trade: 1, generic_head: 1 }); // the tm_us check's lists at the run's versions
    expect((await record('web_risk', { raw_status: 6 })).json().list_versions).toEqual({});
    const after = (await db.selectFrom('screening_runs').select('summary').where('id', '=', id).executeTakeFirstOrThrow()).summary as { by_final_status: object };
    expect(after.by_final_status).toEqual({ would_buy: 1 });
  });
});

describe('POST /quotes/manual', () => {
  const body = (over: object = {}) => ({ domain: 'PromptInjectionAudit.com', registrar: 'GoDaddy', renewal_usd: 22.99, first_year_usd: 13.73, source_note: 'GoDaddy renewal page, Dvir account', observed_at: '2026-10-05T12:00:00Z', ...over });

  it('round trip: stored in cents, valid_until = observed_at + quote.manual_max_age_days (30)', async () => {
    const { post } = await h();
    const r = await post('/quotes/manual', body({ source_url: 'https://www.godaddy.com/renew' }));
    expect(r.statusCode).toBe(201);
    expect(r.json()).toEqual({ id: expect.any(Number), domain: 'promptinjectionaudit.com', registrar: 'godaddy', renewal_cents: 2299, renewal: '$22.99', valid_until: '2026-11-04T14:00:00+02:00' });
    const row = await db.selectFrom('manual_quotes').selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({ domain: 'promptinjectionaudit.com', registrar: 'godaddy', renewal_cents: 2299, first_year_cents: 1373, source_url: 'https://www.godaddy.com/renew', recorded_by: 'gavriel' });
    expect(row.audit_id).toBeTruthy();
    await expect(db.updateTable('manual_quotes').set({ renewal_cents: 1 }).execute()).rejects.toThrow(/append-only/);
  });

  it('observed 31 days ago or in the future: 422 OBSERVED_AT_INVALID; 30 days is fine', async () => {
    const { post, clock } = await h();
    const ago = (d: number) => new Date(clock.t - d * 86_400_000).toISOString();
    for (const at of [ago(31), new Date(clock.t + 3_600_000).toISOString()]) {
      const r = await post('/quotes/manual', body({ observed_at: at }));
      expect([r.statusCode, r.json().error.code]).toEqual([422, 'OBSERVED_AT_INVALID']);
    }
    expect((await post('/quotes/manual', body({ observed_at: ago(29.9) }))).statusCode).toBe(201);
    expect(await db.selectFrom('manual_quotes').select('id').execute()).toHaveLength(1);
  });

  it('the registrar must be a configured registrar name; Cloudflare is refused (founder rule 5)', async () => {
    const { post } = await h();
    const cf = await post('/quotes/manual', body({ registrar: 'Cloudflare' }));
    expect([cf.statusCode, cf.json().error.code]).toEqual([422, 'REGISTRAR_NOT_ALLOWED']);
    for (const registrar of ['nope', 'constructor']) {
      const r = await post('/quotes/manual', body({ registrar }));
      expect([r.statusCode, r.json().error.code]).toEqual([422, 'REGISTRAR_UNKNOWN']);
    }
    expect(await db.selectFrom('manual_quotes').select('id').execute()).toHaveLength(0);
  });

  it('bad input: a non-.com or invalid domain, a zero price, a missing source note: 422', async () => {
    const { post } = await h();
    expect((await post('/quotes/manual', body({ domain: 'a.net' }))).json().error.code).toBe('TLD_NOT_SUPPORTED');
    expect((await post('/quotes/manual', body({ domain: 'bad_name.com' }))).json().error.code).toBe('DOMAIN_INVALID');
    expect((await post('/quotes/manual', body({ renewal_usd: 0 }))).json().error.code).toBe('VALIDATION_ERROR');
    expect((await post('/quotes/manual', body({ renewal_usd: 1.234 }))).json().error.code).toBe('VALIDATION_ERROR');
    expect((await post('/quotes/manual', body({ source_note: '' }))).json().error.code).toBe('VALIDATION_ERROR');
  });
});
