// CAP-20 screening runs: persisted per check, gate by gate in rank order, resumable, partial on budget (Review Focus 1, 4).
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { testDb as db, insertOwnedDomain } from '../helpers/db.js';
import { OFFLINE, putBrandLists, putList, screeningHarness, type ScreeningHarness } from '../helpers/screening.js';
import { outcome } from '../../src/screening/types.js';

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());
async function h(): Promise<ScreeningHarness> {
  const x = await screeningHarness();
  app = x.app;
  return x;
}
const live = (names: object[], extra: object = {}) => ({ checks: [...OFFLINE], names, ...extra });
const geo = (domain: string, extra: object = {}) => ({ domain, lane: 'S2', ...extra });
const nonGeo = (domain: string, extra: object = {}) => ({ domain, lane: 'S3', ...extra });
const byDomain = (body: any, domain: string) => body.names.find((n: any) => n.domain === domain);
const res = (n: any, check: string) => n.results.find((r: any) => r.check === check);

describe('POST /screening/runs and the offline checks', () => {
  it('202 with the poll path; a clean name passes form/brand_lists/concentration and waits for the two manual records (hold on)', async () => {
    await putBrandLists();
    const { run, app: a, get } = await h();
    const r = await run(live([nonGeo('tampapoolsco.com')]));
    expect(r.res.statusCode).toBe(202);
    expect(r.res.json()).toMatchObject({ status: 'running', mode: 'live', backtest: false, settings_version: 'v1', buy_hold: true, names_n: 1, poll: `/screening/runs/${r.id}` });
    await a.screeningWorker.runToEnd(r.id);
    const body = (await get(`/screening/runs/${r.id}`)).json();
    expect(body).toMatchObject({ status: 'done', mode: 'live', backtest: false, settings_version: 'v1', buy_hold: true, progress: { checks_planned: 5, checks_done: 5 } });
    const n = byDomain(body, 'tampapoolsco.com');
    expect(n).toMatchObject({ lane: 'S3', final_status: 'pending_manual', first_fail: null, pending_manual: ['web_risk', 'tm_us'], flags: [] });
    expect(n.results.map((x: any) => [x.check, x.gate, x.status])).toEqual([
      ['form', 'G0', 'PASS'], ['brand_lists', 'G1', 'PASS'], ['concentration', 'G3', 'PASS'], ['web_risk', 'G5', 'MANUAL_REQUIRED'], ['tm_us', 'G7', 'MANUAL_REQUIRED'],
    ]);
    expect(res(n, 'form')).toMatchObject({ settings_version: 'v1', cached: false, source: 'auto', rule_ids: expect.arrayContaining(['SPELL-1']) });
    expect(res(n, 'brand_lists').list_versions).toEqual({ brand: 1, bigco: 1, event: 1 });
    expect(body.funnel.by_final_status).toEqual({ pending_manual: 1 });
  });

  it('web_risk and tm_us are MANUAL_REQUIRED with the phrases to search (CAP-08 #3: TULSA ROOFING CO, TULSA ROOFING)', async () => {
    await putBrandLists();
    const { runDone } = await h();
    const { body } = await runDone(live([nonGeo('tulsaroofingco.com')]));
    const n = byDomain(body, 'tulsaroofingco.com');
    expect(res(n, 'web_risk')).toMatchObject({ status: 'MANUAL_REQUIRED', reason_code: 'MANUAL_SOURCE' });
    const tm = res(n, 'tm_us');
    expect(tm).toMatchObject({ status: 'MANUAL_REQUIRED', reason_code: 'MANUAL_SOURCE', fields: { control_required: true } });
    expect(tm.fields.phrases_to_query).toEqual(expect.arrayContaining(['TULSA ROOFING CO', 'TULSA ROOFING']));
    expect(tm.fields.phrases_to_query).not.toContain('ROOF ING');
  });

  it('a missing brand list is UNKNOWN LIST_MISSING: live stops the name there, full mode runs the later gates', async () => {
    const { runDone } = await h();
    const l = await runDone(live([nonGeo('tampapoolsco.com')]));
    const nl = byDomain(l.body, 'tampapoolsco.com');
    expect(res(nl, 'brand_lists')).toMatchObject({ status: 'UNKNOWN', reason_code: 'LIST_MISSING', fields: { lists_missing: ['brand', 'bigco', 'event'] } });
    expect(nl.results.map((x: any) => x.check)).toEqual(['form', 'brand_lists']);
    expect(nl.final_status).toBe('unknown');
    const f = await runDone(live([nonGeo('tampapoolsco.com')], { mode: 'full' }));
    const nf = byDomain(f.body, 'tampapoolsco.com');
    expect(nf.results.map((x: any) => x.check)).toEqual(['form', 'brand_lists', 'concentration', 'web_risk', 'tm_us']);
    expect(nf.final_status).toBe('unknown');
  });

  it('BIGCO-1: museagentsforbusiness.com with bigco "muse" FAILs BIGCO_HIT and later gates are not run (CR-001 CAP-02 #1)', async () => {
    await putBrandLists(['zzbrand'], ['muse', 'los angeles'], ['zzevent']);
    const { runDone } = await h();
    const { body } = await runDone(live([nonGeo('museagentsforbusiness.com')]));
    const n = byDomain(body, 'museagentsforbusiness.com');
    expect(n).toMatchObject({ final_status: 'rejected', first_fail: { check: 'brand_lists', gate: 'G1', reason_code: 'BIGCO_HIT' } });
    expect(res(n, 'brand_lists').fields.bigco_hits).toEqual([{ term: 'muse', tokens: ['muse'] }]);
    expect(n.results.map((x: any) => x.check)).toEqual(['form', 'brand_lists']);
    expect(body.funnel.first_fail).toEqual({ brand_lists: { gate: 'G1', count: 1 } });
  });

  it('a multi-word brand matches the space-stripped run of tokens; a city token is ignored for brand and bigco but not for event', async () => {
    await putBrandLists(['plumbing pros'], ['tampa'], ['tampa']);
    const { runDone } = await h();
    const { body } = await runDone(live([nonGeo('tampaplumbingpros.com')], { mode: 'full' }));
    const f = res(byDomain(body, 'tampaplumbingpros.com'), 'brand_lists');
    expect(f.fields.brand_hits).toEqual([{ term: 'plumbing pros', tokens: ['plumbing', 'pros'] }]);
    expect(f.fields.bigco_hits).toEqual([]); // "tampa" is a city token here
    expect(f.fields.event_hits).toEqual([{ term: 'tampa', tokens: ['tampa'] }]);
    expect(f).toMatchObject({ status: 'FAIL', reason_code: 'BRAND_HIT' });
  });

  it('CONCENTRATION-1: two Fresno names ahead block the third (CAP-04), naming both; full mode still runs the later gates', async () => {
    await putBrandLists();
    const { runDone } = await h();
    const names = [nonGeo('fresnoplumbingpros.com'), nonGeo('fresnoroofingco.com'), nonGeo('fresnoepoxyfloors.com')];
    const { body } = await runDone(live(names));
    const n = byDomain(body, 'fresnoepoxyfloors.com');
    const c = res(n, 'concentration');
    expect(c).toMatchObject({ status: 'FAIL', reason_code: 'CONCENTRATION_CITY', fields: { details: { attribute: 'city', value: 'fresno', count: 2, cap: 2, blocking: ['fresnoplumbingpros.com', 'fresnoroofingco.com'] } } });
    expect(n).toMatchObject({ final_status: 'rejected', first_fail: { check: 'concentration', gate: 'G3' } });
    expect(n.results.map((x: any) => x.check)).toEqual(['form', 'brand_lists', 'concentration']);
    expect(byDomain(body, 'fresnoroofingco.com').final_status).toBe('pending_manual');
    const full = await runDone(live(names, { mode: 'full' }));
    expect(byDomain(full.body, 'fresnoepoxyfloors.com').results.map((x: any) => x.check)).toEqual(['form', 'brand_lists', 'concentration', 'web_risk', 'tm_us']);
  });

  it('"ahead" is rank order, not submission order; a name that already failed does not count', async () => {
    await putBrandLists();
    const { runDone } = await h();
    const names = [nonGeo('fresnoepoxyfloors.com', { rank: 3 }), nonGeo('fresnoplumbingpros.com', { rank: 1 }), nonGeo('fresnoroofingco.com', { rank: 2 })];
    const { body } = await runDone(live(names));
    expect(res(byDomain(body, 'fresnoepoxyfloors.com'), 'concentration').status).toBe('FAIL');
    expect(res(byDomain(body, 'fresnoroofingco.com'), 'concentration').status).toBe('PASS');
    // the first one is rejected at brand_lists, so it does not block the others
    await putList('brand', ['plumbing'], 2);
    const b = await runDone(live(names));
    expect(byDomain(b.body, 'fresnoplumbingpros.com').first_fail.check).toBe('brand_lists');
    expect(res(byDomain(b.body, 'fresnoepoxyfloors.com'), 'concentration').status).toBe('PASS');
  });

  it('owned portfolio names count toward the cap', async () => {
    await putBrandLists();
    await insertOwnedDomain(db, { domain: 'fresnoplumbingpros.com' });
    await insertOwnedDomain(db, { domain: 'fresnoroofingco.com', status: 'listed' });
    await insertOwnedDomain(db, { domain: 'fresnodentistpros.com', status: 'sold' }); // sold names no longer count
    const { runDone } = await h();
    const { body } = await runDone(live([nonGeo('fresnoepoxyfloors.com')]));
    expect(res(byDomain(body, 'fresnoepoxyfloors.com'), 'concentration')).toMatchObject({
      status: 'FAIL', reason_code: 'CONCENTRATION_CITY', fields: { details: { blocking: ['fresnoplumbingpros.com', 'fresnoroofingco.com'] } },
    });
  });

  it('a geo name without a trade token: GEO_ATTR_MISSING FLAG from form (and from concentration); it does not block', async () => {
    await putBrandLists();
    const { runDone } = await h();
    const { body } = await runDone(live([geo('tampabright.com')]));
    const n = byDomain(body, 'tampabright.com');
    expect(res(n, 'form')).toMatchObject({ status: 'FLAG', reason_code: 'GEO_ATTR_MISSING' });
    expect(res(n, 'concentration')).toMatchObject({ status: 'FLAG', reason_code: 'GEO_ATTR_MISSING' });
    expect(n).toMatchObject({ flags: ['form', 'concentration'], final_status: 'pending_manual' });
  });

  it('odd spellings and duplicates (Review Focus 4): per-name INPUT_INVALID, the rest of the batch still runs', async () => {
    await putBrandLists();
    const { runDone } = await h();
    const { body } = await runDone(live([nonGeo('tampapoolsco.com'), nonGeo('  TampaPoolsCo.com. '), nonGeo('widgets.net'), nonGeo('bad_name.com'), nonGeo('www.widgets.com')]));
    const [a, dup, net, bad, www] = body.names;
    expect(a.final_status).toBe('pending_manual');
    for (const n of [dup, net, bad, www]) expect(n).toMatchObject({ final_status: 'invalid', first_fail: { check: 'form', reason_code: 'INPUT_INVALID' } });
    expect(res(dup, 'form')).toMatchObject({ status: 'FAIL', reason_code: 'INPUT_INVALID', fields: { cause: 'DUPLICATE' } });
    expect(res(dup, 'form').reason).toMatch(/^DUPLICATE/);
    expect(res(net, 'form').fields.cause).toBe('NOT_COM');
    expect(res(bad, 'form').fields.cause).toBe('DOMAIN_INVALID');
    expect(res(www, 'form').fields.cause).toBe('DOMAIN_INVALID');
    expect(dup.domain).toBe('tampapoolsco.com');
    expect(net.results).toHaveLength(1);
    expect(body.funnel.by_final_status).toEqual({ pending_manual: 1, invalid: 4 });
  });

  it('request validation: 1-50 names, known lanes and checks, strict bodies', async () => {
    const { run } = await h();
    for (const body of [{ names: [] }, { names: Array.from({ length: 51 }, (_, i) => nonGeo(`name${i}x.com`)) }, { names: [{ domain: 'a.com', lane: 'S9' }] },
      { names: [nonGeo('a.com')], checks: ['nope'] }, { names: [nonGeo('a.com')], extra: 1 }, { names: [{ ...nonGeo('a.com'), score: 5 }] }]) {
      const r = await run(body);
      expect([r.res.statusCode, r.res.json().error.code]).toEqual([422, 'VALIDATION_ERROR']);
    }
  });

  it('settings: a draft in live mode is 422 DRAFT_NOT_ALLOWED_LIVE, an unknown label 404, as_of in live 422; full + draft is a backtest while a live run uses v1 (CAP-00)', async () => {
    await putBrandLists();
    const { run, runDone, post } = await h();
    expect((await post('/selection/settings', { label: 'v1b', set: { 'concentration.max_per_attr': 3 } })).statusCode).toBe(201);
    const a = await run(live([nonGeo('tampapoolsco.com')], { settings: 'v1b' }));
    expect([a.res.statusCode, a.res.json().error.code]).toEqual([422, 'DRAFT_NOT_ALLOWED_LIVE']);
    const b = await run(live([nonGeo('tampapoolsco.com')], { settings: 'nope', mode: 'full' }));
    expect([b.res.statusCode, b.res.json().error.code]).toEqual([404, 'SETTINGS_NOT_FOUND']);
    const c = await run(live([nonGeo('tampapoolsco.com', { as_of: '2026-01-01T00:00:00Z' })]));
    expect([c.res.statusCode, c.res.json().error.code]).toEqual([422, 'AS_OF_LIVE_REFUSED']);
    const bt = await runDone(live([nonGeo('tampapoolsco.com', { as_of: '2026-01-01T00:00:00Z' })], { mode: 'full', settings: 'v1b' }));
    expect(bt.body).toMatchObject({ backtest: true, settings_version: 'v1b', mode: 'full' });
    expect(res(bt.body.names[0], 'form').settings_version).toBe('v1b');
    const lv = await runDone(live([nonGeo('tampapoolsco.com')]));
    expect(lv.body).toMatchObject({ backtest: false, settings_version: 'v1' });
    const stored = await db.selectFrom('screening_runs').select('input').where('id', '=', lv.id).executeTakeFirstOrThrow();
    expect((stored.input as { names: { as_of: string }[] }).names[0]!.as_of).toBe(new Date(lv.body.created_at).toISOString()); // live: as_of = request time
  });

  it('GET: ?domain= filters, ?view=summary leaves the results out, 404 RUN_NOT_FOUND; evidence 404', async () => {
    await putBrandLists();
    const { runDone, get } = await h();
    const { id, body } = await runDone(live([nonGeo('tampapoolsco.com'), nonGeo('tulsaroofingco.com')]));
    expect(body.names).toHaveLength(2);
    const one = (await get(`/screening/runs/${id}?domain=TulsaRoofingCo.com`)).json();
    expect(one.names.map((n: any) => n.domain)).toEqual(['tulsaroofingco.com']);
    const sum = (await get(`/screening/runs/${id}?view=summary`)).json();
    expect(sum.names[0].results).toBeUndefined();
    expect(sum.names[0].final_status).toBe('pending_manual');
    const nf = await get('/screening/runs/run_nope');
    expect([nf.statusCode, nf.json().error.code]).toEqual([404, 'RUN_NOT_FOUND']);
    expect((await get('/screening/evidence/99999')).json().error.code).toBe('EVIDENCE_NOT_FOUND');
    expect((await get('/screening/evidence/abc')).json().error.code).toBe('EVIDENCE_NOT_FOUND');
  });

  it('a check with no implementation answers NOT_RUN NOT_IMPLEMENTED, listed in not_implemented and not blocking', async () => {
    await putBrandLists();
    const { runDone } = await h();
    const { body } = await runDone({ checks: ['form', 'typo'], names: [nonGeo('tampapoolsco.com')] });
    const n = body.names[0];
    expect(res(n, 'typo')).toMatchObject({ status: 'NOT_RUN', reason_code: 'NOT_IMPLEMENTED', gate: 'G1' });
    expect(n).toMatchObject({ not_implemented: ['typo'], final_status: 'would_buy' });
  });

  it('results are append-only', async () => {
    const { runDone } = await h();
    await runDone(live([nonGeo('tampapoolsco.com')]));
    await expect(db.updateTable('screening_results').set({ status: 'PASS' }).execute()).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom('screening_results').execute()).rejects.toThrow(/append-only/);
  });
});

