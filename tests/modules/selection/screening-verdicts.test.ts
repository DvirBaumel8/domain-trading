// FLAG verdicts: POST /screening/runs/{id}/verdicts.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { GATE_OF } from '../../../src/modules/selection/checks/index.js';
import { planFor } from '../../../src/modules/selection/engine.js';
import { testDb as db } from '../../helpers/db.js';
import { issueToken } from '../../helpers/tokens.js';
import { screeningHarness, type ScreeningHarness } from '../../helpers/screening.js';

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());
async function h(): Promise<ScreeningHarness> {
  const x = await screeningHarness();
  app = x.app;
  return x;
}
const DOMAIN = 'aiactconformity.com';
const URL_ = 'https://uspto.example/search?q=aiactconformity';

/** A finished S3 run, every check PASS (no network). */
async function seedRun(): Promise<string> {
  const sel = await db.selectFrom('selection_settings').select(['id', 'values']).where('label', '=', 'v1').executeTakeFirstOrThrow();
  const plan = planFor(sel.values as never, 'S3');
  const id = `run_${randomUUID()}`;
  await db.insertInto('screening_runs').values({
    id, created_by: 'test', mode: 'live', backtest: false, settings_id: sel.id, settings_label: 'v1', buy_hold: true, tranche_id: null,
    input: JSON.stringify({ names: [{ idx: 0, domain: DOMAIN, lane: 'S3', leads_ab: 0 }] }), gate_plan: JSON.stringify({ S3: plan }),
    list_versions: '{}', status: 'done', deadline_at: new Date(Date.now() + 3_600_000), finished_at: new Date(),
  }).execute();
  for (const check of plan) {
    await db.insertInto('screening_results').values({
      run_id: id, item_idx: 0, domain: DOMAIN, lane: 'S3', check_id: check, gate: GATE_OF[check as keyof typeof GATE_OF], rule_ids: ['X'],
      status: 'PASS', reason_code: null, reason: null, fields: JSON.stringify({}), checked_at: new Date(), settings_label: 'v1', list_versions: '{}',
      duration_ms: 0, upstream_calls: 0, source: 'auto',
    }).execute();
  }
  return id;
}
const postTmUsFlag = (x: ScreeningHarness, id: string) => x.post(`/screening/runs/${id}/manual`, {
  domain: DOMAIN, check: 'tm_us', checked_at: new Date(x.clock.t - 60_000).toISOString(), evidence_url: URL_,
  result: { phrases_queried: ['AI ACT CONFORMITY'], control_ok: true, exact_or_core_live: [], generic_live: [{ mark: 'CONFORMITY', serial: '1', owner: 'Y', status: 'registered' }] },
});
const resultIdOf = async (id: string, check: string): Promise<number> => {
  const rows = await db.selectFrom('screening_results').select('id').where('run_id', '=', id).where('check_id', '=', check).orderBy('id', 'desc').execute();
  return Number(rows[0]!.id);
};

