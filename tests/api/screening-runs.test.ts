// CAP-20 screening runs: persisted per check, gate by gate in rank order, resumable, partial on budget (Review Focus 1, 4).
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { testDb as db, insertOwnedDomain } from '../helpers/db.js';
import { OFFLINE, enableWayback, putBrandLists, putList, screeningHarness, type ScreeningHarness } from '../helpers/screening.js';
import { outcome } from '../../src/screening/types.js';
import { HttpResponse } from 'msw';
import { recordedSite, syntheticSite, waybackHandlers } from '../helpers/screening-fixtures.js';
import { mswServer } from '../setup/network.js';

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());
async function h(opts: { stopAfterResults?: number } = {}): Promise<ScreeningHarness> {
  const x = await screeningHarness(opts);
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

  it('a check with no implementation answers NOT_RUN NOT_IMPLEMENTED, a live name is unknown, a full run only lists it', async () => {
    await putBrandLists();
    const x = await h();
    delete x.app.screeningWorker.checks.history; // every gating check is built now: unplug one to see the not-implemented path
    const { runDone } = x;
    const { body } = await runDone({ checks: ['form', 'history'], names: [nonGeo('tampapoolsco.com')] });
    const n = body.names[0];
    expect(res(n, 'history')).toMatchObject({ status: 'NOT_RUN', reason_code: 'NOT_IMPLEMENTED', gate: 'G6' });
    expect(n).toMatchObject({ not_implemented: ['history'], final_status: 'unknown' }); // live: an unbuilt gate is never a survivor
    const full = await runDone({ checks: ['form', 'history'], mode: 'full', names: [nonGeo('tampapoolsco.com')] });
    expect(full.body.names[0]).toMatchObject({ not_implemented: ['history'], final_status: 'would_buy' }); // report mode lists it
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
    expect(res(n, 'web_risk')).toMatchObject({ status: 'PASS', cached: true, source: 'cache', checked_at: '2026-10-06T10:30:00+03:00', duration_ms: 0, upstream_calls: 0 });
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
    const { app: a, clock, run, get } = await h({ stopAfterResults: 3 });
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
    const { app: a, clock, run, get } = await h({ stopAfterResults: 2 });
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
    const { app: a, clock, run } = await h({ stopAfterResults: 1 });
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

describe('fix round 1', () => {
  const plan = ['form', 'brand_lists', 'availability', 'web_risk'];
  const manualBody = (check: string, result: object) => ({ domain: 'tampapoolsco.com', check, checked_at: '2026-10-06T07:30:00Z', evidence_url: 'https://example.com/x', result });

  it('a manual record posted while the worker is running, before G5, is not hidden by the auto row that lands later', async () => {
    await putBrandLists();
    const { app: a, post, run, get } = await h();
    let id = '';
    a.screeningWorker.checks.availability = {
      id: 'availability', gate: 'G2', ruleIds: [], lists: [],
      async run() {
        // at G2 the run exists: the human record arrives before the worker reaches G5
        const r = await post(`/screening/runs/${id}/manual`, manualBody('web_risk', { raw_status: 2 }));
        expect(r.statusCode).toBe(201);
        return outcome('PASS', null, null);
      },
    };
    const created = await run({ checks: plan, names: [nonGeo('tampapoolsco.com')] });
    id = created.id;
    await a.screeningWorker.runToEnd(id);
    const rows = await db.selectFrom('screening_results').select(['id', 'source', 'status']).where('check_id', '=', 'web_risk').orderBy('id').execute();
    expect(rows.map((r) => r.source)).toEqual(['manual', 'cache']); // the worker reused the fresh manual result (a cache row copy); the manual row stays the answer
    expect((await get(`/screening/runs/${id}`)).json().names[0]).toMatchObject({ final_status: 'rejected', first_fail: { check: 'web_risk', reason_code: 'UNSAFE' } });
  });

  it('a stale worker that already decided to run web_risk still loses to the manual record (auto row has the higher id)', async () => {
    await putBrandLists();
    const { app: a, post, run, get } = await h();
    let id = '';
    a.screeningWorker.checks.availability = { id: 'availability', gate: 'G2', ruleIds: [], lists: [], async run() { return outcome('PASS', null, null); } }; // the real one is built in Task 5
    a.screeningWorker.checks.web_risk = {
      id: 'web_risk', gate: 'G5', ruleIds: ['WEB-RISK-1'], lists: [],
      async run() {
        await post(`/screening/runs/${id}/manual`, manualBody('web_risk', { raw_status: 2 })); // lands during the check
        return outcome('MANUAL_REQUIRED', 'MANUAL_SOURCE', 'x');
      },
    };
    id = (await run({ checks: plan, names: [nonGeo('tampapoolsco.com')] })).id;
    await a.screeningWorker.runToEnd(id);
    const rows = await db.selectFrom('screening_results').select(['id', 'source']).where('check_id', '=', 'web_risk').orderBy('id').execute();
    expect(rows.map((r) => r.source)).toEqual(['manual', 'auto']);
    expect((await get(`/screening/runs/${id}`)).json().names[0]).toMatchObject({ final_status: 'rejected', first_fail: { check: 'web_risk' } });
  });

  it('a backtest never yields a buy card: with buy_hold off in the draft it is still would_buy; so is a run whose settings are no longer active', async () => {
    await putBrandLists();
    const { runDone, post, get, app: a } = await h();
    await post('/selection/settings', { label: 'v1h', set: { buy_hold: false, 'web_risk.requires_clean_history': false } });
    const body = { checks: ['form', 'brand_lists'], names: [nonGeo('tampapoolsco.com')] };
    const bt = await runDone({ ...body, mode: 'full', settings: 'v1h' });
    expect(bt.body).toMatchObject({ backtest: true, buy_hold: false });
    expect(bt.body.names[0].final_status).toBe('would_buy');
    expect(JSON.stringify((await db.selectFrom('screening_runs').select('summary').where('id', '=', bt.id).executeTakeFirstOrThrow()).summary)).toContain('would_buy');
    // an activated version with the hold off, a live run on it, then another version becomes active
    const v1 = await db.selectFrom('selection_settings').select('values').where('label', '=', 'v1').executeTakeFirstOrThrow();
    const base = { values: JSON.stringify({ ...(v1.values as object), buy_hold: false }), created_by: 't', activated_by: 't', activation_approval_text: 'a', activation_approval_at: new Date(), activated_at: new Date() };
    await db.insertInto('selection_settings').values({ ...base, label: 'vh', activation_seq: 2 }).execute();
    const live = await runDone(body);
    expect(live.body).toMatchObject({ settings_version: 'vh', backtest: false, buy_hold: false });
    expect(live.body.names[0].final_status).toBe('buy_candidate');
    await db.insertInto('selection_settings').values({ ...base, label: 'vz', activation_seq: 3 }).execute();
    expect((await get(`/screening/runs/${live.id}`)).json().names[0].final_status).toBe('would_buy');
    void a;
  });

  it('the freshness cache is skipped for an item as of a past date, and a dated run is never a source', async () => {
    await putBrandLists();
    const { runDone, post } = await h();
    const n = (extra: object = {}) => [nonGeo('tampapoolsco.com', extra)];
    const liveRun = await runDone({ checks: [...OFFLINE], names: n() });
    expect((await post(`/screening/runs/${liveRun.id}/manual`, manualBody('web_risk', { raw_status: 2 }))).statusCode).toBe(201);
    const dated = await runDone({ checks: [...OFFLINE], mode: 'full', names: n({ as_of: '2026-01-01T00:00:00Z' }) });
    expect(res(dated.body.names[0], 'web_risk')).toMatchObject({ status: 'MANUAL_REQUIRED', cached: false });
    const undated = await runDone({ checks: [...OFFLINE], mode: 'full', names: n() });
    expect(res(undated.body.names[0], 'web_risk')).toMatchObject({ status: 'FAIL', cached: true }); // "now": the live result is reusable
    // a manual record in the dated run is not reused by a later undated run
    await post(`/screening/runs/${dated.id}/manual`, manualBody('tm_us', { phrases_queried: ['X'], control_ok: true, exact_or_core_live: [], generic_live: [] }));
    const again = await runDone({ checks: [...OFFLINE], mode: 'full', names: n() });
    expect(res(again.body.names[0], 'tm_us')).toMatchObject({ status: 'MANUAL_REQUIRED', cached: false });
  });

  it('a run whose execute throws still ends: past its deadline it is partial with SOURCE_ERROR rows; resumeStalled reports finalized only on a real change', async () => {
    await putBrandLists();
    const { app: a, clock, runDone, get } = await h();
    let reads = 0;
    a.screeningWorker.checks.availability = {
      id: 'availability', gate: 'G2', ruleIds: [], async run() { return outcome('PASS', null, null); },
      // createRun reads `lists` once; execute is the second read and fails, with the deadline already past
      get lists(): string[] { if (++reads >= 2) { clock.t += 31 * 60_000; throw new Error('boom'); } return []; },
    };
    const { id, body } = await runDone({ checks: plan, names: [nonGeo('tampapoolsco.com')] });
    expect(body.status).toBe('partial');
    expect(res(body.names[0], 'availability')).toMatchObject({ status: 'UNKNOWN', reason_code: 'SOURCE_ERROR', reason: 'boom' });
    expect(res(body.names[0], 'web_risk')).toMatchObject({ status: 'UNKNOWN', reason_code: 'SOURCE_ERROR' });
    expect(body.names[0].final_status).toBe('unknown');
    expect(await a.screeningWorker.resumeStalled()).toEqual({ resumed: [], finalized: [] }); // nothing is running any more
    void get; void id;
  });

  it('before the deadline a failing execute leaves the run running (it is retried); finalized lists a run only if it really ended', async () => {
    await putBrandLists();
    const { app: a, clock, run, get } = await h();
    let fail = true;
    let reads = 0;
    a.screeningWorker.checks.availability = {
      id: 'availability', gate: 'G2', ruleIds: [], async run() { return outcome('PASS', null, null); },
      get lists(): string[] { if (++reads >= 2 && fail) throw new Error('boom'); return []; },
    };
    const { id } = await run({ checks: plan, names: [nonGeo('tampapoolsco.com')] });
    await a.screeningWorker.runToEnd(id);
    expect((await get(`/screening/runs/${id}`)).json().status).toBe('running');
    fail = false;
    clock.t += 3 * 60_000;
    expect((await a.screeningWorker.resumeStalled()).resumed).toEqual([id]);
    await a.screeningWorker.idle();
    expect((await get(`/screening/runs/${id}`)).json().status).toBe('done');
  });

  it('two workers on one run: the racing duplicate insert is harmless (23505), rows stay unique, the run finishes', async () => {
    await putBrandLists();
    const { app: a, run } = await h();
    const slow = { id: 'availability' as const, gate: 'G2', ruleIds: [], lists: [], async run() { await new Promise((r) => setTimeout(r, 15)); return outcome('PASS', null, null); } };
    a.screeningWorker.checks.availability = slow;
    const { ScreeningWorker } = await import('../../src/screening/engine.js');
    const other = new ScreeningWorker({ db, now: () => Date.parse('2026-10-06T08:00:20Z'), log: { warn() {}, error() {} }, screening: {} as never });
    other.checks.availability = slow;
    const { id } = await run({ checks: plan, names: [nonGeo('tampapoolsco.com'), nonGeo('tulsaroofingco.com')] });
    await Promise.all([a.screeningWorker.runToEnd(id), other.runToEnd(id)]);
    const rows = await db.selectFrom('screening_results').select(['item_idx', 'check_id']).where('run_id', '=', id).execute();
    expect(rows).toHaveLength(8);
    expect(new Set(rows.map((r) => `${r.item_idx}/${r.check_id}`)).size).toBe(8);
    const st = await db.selectFrom('screening_runs').select('status').where('id', '=', id).executeTakeFirstOrThrow();
    expect(st.status).toBe('done');
  });

  it('lane gate lists must agree on the order of the checks they share (SETTINGS_INVALID at draft time)', async () => {
    const { post } = await h();
    const r = await post('/selection/settings', { label: 'v1o', set: { 'run.gates.S2': ['brand_lists', 'form', 'availability'] } });
    expect([r.statusCode, r.json().error.code]).toEqual([422, 'SETTINGS_INVALID']);
    expect(JSON.stringify(r.json())).toContain('gate order');
  });
});

describe('the worker keeps the same precedence as derive (a manual record outranks an auto row)', () => {
  it('a manual PASS posted while the check ran is read back: the name is not stopped by the auto FAIL it hides, so the next check runs', async () => {
    await putBrandLists();
    const { app: a, runDone } = await h();
    let tmRan = 0;
    a.screeningWorker.checks.web_risk = {
      id: 'web_risk', gate: 'G5', ruleIds: [], lists: [],
      async run(ctx) {
        // a human record for this very (name, check) lands while the automatic check is still running
        await db.insertInto('screening_results').values({
          run_id: ctx.run.id, item_idx: ctx.item.idx, domain: ctx.item.domain, lane: ctx.item.lane, check_id: 'web_risk', gate: 'G5', rule_ids: [], status: 'PASS',
          reason_code: null, reason: null, fields: JSON.stringify({ raw_status: 6 }), data_as_of: null, checked_at: new Date(ctx.now()), settings_label: ctx.settingsLabel,
          list_versions: JSON.stringify({}), duration_ms: 0, upstream_calls: 0, evidence_ids: [], source: 'manual', cached_from: null, recorded_by: 'gavriel',
        }).execute();
        return outcome('FAIL', 'SAFE_BROWSING_UNSAFE', 'auto row that the manual record hides');
      },
    };
    a.screeningWorker.checks.tm_us = { id: 'tm_us', gate: 'G7', ruleIds: [], lists: [], async run() { tmRan++; return outcome('PASS', null, null); } };
    const { body } = await runDone({ checks: ['web_risk', 'tm_us'], names: [nonGeo('tampapoolsco.com')] });
    expect(tmRan).toBe(1);
    const n = body.names[0];
    expect(res(n, 'web_risk')).toMatchObject({ status: 'PASS', source: 'manual' });
    expect(n.final_status).toBe('would_buy');
  });
});

describe('history in a full plan (CAP-07)', () => {
  const wr = (domain: string) => ({ domain, check: 'web_risk', checked_at: '2026-10-06T07:30:00Z', evidence_url: 'https://transparencyreport.google.com/safe-browsing/search?url=x', result: { raw_status: 6 } });

  it('the v10 order is respected (web_risk before history before tm_us); a manual web_risk record turns UNKNOWN HISTORY_NOT_FINAL into PASS once history has passed', async () => {
    await putBrandLists();
    await enableWayback();
    const x = await screeningHarness({ screening: { sleep: async () => {}, rdapLookup: async () => ({ outcome: 'not_registered', reasonCode: null, httpStatus: 404, url: 'https://rdap.example/x', retrievedAt: new Date(), body: null, facts: null }) } });
    app = x.app;
    const plan = ['form', 'availability', 'web_risk', 'history', 'tm_us'];
    // 1) the archive is down: history is UNKNOWN, so a Web Risk "safe" record is not final
    mswServer.use(...waybackHandlers({}, undefined, { cdx: () => new HttpResponse('x', { status: 500 }) }));
    const a = await x.runDone({ checks: plan, mode: 'full', names: [nonGeo('memphisplumbingpros.com')] });
    const na = byDomain(a.body, 'memphisplumbingpros.com');
    expect(na.results.map((r: any) => [r.check, r.gate, r.status])).toEqual([['form', 'G0', 'PASS'], ['availability', 'G2', 'PASS'], ['web_risk', 'G5', 'MANUAL_REQUIRED'], ['history', 'G6', 'UNKNOWN'], ['tm_us', 'G7', 'MANUAL_REQUIRED']]);
    const ids = await db.selectFrom('screening_results').select(['check_id', 'id']).where('run_id', '=', a.id).orderBy('id').execute();
    expect(ids.map((r) => r.check_id)).toEqual(['form', 'availability', 'web_risk', 'history', 'tm_us']);
    const r1 = await x.post(`/screening/runs/${a.id}/manual`, wr('memphisplumbingpros.com'));
    expect([r1.statusCode, r1.json().status, r1.json().reason_code]).toEqual([201, 'UNKNOWN', 'HISTORY_NOT_FINAL']);
    // 2) a new run: history PASS (no captures), then the same record is PASS
    mswServer.resetHandlers();
    mswServer.use(...waybackHandlers({ 'memphisplumbingpros.com': recordedSite('memphisplumbingpros.com') }));
    const b = await x.runDone({ checks: plan, mode: 'full', names: [nonGeo('memphisplumbingpros.com')] });
    expect(res(byDomain(b.body, 'memphisplumbingpros.com'), 'history')).toMatchObject({ status: 'PASS', fields: { pre_cls: 'none' } });
    const r2 = await x.post(`/screening/runs/${b.id}/manual`, wr('memphisplumbingpros.com'));
    expect([r2.statusCode, r2.json().status]).toEqual([201, 'PASS']);
    expect(res(byDomain((await x.get(`/screening/runs/${b.id}`)).json(), 'memphisplumbingpros.com'), 'web_risk')).toMatchObject({ status: 'PASS', source: 'manual' });
  });

  it('a harmful history stops a live name at G6: the later gates never run', async () => {
    await putBrandLists();
    await enableWayback();
    const x = await screeningHarness({ screening: { sleep: async () => {}, rdapLookup: async () => ({ outcome: 'not_registered', reasonCode: null, httpStatus: 404, url: 'https://rdap.example/x', retrievedAt: new Date(), body: null, facts: null }) } });
    app = x.app;
    const s = syntheticSite('synthetic-pharma');
    mswServer.use(...waybackHandlers({ [s.domain]: s }));
    const { body } = await x.runDone({ checks: ['form', 'availability', 'history', 'tm_us'], names: [nonGeo(s.domain)] });
    const n = byDomain(body, s.domain);
    expect(n.results.map((r: any) => r.check)).toEqual(['form', 'availability', 'history']);
    expect(n).toMatchObject({ final_status: 'rejected', first_fail: { check: 'history', gate: 'G6', reason_code: 'HARMFUL_HISTORY' }, source_lane: 'expired_drop' });
  });
});
