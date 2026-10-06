// CAP-19 screening packs: POST /screening/packs, GET /screening/packs/{id}, GET /screening/packs?domain=.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { GATE_OF } from '../../src/screening/checks/index.js';
import { planFor } from '../../src/screening/engine.js';
import { PACK_DEFAULT } from '../../src/screening/settings.js';
import { testDb as db } from '../helpers/db.js';
import { issueToken } from '../helpers/tokens.js';
import { patchActiveSettings, screeningHarness, type ScreeningHarness } from '../helpers/screening.js';

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());
async function h(): Promise<ScreeningHarness> {
  const x = await screeningHarness();
  app = x.app;
  await patchActiveSettings(['pack'], { ...PACK_DEFAULT, require_checks: [] }); // v1 plans have no same_name check
  return x;
}
const DOMAIN = 'aiactconformity.com';
const judgment = { van_test: { verdict: 'PASS', reason: 'Clear to a van driver' }, tn1: { verdict: 'PASS', reason: 'No operator trades under it' },
  bigco: { verdict: 'PASS', reason: 'No big-company overlap' }, reason_not_to_buy: 'Thin end-user demand', judged_by: 'Gavriel', judged_at: '2026-10-06T08:00:00+03:00' };

/** A finished S3 run, every check PASS (a tm_us FLAG when `flag`), fresh availability and quote at `at`. */
async function seedRun(at: number, o: { flag?: boolean; backtest?: boolean; status?: 'done' | 'running'; checks?: string[]; plan?: string[] } = {}): Promise<string> {
  const sel = await db.selectFrom('selection_settings').select(['id', 'values']).where('label', '=', 'v1').executeTakeFirstOrThrow();
  const plan = o.plan ?? planFor(sel.values as never, 'S3');
  const id = `run_${randomUUID()}`;
  await db.insertInto('screening_runs').values({
    id, created_by: 'test', mode: 'live', backtest: o.backtest ?? false, settings_id: sel.id, settings_label: 'v1', buy_hold: true, tranche_id: null,
    input: JSON.stringify({ ...(o.checks ? { checks: o.checks } : {}), names: [{ idx: 0, domain: DOMAIN, lane: 'S3', leads_ab: 0 }] }), gate_plan: JSON.stringify({ S3: plan }),
    list_versions: '{}', status: o.status ?? 'done', deadline_at: new Date(at + 3_600_000), finished_at: o.status === 'running' ? null : new Date(at),
  }).execute();
  for (const check of plan) {
    const fields = check === 'quote' ? { quoted_at: new Date(at - 60_000).toISOString(), quote_source: 'live', registrar: 'porkbun', first_year_cents: 1108, renewal_cents: 1108 }
      : check === 'availability' ? { checked_at: new Date(at - 60_000).toISOString() } : {};
    await db.insertInto('screening_results').values({
      run_id: id, item_idx: 0, domain: DOMAIN, lane: 'S3', check_id: check, gate: GATE_OF[check as keyof typeof GATE_OF], rule_ids: ['X'],
      status: o.flag && check === 'tm_us' ? 'FLAG' : 'PASS', reason_code: o.flag && check === 'tm_us' ? 'TM_GENERIC_HITS' : null, reason: null, fields: JSON.stringify(fields),
      checked_at: new Date(at - 60_000), settings_label: 'v1', list_versions: '{}', duration_ms: 0, upstream_calls: 0, source: 'auto',
    }).execute();
  }
  return id;
}
const rid = async (run: string, check: string) => Number((await db.selectFrom('screening_results').select('id').where('run_id', '=', run).where('check_id', '=', check).orderBy('id', 'desc').executeTakeFirstOrThrow()).id);
const verdict = (x: ScreeningHarness, run: string, resultId: number, v: 'PASS' | 'REJECT') => x.post(`/screening/runs/${run}/verdicts`,
  { domain: DOMAIN, check: 'tm_us', result_id: resultId, verdict: v, reason: 'generic marks only', decided_by: 'Shomer', decided_at: new Date(x.clock.t - 60_000).toISOString() });

