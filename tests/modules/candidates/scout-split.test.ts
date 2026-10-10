// v3.3.0 part A: CR-021 (POST /candidates/screen, run links), CR-022 (A words, B bt1@v3 intake split, F-2 schema-check body), CR-023 (E rejected + run ids, F /openapi.json, G drop-feed stale settings).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { http } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { INTAKE_DAILY_MAX, IntakeScreeningJob } from '../../../src/modules/candidates/intake.js';
import { GATE_OF } from '../../../src/modules/selection/checks/index.js';
import { planFor } from '../../../src/modules/selection/engine.js';
import { splitV2OfDomain } from '../../../src/modules/selection/split-v2.js';
import { KNOWN_METHODS } from '../../../src/modules/selection/siblings.js';
import { buildWhy } from '../../../src/modules/candidates/daily-list.js';
import { testDb as db } from '../../helpers/db.js';
import { patchActiveSettings, screeningHarness, type ScreeningHarness } from '../../helpers/screening.js';
import { fixture, respond } from '../../helpers/screening-fixtures.js';
import { issueToken } from '../../helpers/tokens.js';
import { b64, makePng, textChunk } from '../../helpers/images.js';
import { introspectionAnswer } from '../../helpers/buffer-schema.js';
import { mswServer } from '../../setup/network.js';
import { seedDailyRun } from '../../helpers/db.js';
import type { RdapLookup } from '../../../src/core/rdap.js';

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());
const HOUR = 3_600_000;
const DAY = 86_400_000;
const T_FREE = (): RdapLookup => ({ outcome: 'not_registered', reasonCode: null, httpStatus: 404, url: 'https://rdap.example/domain/x', retrievedAt: new Date(), body: null, facts: null });
const T_TAKEN = (): RdapLookup => ({ outcome: 'registered', reasonCode: null, httpStatus: 200, url: 'https://rdap.example/domain/x', retrievedAt: new Date(), body: null, facts: { statuses: ['active'], registrar: 'X', created_at: null, expires_at: null, updated_at: null, nameservers: [] } as never });

async function h(opts: Parameters<typeof screeningHarness>[0] = {}): Promise<ScreeningHarness> {
  mswServer.use(http.get('https://data.iana.org/rdap/dns.json', () => respond(fixture('iana-dns.json'))));
  const x = await screeningHarness({ ...opts, screening: { rdapLookup: async () => T_FREE(), sleep: async () => {}, ...opts.screening } });
  app = x.app;
  return x;
}
async function scout(x: ScreeningHarness, name = 'scout-1') {
  const t = await issueToken('intake', name);
  const call = (method: 'GET' | 'POST', url: string, payload?: object) => (x.clock.t += 7_000, x.app.inject({ method, url, headers: { ...t.auth, 'idempotency-key': randomUUID() }, ...(payload && { payload }) }));
  return { ...t, call, intake: (names: object[]) => call('POST', '/candidates/intake', { names }) };
}
const realJob = (x: ScreeningHarness) => new IntakeScreeningJob({ db, worker: x.app.screeningWorker, now: () => x.clock.t });
const today = (x: ScreeningHarness) => new Date(x.clock.t + 3 * HOUR).toISOString().slice(0, 10);
const PREFIX = ['super', 'mega', 'smart', 'quick', 'prime'];
const SUFFIX = ['pro', 'box', 'tech', 'lab', 'hub', 'works', 'group', 'house'];
const nm = (i: number) => `${PREFIX[Math.floor(i / SUFFIX.length)]}${SUFFIX[i % SUFFIX.length]}.com`;
const intakeN = async (x: ScreeningHarness, from: number, n: number) => (await scout(x)).intake(Array.from({ length: n }, (_, k) => ({ domain: nm(from + k), lane: 'S3', source: 'scout' })));

