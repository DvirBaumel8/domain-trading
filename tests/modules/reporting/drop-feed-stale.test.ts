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

describe('CR-023 G: DROP_FEED_STALE settings', () => {
  const report = async (x: ScreeningHarness) => (await x.get('/report')).json();
  const stale = (r: any) => (r.warnings as any[]).filter((w) => w.code === 'DROP_FEED_STALE'); // eslint-disable-line @typescript-eslint/no-explicit-any
  async function listAged(x: ScreeningHarness, days: number) {
    await seedDailyRun(db, x.clock.t);
    const d = new Date(x.clock.t + 3 * HOUR - days * DAY).toISOString().slice(0, 10);
    await db.insertInto('drop_lists').values({ name: 'dl-old', list_date: d, created_by: 'scout-1', received_n: 1, kept_n: 1 }).execute();
  }

  it('AC-10 with defaults: a list 3 days old shows nothing', async () => {
    const x = await h();
    await listAged(x, 3);
    expect(stale(await report(x))).toEqual([]);
  });

  it('AC-10 at 8 days it shows DROP_FEED_STALE at level info (no warning counted)', async () => {
    const x = await h();
    await listAged(x, 8);
    const w = stale(await report(x));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ level: 'info', details: { newest_list: 'dl-old' } });
  });

  it('AC-10 days 2 + level warn restores the old behaviour: 3 days old is a warn', async () => {
    const x = await h();
    await patchActiveSettings(['intake'], { drop_list_max_share: 1, drop_feed_stale_days: 2, drop_feed_stale_level: 'warn' });
    await listAged(x, 3);
    const w = stale(await report(x));
    expect(w).toHaveLength(1);
    expect(w[0].level).toBe('warn');
  });
});