describe('POST /screening/packs', () => {
  it('issues version 1; the same content again is 200 unchanged with no new row; a new verdict makes version 2', async () => {
    const x = await h();
    const id = await seedRun(x.clock.t, { flag: true });
    const flagId = await rid(id, 'tm_us');
    expect((await verdict(x, id, flagId, 'PASS')).statusCode).toBe(201);
    const r1 = await x.post('/screening/packs', { run_id: id, domain: DOMAIN, judgment });
    expect(r1.statusCode).toBe(201);
    expect(r1.json()).toMatchObject({ version: 1, status: 'complete', missing: [], domain: DOMAIN, run_id: id, settings_version: 'v1' });
    const r2 = await x.post('/screening/packs', { run_id: id, domain: DOMAIN, judgment });
    expect(r2.statusCode).toBe(200);
    expect(r2.json()).toMatchObject({ pack_id: r1.json().pack_id, unchanged: true });
    expect(await db.selectFrom('screening_packs').select('id').execute()).toHaveLength(1);
    expect((await verdict(x, id, flagId, 'REJECT')).statusCode).toBe(201); // the later verdict wins
    const r3 = await x.post('/screening/packs', { run_id: id, domain: DOMAIN, judgment });
    expect(r3.statusCode).toBe(201);
    expect(r3.json()).toMatchObject({ version: 2, status: 'incomplete', missing: [{ item: 'tm_us', code: 'FLAG_REJECTED' }] });
  });

  it('an incomplete pack is issued and frozen too; a pack row cannot be updated or deleted', async () => {
    const x = await h();
    const id = await seedRun(x.clock.t, { flag: true });
    const r = await x.post('/screening/packs', { run_id: id, domain: DOMAIN, judgment });
    expect(r.json()).toMatchObject({ status: 'incomplete', missing: [{ item: 'tm_us', code: 'FLAG_NO_VERDICT' }] });
    await expect(sql`UPDATE screening_packs SET status = 'complete'`.execute(db)).rejects.toThrow();
    await expect(sql`DELETE FROM screening_packs`.execute(db)).rejects.toThrow();
  });

  it('refusals: backtest, checks subset, cut plan, running run, lead_spot_check, unknown run and name, READ token', async () => {
    const x = await h();
    const bt = await seedRun(x.clock.t, { backtest: true });
    const a = await x.post('/screening/packs', { run_id: bt, domain: DOMAIN, judgment });
    expect([a.statusCode, a.json().error.code, a.json().error.details.reason]).toEqual([409, 'NOT_SCREENED_OK', 'BACKTEST']);
    const sub = await seedRun(x.clock.t, { checks: ['form'] });
    const b = await x.post('/screening/packs', { run_id: sub, domain: DOMAIN, judgment });
    expect([b.statusCode, b.json().error.code, b.json().error.details.reason]).toEqual([409, 'NOT_SCREENED_OK', 'PARTIAL_PLAN']);
    const cut = await seedRun(x.clock.t, { plan: ['form', 'brand_lists'] });
    expect((await x.post('/screening/packs', { run_id: cut, domain: DOMAIN, judgment })).json().error.details.reason).toBe('PARTIAL_PLAN');
    const running = await seedRun(x.clock.t, { status: 'running' });
    const c = await x.post('/screening/packs', { run_id: running, domain: DOMAIN, judgment });
    expect([c.statusCode, c.json().error.code, c.json().error.details.reason]).toEqual([409, 'RUN_RUNNING', 'RUNNING']);
    const ok = await seedRun(x.clock.t);
    const d = await x.post('/screening/packs', { run_id: ok, domain: DOMAIN, judgment: { ...judgment, lead_spot_check: [] } });
    expect([d.statusCode, d.json().error.code]).toEqual([422, 'VALIDATION_ERROR']);
    expect((await x.post('/screening/packs', { run_id: 'run_nope', domain: DOMAIN, judgment })).json().error.code).toBe('RUN_NOT_FOUND');
    expect((await x.post('/screening/packs', { run_id: ok, domain: 'nothere.com', judgment })).json().error.code).toBe('NAME_NOT_IN_RUN');
    const r = await issueToken('read');
    const res = await x.app.inject({ method: 'POST', url: '/screening/packs', headers: { ...r.auth, 'idempotency-key': randomUUID() }, payload: { run_id: ok, domain: DOMAIN, judgment } });
    expect(res.statusCode).toBe(403);
    expect(await db.selectFrom('screening_packs').select('id').execute()).toEqual([]);
  });

  it('a quote 25 h old at pack time is STALE_QUOTE (the clock moved between the run and the pack), and so is availability', async () => {
    const x = await h();
    const id = await seedRun(x.clock.t);
    x.clock.t += 25 * 3_600_000;
    const r = await x.post('/screening/packs', { run_id: id, domain: DOMAIN, judgment });
    expect(r.json().status).toBe('incomplete');
    expect(r.json().missing.map((m: { code: string }) => m.code).sort()).toEqual(['STALE_AVAILABILITY', 'STALE_QUOTE']);
  });

  it('a stale row (a dependency has a newer row) reads as missing, never as a pass', async () => {
    const x = await h();
    const id = await seedRun(x.clock.t);
    // a newer quote row makes the price row stale (price reads quote)
    await db.insertInto('screening_results').values({
      run_id: id, item_idx: 0, domain: DOMAIN, lane: 'S3', check_id: 'quote', gate: 'G9', rule_ids: ['X'], status: 'PASS', fields: JSON.stringify({ quoted_at: new Date(x.clock.t - 1000).toISOString(), quote_source: 'live' }),
      checked_at: new Date(x.clock.t), settings_label: 'v1', list_versions: '{}', duration_ms: 0, upstream_calls: 0, source: 'manual', recorded_by: 'g',
    }).execute();
    const r = await x.post('/screening/packs', { run_id: id, domain: DOMAIN, judgment });
    expect(r.json()).toMatchObject({ status: 'incomplete', missing: [{ item: 'price', code: 'NO_RESULT' }] });
  });
});