describe('POST /screening/runs/{id}/verdicts', () => {
  it('records a PASS/REJECT verdict on the FLAG row in force; refuses non-FLAG and stale rows', async () => {
    const x = await h();
    const id = await seedRun();
    const flag = await postTmUsFlag(x, id);
    expect(flag.json()).toMatchObject({ status: 'FLAG', reason_code: 'TM_GENERIC_HITS' });
    const flagId = await resultIdOf(id, 'tm_us');
    const body = { domain: DOMAIN, check: 'tm_us', result_id: flagId, verdict: 'PASS', reason: 'Generic CONFORMITY marks only; our phrase is descriptive', decided_by: 'Shomer', decided_at: new Date(x.clock.t - 60_000).toISOString() };
    const r = await x.post(`/screening/runs/${id}/verdicts`, body);
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ verdict: 'PASS', result_id: flagId, check: 'tm_us', decided_by: 'Shomer', domain: DOMAIN, run_id: id });
    const formId = await resultIdOf(id, 'form');
    const notFlag = await x.post(`/screening/runs/${id}/verdicts`, { ...body, check: 'form', result_id: formId });
    expect([notFlag.statusCode, notFlag.json().error.code, notFlag.json().error.details.status]).toEqual([409, 'VERDICT_RESULT_NOT_FLAG', 'PASS']);
    // a newer manual tm_us record replaces the row in force -> the old id is stale
    await postTmUsFlag(x, id);
    const stale = await x.post(`/screening/runs/${id}/verdicts`, body);
    expect([stale.statusCode, stale.json().error.code, stale.json().error.details.in_force_result_id]).toEqual([409, 'VERDICT_RESULT_STALE', await resultIdOf(id, 'tm_us')]);
    expect((await x.post(`/screening/runs/${id}/verdicts`, { ...body, result_id: 999999 })).json().error.code).toBe('RESULT_NOT_FOUND');
    expect((await x.post(`/screening/runs/${id}/verdicts`, { ...body, result_id: await resultIdOf(id, 'tm_us'), decided_at: new Date(x.clock.t + 3_600_000).toISOString() })).json().error.code).toBe('DECIDED_AT_INVALID');
    expect((await x.post(`/screening/runs/${id}/verdicts`, { ...body, result_id: await resultIdOf(id, 'tm_us'), reason: '' })).statusCode).toBe(422);
    expect((await x.post(`/screening/runs/${id}/verdicts`, { ...body, domain: 'nothere.com' })).json().error.code).toBe('NAME_NOT_IN_RUN');
    expect((await x.post(`/screening/runs/run_nope/verdicts`, body)).json().error.code).toBe('RUN_NOT_FOUND');
  });

  it('a READ token is refused (403)', async () => {
    const x = await h();
    const id = await seedRun();
    await postTmUsFlag(x, id);
    const r = await issueToken('read');
    const res = await x.app.inject({ method: 'POST', url: `/screening/runs/${id}/verdicts`, headers: { ...r.auth, 'idempotency-key': randomUUID() }, payload: { domain: DOMAIN, check: 'tm_us', result_id: await resultIdOf(id, 'tm_us'), verdict: 'PASS', reason: 'x', decided_by: 'S', decided_at: new Date(x.clock.t - 60_000).toISOString() } });
    expect(res.statusCode).toBe(403);
    expect(await db.selectFrom('screening_verdicts').select('id').execute()).toEqual([]);
  });

  it('GET lists verdicts per name (only those on a row in force); the latest verdict for a result wins; rows are append-only', async () => {
    const x = await h();
    const id = await seedRun();
    await postTmUsFlag(x, id);
    const rid = await resultIdOf(id, 'tm_us');
    const v = (verdict: string, reason: string) => x.post(`/screening/runs/${id}/verdicts`, { domain: DOMAIN, check: 'tm_us', result_id: rid, verdict, reason, decided_by: 'Shomer', decided_at: new Date(x.clock.t - 60_000).toISOString() });
    expect((await v('PASS', 'first')).statusCode).toBe(201);
    expect((await v('REJECT', 'changed my mind')).statusCode).toBe(201);
    const n = (await x.get(`/screening/runs/${id}`)).json().names[0];
    expect(n.verdicts).toEqual([expect.objectContaining({ check: 'tm_us', result_id: rid, verdict: 'REJECT', reason: 'changed my mind', decided_by: 'Shomer' })]);
    expect(n.final_status).not.toBe('rejected');
    expect(n.flags).toContain('tm_us');
    await expect(sql`UPDATE screening_verdicts SET reason = 'x'`.execute(db)).rejects.toThrow();
    await expect(sql`DELETE FROM screening_verdicts`.execute(db)).rejects.toThrow();
    // a newer row replaces the one in force: the old verdict is no longer shown
    await postTmUsFlag(x, id);
    expect((await x.get(`/screening/runs/${id}`)).json().names[0].verdicts).toEqual([]);
  });
});
