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

describe('CR-022 F-2: POST /posts/schema-check takes a post body', () => {
  const KEY = 'buf_fake_key_0123456789abcdefABCDEF';
  async function boot() {
    const calls: string[] = [];
    mswServer.use(http.post('https://api.buffer.com', async ({ request }) => {
      const body = (await request.json()) as { query: string; variables: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
      calls.push(body.query.includes('__type(') ? 'schema' : 'other');
      return introspectionAnswer(body.variables.name);
    }));
    const { makeApp } = await import('../../helpers/app.js');
    const a = await makeApp({ now: () => Date.parse('2026-10-20T10:00:00Z'), env: { BUFFER_API_KEY: KEY }, testRoutes: false });
    app = a;
    const w = (await issueToken('write', 'gavriel-write')).auth;
    return { a, calls, post: (payload?: object) => a.inject({ method: 'POST', url: '/posts/schema-check', headers: { ...w, 'idempotency-key': randomUUID() }, ...(payload !== undefined && { payload }) }) };
  }

  it('T22-10 a real post body (a big image) is checked, not refused 413; nothing is stored or published; an empty body is the fixed sample', async () => {
    const t = await boot();
    const big = b64(makePng(16, 16, [textChunk('Comment', 'x'.repeat(150_000))])); // base64 well over the default 64 KB body limit (the text chunk is stripped by the image checks)
    expect(big.length).toBeGreaterThan(100_000);
    const r = await t.post({ text: 'Hello', images: [{ data_base64: big, alt: 'A grey square' }] });
    expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, problems: [], checked: 'post' });
    expect(await db.selectFrom('posts').select('id').execute()).toEqual([]);
    expect(await db.selectFrom('post_images').select('id').execute()).toEqual([]);
    expect(new Set(t.calls)).toEqual(new Set(['schema']));
    for (const empty of [undefined, {}]) expect((await t.post(empty)).json()).toMatchObject({ ok: true, checked: 'sample' });
  });

  it('T22-10 the post is validated like POST /posts (blank text, too long, a bad image are the same 422/400 errors); an unknown field is refused', async () => {
    const t = await boot();
    expect((await t.post({ text: 'x'.repeat(400) })).json().error.code).toBe('POST_TOO_LONG');
    expect((await t.post({ text: 'ok', images: [{ data_base64: 'AAAA', alt: 'bad' }] })).json().error.code).toBe('POST_INVALID');
    expect((await t.post({ text: 'ok', nope: 1 })).statusCode).toBe(422);
  });

  it('a problem in the input DOM builds for that post shows (the live schema mock refuses the thread part\'s field)', async () => {
    const t = await boot();
    const r = await t.post({ text: 'Hello', thread: [{ text: 'Part two' }] });
    expect(r.json()).toMatchObject({ ok: true, checked: 'post' });
  });
});