describe('GET /screening/packs', () => {
  it('returns the frozen content after newer results; lists versions newest first; 404 and 400 cases', async () => {
    const x = await h();
    const id = await seedRun(x.clock.t, { flag: true });
    const flagId = await rid(id, 'tm_us');
    const p1 = (await x.post('/screening/packs', { run_id: id, domain: DOMAIN, judgment })).json();
    await verdict(x, id, flagId, 'PASS');
    const p2 = (await x.post('/screening/packs', { run_id: id, domain: DOMAIN, judgment })).json();
    expect(p2.version).toBe(2);
    const g = (await x.get(`/screening/packs/${p1.pack_id}`)).json();
    expect(g).toMatchObject({ pack_id: p1.pack_id, version: 1, status: 'incomplete', content: { domain: DOMAIN, lane: 'S3', settings_version: 'v1', judgment } });
    expect(g.content.gates.find((q: { check: string }) => q.check === 'tm_us')).toMatchObject({ status: 'FLAG', verdict: null, decides: true });
    expect(g.content.quote).toMatchObject({ registrar: 'porkbun', first_year_cents: 1108 });
    const l = (await x.get(`/screening/packs?domain=${DOMAIN}`)).json();
    expect(l.packs.map((q: { version: number }) => q.version)).toEqual([2, 1]);
    const nf = await x.get('/screening/packs/pk_000000000000');
    expect([nf.statusCode, nf.json().error.code]).toEqual([404, 'PACK_NOT_FOUND']);
    const bad = await x.get('/screening/packs');
    expect([bad.statusCode, bad.json().error.code]).toEqual([400, 'VALIDATION_ERROR']);
  });
});