describe('cache and the freshness window', () => {
  it('a recorded Web Risk result is reused by a later run with the same settings, backtest flag and list versions (cached: true, original checked_at); an active-settings run does not reuse a backtest row', async () => {
    await putBrandLists();
    const { runDone, post, get } = await h();
    await post('/selection/settings', { label: 'v1c', set: { 'web_risk.requires_clean_history': false } });
    const body = live([nonGeo('tampapoolsco.com')], { mode: 'full', settings: 'v1c' });
    const first = await runDone(body);
    const rec = await post(`/screening/runs/${first.id}/manual`, {
      domain: 'tampapoolsco.com', check: 'web_risk', checked_at: '2026-10-06T07:30:00Z', evidence_url: 'https://transparencyreport.google.com/safe-browsing/search?url=tampapoolsco.com',
      result: { raw_status: 6 },
    });
    expect([rec.statusCode, rec.json().status]).toEqual([201, 'PASS']);
    const second = await runDone(body);
    const n = byDomain(second.body, 'tampapoolsco.com');
    expect(res(n, 'web_risk')).toMatchObject({ status: 'PASS', cached: true, source: 'cache', checked_at: '2026-10-06T07:30:00.000Z', duration_ms: 0, upstream_calls: 0 });
    expect(res(n, 'web_risk').evidence).toHaveLength(1);
    expect(res(n, 'form').cached).toBe(false); // form has no freshness window
    expect(res(n, 'tm_us').status).toBe('MANUAL_REQUIRED'); // a MANUAL_REQUIRED row is never reused
    const row = await db.selectFrom('screening_results').select(['cached_from', 'source']).where('run_id', '=', second.id).where('check_id', '=', 'web_risk').executeTakeFirstOrThrow();
    expect(row.source).toBe('cache');
    expect(row.cached_from).not.toBeNull();
    const liveRun = await runDone(live([nonGeo('tampapoolsco.com')]));
    expect(res(byDomain(liveRun.body, 'tampapoolsco.com'), 'web_risk').status).toBe('MANUAL_REQUIRED');
    void get;
  });

  it('outside the freshness window the check runs again', async () => {
    await putBrandLists();
    const { runDone, post, clock } = await h();
    await post('/selection/settings', { label: 'v1c', set: { 'web_risk.requires_clean_history': false } });
    const body = live([nonGeo('tampapoolsco.com')], { mode: 'full', settings: 'v1c' });
    const first = await runDone(body);
    await post(`/screening/runs/${first.id}/manual`, {
      domain: 'tampapoolsco.com', check: 'web_risk', checked_at: new Date(clock.t - 1000).toISOString(), evidence_url: 'https://example.com/x', result: { raw_status: 1 },
    });
    clock.t += 169 * 3_600_000; // web_risk freshness is 168 h
    const second = await runDone(body);
    expect(res(byDomain(second.body, 'tampapoolsco.com'), 'web_risk')).toMatchObject({ status: 'MANUAL_REQUIRED', cached: false });
  });
});