/** A write call with a chosen Idempotency-Key. */
async function writer(x: ScreeningHarness, name = 'gavriel-screen') {
  const w = await issueToken('write', name);
  return (url: string, payload?: object, key: string = randomUUID()) => (x.clock.t += 7_000, x.app.inject({ method: 'POST', url, headers: { ...w.auth, 'idempotency-key': key }, ...(payload !== undefined && { payload }) }));
}
const settle = async (x: ScreeningHarness) => { await x.app.jobQueue.idle(); await x.app.screeningWorker.idle(); await x.app.jobQueue.idle(); };
const daily = async (x: ScreeningHarness) => (await x.get('/candidates/daily?limit=25')).json();
const everyRow = (l: any) => [...l.entries, ...l.sections.almost_ready, ...l.sections.upcoming]; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A finished full-plan run with seeded results; `fails` makes a name fail one check. Also the candidate_screenings row when `origin` is given. */
type Fail = { check: string; code: string; reason?: string; fields?: Record<string, unknown> };
async function seedRun(x: ScreeningHarness, names: { domain: string; lane?: string; fail?: Fail; onDemand?: boolean; tier?: Record<string, unknown> }[], o: { ageHours?: number; origin?: boolean; records?: boolean } = {}): Promise<string> {
  const sel = await db.selectFrom('selection_settings').select(['id', 'label', 'values']).where('label', '=', 'v1').executeTakeFirstOrThrow();
  const id = `run_${randomUUID()}`;
  const plan = planFor(sel.values as never, 'S3');
  const created = new Date(x.clock.t - (o.ageHours ?? 1) * HOUR);
  await db.insertInto('screening_runs').values({
    id, created_at: created, created_by: 'intakeScreening', mode: 'full', backtest: false, settings_id: sel.id, settings_label: 'v1', buy_hold: true, tranche_id: null,
    input: JSON.stringify({ names: names.map((n, idx) => ({ idx, domain: n.domain, lane: n.lane ?? 'S3', leads_ab: 0 })) }),
    gate_plan: JSON.stringify({ S3: plan, S4: plan, S6: plan }), list_versions: '{}', status: 'done', deadline_at: new Date(x.clock.t + HOUR), finished_at: created,
  }).execute();
  for (const [idx, n] of names.entries()) {
    for (const check of plan) {
      const failing = n.fail?.check === check;
      let fields: Record<string, unknown> = {};
      if (check === 'price') fields = { bin_cents: 148800, ratio_at_bin: 3, ratio_at_floor: 2, score_0_100: 50, floor_cents: 96700, ev_cents: 301, P_sale: 0.1, p_passive: 0.01 };
      if (check === 'quote') fields = { registrar: 'porkbun', first_year_cents: 1108, renewal_cents: 1208, quoted_at: new Date(x.clock.t - HOUR).toISOString() };
      if (check === 'tier') fields = { tier: 'A', tier_exact: true, fired: 'A', ...n.tier };
      if (failing) fields = n.fail!.fields ?? {};
      await db.insertInto('screening_results').values({
        run_id: id, item_idx: idx, domain: n.domain, lane: (n.lane ?? 'S3') as never, check_id: check, gate: GATE_OF[check as keyof typeof GATE_OF], rule_ids: ['X'], status: failing ? 'FAIL' : 'PASS', reason_code: failing ? n.fail!.code : null,
        reason: failing ? (n.fail!.reason ?? 'seeded') : null, fields: JSON.stringify(fields), checked_at: created, settings_label: 'v1', list_versions: '{}', duration_ms: 0, upstream_calls: 0, source: 'auto',
      }).execute();
    }
    if (!n.fail && o.records !== false) {
      for (const kind of ['tm_us', 'history'] as const) {
        await db.insertInto('domain_records').values({ domain: n.domain, kind, record: JSON.stringify({ seeded: true }), checked_by: 'gavriel', checked_at: new Date(x.clock.t - 2 * HOUR), created_by: 'gavriel' }).execute();
      }
    }
    if (o.origin) await db.insertInto('candidate_screenings').values({ intake_id: null, domain: n.domain, origin: 'intake', run_id: id, day: today(x), at: created, on_demand: n.onDemand ?? false }).execute();
  }
  return id;
}

