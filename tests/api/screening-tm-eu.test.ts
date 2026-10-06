// CAP-09: the manual EU/international trademark record (check "tm_eu").
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { GATE_OF } from '../../src/screening/checks/index.js';
import { tmEuCheck } from '../../src/screening/checks/manual.js';
import { planFor } from '../../src/screening/engine.js';
import { DEFAULT_SELECTION_VALUES } from '../../src/screening/settings.js';
import type { CheckContext } from '../../src/screening/types.js';
import { testDb as db } from '../helpers/db.js';
import { screeningHarness, type ScreeningHarness } from '../helpers/screening.js';

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());
async function h(): Promise<ScreeningHarness> {
  const x = await screeningHarness();
  app = x.app;
  return x;
}

/** A finished live run on each name's lane plan (all PASS); tm_eu is not in any default gate list. */
async function seedRun(names: { domain: string; lane: string }[]): Promise<string> {
  const sel = await db.selectFrom('selection_settings').select(['id', 'values']).where('label', '=', 'v1').executeTakeFirstOrThrow();
  const id = `run_${randomUUID()}`;
  const gate: Record<string, string[]> = {};
  for (const n of names) gate[n.lane] = planFor(sel.values as never, n.lane as never);
  await db.insertInto('screening_runs').values({
    id, created_by: 'test', mode: 'live', backtest: false, settings_id: sel.id, settings_label: 'v1', buy_hold: true, tranche_id: null,
    input: JSON.stringify({ names: names.map((n, idx) => ({ idx, domain: n.domain, lane: n.lane, leads_ab: 0 })) }),
    gate_plan: JSON.stringify(gate), list_versions: '{}', status: 'done', deadline_at: new Date(Date.now() + 3_600_000), finished_at: new Date(),
  }).execute();
  for (const [idx, n] of names.entries()) {
    for (const check of gate[n.lane]!) {
      await db.insertInto('screening_results').values({
        run_id: id, item_idx: idx, domain: n.domain, lane: n.lane, check_id: check, gate: GATE_OF[check as keyof typeof GATE_OF], rule_ids: ['X'],
        status: 'PASS', reason_code: null, reason: null, fields: JSON.stringify({}), checked_at: new Date(), settings_label: 'v1', list_versions: '{}',
        duration_ms: 0, upstream_calls: 0, source: 'auto',
      }).execute();
    }
  }
  return id;
}

const URL_ = 'https://euipo.europa.eu/eSearch/#basic/1+1+1+1/50+50+50+50/aiactconformity';
const clear = { checked_by: 'dvir', registers: ['euipo', 'wipo', 'ukipo'], register_urls: ['https://euipo.europa.eu/eSearch/', 'https://branddb.wipo.int/'], result: 'clear', exact_or_core_live: [], generic_live: [] };
const mk = (register: string, mark = 'AI ACT CONFORMITY') => ({ mark, number: '018912345', owner: 'X GmbH', status: 'registered', register });
const base = (x: ScreeningHarness, over: object = {}) => ({ domain: 'aiactconformity.com', check: 'tm_eu', checked_at: new Date(x.clock.t - 3_600_000).toISOString(), evidence_url: URL_, ...over });

describe('POST /screening/runs/{id}/manual: tm_eu', () => {
  it('records a clear EU search as PASS; hits split like CAP-08', async () => {
    const x = await h();
    const id = await seedRun([{ domain: 'aiactconformity.com', lane: 'S6' }]);
    const r = await x.post(`/screening/runs/${id}/manual`, base(x, { result: clear }));
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ check: 'tm_eu', gate: 'G7', status: 'PASS', source: 'manual', rule_ids: ['TM-1-EU'] });
    const hit = { ...clear, result: 'hits', exact_or_core_live: [mk('euipo')] };
    expect((await x.post(`/screening/runs/${id}/manual`, base(x, { result: hit }))).json()).toMatchObject({ status: 'FAIL', reason_code: 'TM_LIVE_MARK' });
    const generic = { ...clear, result: 'hits', generic_live: [mk('wipo', 'CONFORMITY')] };
    expect((await x.post(`/screening/runs/${id}/manual`, base(x, { result: generic }))).json()).toMatchObject({ status: 'FLAG', reason_code: 'TM_GENERIC_HITS' });
  });

  it('is accepted for an S3 name whose plan has no tm_eu, and the run view shows it as a result row only when the plan reads it (final_status unchanged)', async () => {
    const x = await h();
    const id = await seedRun([{ domain: 'aiactconformity.com', lane: 'S3' }]);
    const before = (await x.get(`/screening/runs/${id}`)).json().names[0].final_status;
    expect((await x.post(`/screening/runs/${id}/manual`, base(x, { result: clear }))).statusCode).toBe(201);
    expect((await x.get(`/screening/runs/${id}`)).json().names[0].final_status).toBe(before);
  });

  it('refuses "clear" with marks and "hits" with none (422 VALIDATION_ERROR), a missing evidence_url, and checked_at older than eu_tm.freshness_hours (422 CHECKED_AT_INVALID)', async () => {
    const x = await h();
    const id = await seedRun([{ domain: 'aiactconformity.com', lane: 'S6' }]);
    const code = async (body: object) => { const r = await x.post(`/screening/runs/${id}/manual`, body); return [r.statusCode, r.json().error.code]; };
    expect(await code(base(x, { result: { ...clear, generic_live: [mk('wipo', 'CONFORMITY')] } }))).toEqual([422, 'VALIDATION_ERROR']);
    expect(await code(base(x, { result: { ...clear, result: 'hits' } }))).toEqual([422, 'VALIDATION_ERROR']);
    expect(await code(base(x, { evidence_url: undefined, result: clear }))).toEqual([422, 'VALIDATION_ERROR']);
    expect(await code(base(x, { checked_at: new Date(x.clock.t - 169 * 3_600_000).toISOString(), result: clear }))).toEqual([422, 'CHECKED_AT_INVALID']);
  });

  it('CHECK_NOT_MANUAL lists the four manual checks', async () => {
    const x = await h();
    const id = await seedRun([{ domain: 'aiactconformity.com', lane: 'S6' }]);
    const r = await x.post(`/screening/runs/${id}/manual`, base(x, { check: 'form', result: {} }));
    expect(r.json().error).toMatchObject({ code: 'CHECK_NOT_MANUAL', details: { manual: ['web_risk', 'tm_us', 'history', 'tm_eu'] } });
  });
});

describe('the automated tm_eu check', () => {
  const ctx = (lane: string) => ({ item: { lane }, settings: DEFAULT_SELECTION_VALUES }) as unknown as CheckContext;
  it('MANUAL_REQUIRED for S6, PASS NOT_REQUIRED_FOR_LANE for S3', async () => {
    expect(await tmEuCheck.run(ctx('S6'))).toMatchObject({ status: 'MANUAL_REQUIRED', reasonCode: 'MANUAL_SOURCE' });
    expect(await tmEuCheck.run(ctx('S3'))).toMatchObject({ status: 'PASS', reasonCode: 'NOT_REQUIRED_FOR_LANE' });
  });
});