describe('time budget and resume (Review Focus 1)', () => {
  const slow = (clock: { t: number }, minutes: number) => ({
    id: 'availability' as const, gate: 'G2', ruleIds: ['S1'], lists: [],
    async run() { clock.t += minutes * 60_000; return outcome('PASS', null, null, { slow: true }); },
  });
  const plan = ['form', 'brand_lists', 'availability', 'web_risk'];

  it('a check that outlasts the budget: the run finishes partial, every unfinished check UNKNOWN TIMEOUT, no name would_buy', async () => {
    await putBrandLists();
    const { app: a, clock, runDone } = await h();
    a.screeningWorker.checks.availability = slow(clock, 40);
    const { body } = await runDone({ checks: plan, names: [nonGeo('tampapoolsco.com'), nonGeo('tulsaroofingco.com')] });
    expect(body.status).toBe('partial');
    expect(body.finished_at).not.toBeNull();
    const [n1, n2] = body.names;
    expect(res(n1, 'availability').status).toBe('PASS');
    expect(res(n2, 'availability')).toMatchObject({ status: 'UNKNOWN', reason_code: 'TIMEOUT' });
    for (const n of [n1, n2]) expect(res(n, 'web_risk')).toMatchObject({ status: 'UNKNOWN', reason_code: 'TIMEOUT' });
    expect(body.names.map((n: any) => n.final_status)).toEqual(['unknown', 'unknown']);
    expect(body.names.some((n: any) => n.final_status === 'would_buy')).toBe(false);
    expect(body.progress.checks_done).toBe(body.progress.checks_planned);
  });

  it('a worker killed mid-run and a clock past deadline_at: resumeStalled finalises it partial with TIMEOUT rows', async () => {
    await putBrandLists();
    const { app: a, clock, run, get } = await h();
    a.screeningWorker.stopAfterResults = 3;
    const { id } = await run({ checks: plan, names: [nonGeo('tampapoolsco.com'), nonGeo('tulsaroofingco.com')] });
    await a.screeningWorker.runToEnd(id);
    expect((await get(`/screening/runs/${id}`)).json().status).toBe('running');
    clock.t += 31 * 60_000;
    const r = await a.screeningWorker.resumeStalled();
    expect(r).toEqual({ resumed: [], finalized: [id] });
    const body = (await get(`/screening/runs/${id}`)).json();
    expect(body.status).toBe('partial');
    const codes = body.names.flatMap((n: any) => n.results.filter((x: any) => x.status === 'UNKNOWN').map((x: any) => x.reason_code));
    expect(codes.length).toBeGreaterThan(0);
    expect(new Set(codes)).toEqual(new Set(['TIMEOUT']));
    expect(body.names.map((n: any) => n.final_status)).toEqual(['unknown', 'unknown']);
  });

  it('a killed worker: a GET after 3 minutes resumes the run and finishes it without duplicate (item, check) rows', async () => {
    await putBrandLists();
    const { app: a, clock, run, get } = await h();
    a.screeningWorker.stopAfterResults = 2;
    const { id } = await run(live([nonGeo('tampapoolsco.com'), nonGeo('tulsaroofingco.com')]));
    await a.screeningWorker.runToEnd(id);
    expect((await get(`/screening/runs/${id}`)).json()).toMatchObject({ status: 'running', progress: { checks_planned: 10, checks_done: 2 } });
    clock.t += 30_000; // heartbeat is fresh: a poll does not restart anything
    expect((await get(`/screening/runs/${id}`)).json().progress.checks_done).toBe(2);
    clock.t += 3 * 60_000;
    expect((await get(`/screening/runs/${id}`)).json().status).toBe('running'); // the poll answers at once and kicks the worker
    await a.screeningWorker.runToEnd(id);
    const done = (await get(`/screening/runs/${id}`)).json();
    expect(done).toMatchObject({ status: 'done', progress: { checks_planned: 10, checks_done: 10 } });
    const rows = await db.selectFrom('screening_results').select(['item_idx', 'check_id']).where('run_id', '=', id).execute();
    expect(rows).toHaveLength(10);
    expect(new Set(rows.map((r) => `${r.item_idx}/${r.check_id}`)).size).toBe(10);
  });

  it('the hourly tick resumes a stalled run (step screeningResume {resumed, finalized})', async () => {
    await putBrandLists();
    const { app: a, clock, run } = await h();
    a.screeningWorker.stopAfterResults = 1;
    const { id } = await run(live([nonGeo('tampapoolsco.com')]));
    await a.screeningWorker.runToEnd(id);
    clock.t += 3 * 60_000;
    const tick = await a.jobRunner.run('tick');
    expect(tick.steps.screeningResume).toMatchObject({ ok: true, summary: { resumed: [id], finalized: [] } });
    await a.screeningWorker.idle();
    const st = await db.selectFrom('screening_runs').select('status').where('id', '=', id).executeTakeFirstOrThrow();
    expect(st.status).toBe('done');
  });

  it('a check that throws becomes UNKNOWN SOURCE_ERROR (message cut to 200 chars), never a pass', async () => {
    await putBrandLists();
    const { app: a, runDone } = await h();
    a.screeningWorker.checks.availability = { id: 'availability', gate: 'G2', ruleIds: [], lists: [], async run() { throw new Error('x'.repeat(500)); } };
    const { body } = await runDone({ checks: ['form', 'availability'], names: [nonGeo('tampapoolsco.com')] });
    const r = res(body.names[0], 'availability');
    expect(r).toMatchObject({ status: 'UNKNOWN', reason_code: 'SOURCE_ERROR' });
    expect(r.reason).toHaveLength(200);
    expect(body.names[0].final_status).toBe('unknown');
  });
});