describe('CR-022 A/B: scout words and the bt1@v3 intake split', () => {
  it('T22-1 T22-2 words make ukcbamcompliance.com and aievalsconsulting.com acceptable; stored, audited, shown on the list entry', async () => {
    const x = await h();
    const s = await scout(x);
    const r = await s.intake([
      { domain: 'ukcbamcompliance.com', lane: 'S6', source: 'scout', words: ['uk', 'cbam', 'compliance'] },
      { domain: 'aievalsconsulting.com', lane: 'S3', source: 'scout', words: ['ai', 'evals', 'consulting'] },
    ]);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ accepted: [{ domain: 'ukcbamcompliance.com', intake_id: expect.any(Number) }, { domain: 'aievalsconsulting.com', intake_id: expect.any(Number) }], duplicates: [], removed: [] });
    expect((await db.selectFrom('candidate_intake').select(['domain', 'words']).orderBy('id').execute())).toEqual([
      { domain: 'ukcbamcompliance.com', words: ['uk', 'cbam', 'compliance'] }, { domain: 'aievalsconsulting.com', words: ['ai', 'evals', 'consulting'] }]);
    const audit = await db.selectFrom('audit_log').select(['request', 'result_summary']).where('path', '=', '/candidates/intake').executeTakeFirstOrThrow();
    expect(JSON.stringify(audit.request)).toContain('"words":["uk","cbam","compliance"]');
    expect(audit.result_summary).toContain('ukcbamcompliance.com');
    // screened under the scout's words (the census split follows them); the list shows words + split_source
    const job = await realJob(x).runOnce();
    await x.app.screeningWorker.idle();
    const run = await db.selectFrom('screening_runs').select('input').where('id', '=', job.run_id!).executeTakeFirstOrThrow();
    expect((run.input as any).names.map((n: any) => [n.domain, n.words])).toEqual([['ukcbamcompliance.com', ['uk', 'cbam', 'compliance']], ['aievalsconsulting.com', ['ai', 'evals', 'consulting']]]); // eslint-disable-line @typescript-eslint/no-explicit-any
  }, 60_000);

  it('T22-1 T22-2 the list entry shows the scout\'s words and split_source scout (a passing name); a name without words shows the bt1@v3 split and dictionary', async () => {
    const x = await h();
    const s = await scout(x);
    await s.intake([
      { domain: 'ukcbamcompliance.com', lane: 'S6', source: 'scout', words: ['uk', 'cbam', 'compliance'] },
      { domain: 'superpro.com', lane: 'S3', source: 'scout' },
    ]);
    await seedRun(x, [{ domain: 'ukcbamcompliance.com' }, { domain: 'superpro.com' }]);
    const w = await issueToken('write');
    await x.app.inject({ method: 'POST', url: '/candidates/daily/rebuild', headers: { ...w.auth, 'idempotency-key': randomUUID() }, payload: {} });
    const l = await daily(x);
    const byDomain = Object.fromEntries(l.entries.map((e: any) => [e.domain, e])); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(byDomain['ukcbamcompliance.com']).toMatchObject({ words: ['uk', 'cbam', 'compliance'], split_source: 'scout' });
    expect(byDomain['superpro.com']).toMatchObject({ words: ['super', 'pro'], split_source: 'dictionary' });
    expect(byDomain['superpro.com']).toMatchObject({ sellers: null, sellers_verified_n: null }); // CR-023 B fields on every row
  }, 60_000);

  it('T22-8b the census sibling split of a name with scout words uses those words (sibling_tokens), not the dictionary split', async () => {
    const x = await h();
    await db.insertInto('sibling_method_approvals').values({ method: 'bt1@v3', pools_sha256: KNOWN_METHODS['bt1@v3']!.sha256, approval_text: 'seeded in a test', approval_at: new Date(x.clock.t - HOUR) }).execute();
    const s = await scout(x);
    await s.intake([{ domain: 'ukcbamcompliance.com', lane: 'S6', source: 'scout', words: ['uk', 'cbam', 'compliance'] }]);
    const job = await realJob(x).runOnce();
    expect(job.census_list).toBe('bt1@v3');
    await x.app.screeningWorker.idle();
    const c = await db.selectFrom('screening_results').select(['status', 'fields']).where('run_id', '=', job.run_id!).where('check_id', '=', 'census').executeTakeFirstOrThrow();
    expect((c.fields as any).sibling_tokens).toEqual(['uk', 'cbam', 'compliance']); // eslint-disable-line @typescript-eslint/no-explicit-any
  }, 60_000);

  it('CR-023 B the list entry shows the newest intake sellers list and sellers_verified_n from the tier check\'s sellers block', async () => {
    const x = await h();
    const s = await scout(x);
    const list = [{ name: 'Acme Roofing', url: 'https://acme-roofing.example/drones' }];
    const r = await s.intake([{ domain: 'superpro.com', lane: 'S3', source: 'scout', sellers: list }]);
    expect(r.statusCode, r.body).toBe(200);
    await seedRun(x, [{ domain: 'superpro.com', tier: { sellers: { source: 'intake', verified_n: 2, entries: [] } } }]);
    const w = await issueToken('write');
    await x.app.inject({ method: 'POST', url: '/candidates/daily/rebuild', headers: { ...w.auth, 'idempotency-key': randomUUID() }, payload: {} });
    const e = (await daily(x)).entries.find((q: any) => q.domain === 'superpro.com'); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(e).toMatchObject({ sellers: list, sellers_verified_n: 2 });
  });

  it('T22-3 words that do not join to the name are 422 VALIDATION_ERROR (index, field words) and nothing is stored; bad pieces are refused too', async () => {
    const x = await h();
    const s = await scout(x);
    const r = await s.intake([{ domain: 'superpro.com', lane: 'S3', source: 'scout' }, { domain: 'ukcbamcompliance.com', lane: 'S6', source: 'scout', words: ['uk', 'cbam'] }]);
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toMatchObject({ code: 'VALIDATION_ERROR', details: { index: 1, field: 'words' } });
    expect(await db.selectFrom('candidate_intake').select('id').execute()).toEqual([]);
    for (const words of [[], ['Uk', 'cbam', 'compliance'], ['uk', 'cbam', 'compl-iance'], ['a', 'b', 'c', 'd', 'e', 'f', 'g'], ['uk', '']]) {
      const bad = await s.intake([{ domain: 'ukcbamcompliance.com', lane: 'S6', source: 'scout', words }]);
      expect([words, bad.statusCode, bad.json().error.code]).toEqual([words, 422, 'VALIDATION_ERROR']);
    }
    expect(await db.selectFrom('candidate_intake').select('id').execute()).toEqual([]);
  });

  it('T22-4 words do not pass a name: 5 pieces are TOO_MANY_WORDS, one piece is ONE_WORD, a digit is HAS_DIGIT; the override only replaces the split', async () => {
    const x = await h();
    const s = await scout(x);
    const r = await s.intake([
      { domain: 'aabbccddee.com', lane: 'S3', source: 'scout', words: ['aa', 'bb', 'cc', 'dd', 'ee'] },
      { domain: 'xyzzyplugh.com', lane: 'S3', source: 'scout', words: ['xyzzyplugh'] },
      { domain: 'alpha1beta.com', lane: 'S3', source: 'scout', words: ['alpha1beta'] },
      { domain: 'xyzzyplugh.net', lane: 'S3', source: 'scout' },
    ]);
    expect(r.json().removed).toEqual([
      { domain: 'aabbccddee.com', reason: 'TOO_MANY_WORDS' }, { domain: 'xyzzyplugh.com', reason: 'ONE_WORD' }, { domain: 'alpha1beta.com', reason: 'HAS_DIGIT' }, { domain: 'xyzzyplugh.net', reason: 'NOT_COM' },
    ]);
    expect(r.json().accepted).toEqual([]);
  });

  it('T39-2 CR-039: with words, a digit inside a regime-list word is accepted at intake; without words or off the list it stays HAS_DIGIT', async () => {
    const x = await h();
    await db.insertInto('selection_lists').values({ name: 'regime', version: 99, terms: ['ets2', 'nis2'], created_by: 'test' }).execute();
    const s = await scout(x);
    const r = await s.intake([
      { domain: 'ets2compliance.com', lane: 'S6', source: 'scout', words: ['ets2', 'compliance'] },
      { domain: 'nis2audit.com', lane: 'S6', source: 'scout' },
      { domain: 'ets3compliance.com', lane: 'S6', source: 'scout', words: ['ets3', 'compliance'] },
    ]);
    expect(r.json().accepted.map((a: { domain: string }) => a.domain)).toEqual(['ets2compliance.com']);
    expect(r.json().removed).toEqual([{ domain: 'nis2audit.com', reason: 'HAS_DIGIT' }, { domain: 'ets3compliance.com', reason: 'HAS_DIGIT' }]);
  });

  it('T22-5 without words nothing changes: a readable name is accepted, an unreadable one is NO_SPLIT, a duplicate is a duplicate', async () => {
    const x = await h();
    const s = await scout(x);
    const r = await s.intake([{ domain: 'superpro.com', lane: 'S3', source: 'scout' }, { domain: 'xqzvkw.com', lane: 'S3', source: 'scout' }, { domain: 'superpro.com', lane: 'S3', source: 'scout' }]);
    expect(r.json()).toMatchObject({ accepted: [{ domain: 'superpro.com' }], removed: [{ domain: 'xqzvkw.com', reason: 'NO_SPLIT' }, { domain: 'superpro.com', reason: 'DUPLICATE_IN_UPLOAD' }] });
    expect((await db.selectFrom('candidate_intake').select('words').execute()).every((q) => q.words === null)).toBe(true);
    const job = await realJob(x).runOnce();
    await x.app.screeningWorker.idle();
    const run = await db.selectFrom('screening_runs').select('input').where('id', '=', job.run_id!).executeTakeFirstOrThrow();
    expect((run.input as any).names[0]).not.toHaveProperty('words'); // eslint-disable-line @typescript-eslint/no-explicit-any
  }, 60_000);

  it('T22-6 T22-7 without words the bt1@v3 split decides (real outcome): ukcbamcompliance.com reads uk|cb|am|compliance (TOO_MANY_WORDS), aievalsconsulting.com has no split (NO_SPLIT) while cbam and evals are unknown to it', async () => {
    const x = await h();
    const s = await scout(x);
    const r = await s.intake([{ domain: 'ukcbamcompliance.com', lane: 'S6', source: 'scout' }, { domain: 'aievalsconsulting.com', lane: 'S3', source: 'scout' }]);
    expect(r.json().removed).toEqual([{ domain: 'ukcbamcompliance.com', reason: 'TOO_MANY_WORDS' }, { domain: 'aievalsconsulting.com', reason: 'NO_SPLIT' }]);
    expect(splitV2OfDomain('ukcbamcompliance.com', 'bt1@v3')).toEqual(['uk', 'cb', 'am', 'compliance']);
    expect(splitV2OfDomain('aievalsconsulting.com', 'bt1@v3')).toEqual([]);
  });

  it('T22-8 one splitter, one answer: the intake word rules read a name as the bt1@v3 census split does; a scout\'s words win for that name', async () => {
    const x = await h();
    const s = await scout(x);
    for (const d of ['roofingdroneinspection.com', 'aiactauditor.com']) {
      expect((await s.intake([{ domain: d, lane: 'S4', source: 'scout' }])).json().accepted).toHaveLength(1);
    }
    const job = await realJob(x).runOnce();
    await x.app.screeningWorker.idle();
    expect(job.screened).toBe(2);
    // the census of the intake run reads the same split (its sibling tokens), when it ran
    const census = await db.selectFrom('screening_results').select(['domain', 'fields']).where('run_id', '=', job.run_id!).where('check_id', '=', 'census').execute();
    for (const c of census) {
      const tokens = (c.fields as any).sibling_tokens; // eslint-disable-line @typescript-eslint/no-explicit-any
      if (tokens) expect(tokens).toEqual(splitV2OfDomain(c.domain, 'bt1@v3'));
    }
  }, 60_000);
});
