// v3.2.0 part B (CR-018 A/B, CR-019 C-1..C-4, CR-020 A..D): resume of a cut-off intake run, summary.why, the timeout retry, leftovers, lane fit, who_chases, partial, main lanes.
import { settleJob } from '../../helpers/app.js';
import { randomUUID } from 'node:crypto';
import { http } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildWhy } from '../../../src/modules/candidates/daily-list.js';
import { INTAKE_DAILY_MAX, IntakeScreeningJob } from '../../../src/modules/candidates/intake.js';
import { GATE_OF } from '../../../src/modules/selection/checks/index.js';
import { planFor } from '../../../src/modules/selection/engine.js';
import { DEFAULT_SELECTION_VALUES } from '../../../src/modules/selection/settings.js';
import { DOMAIN, buyBody, postBuy } from '../../helpers/buy.js';
import { testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { patchActiveSettings, putList, screeningHarness, type ScreeningHarness } from '../../helpers/screening.js';
import { fixture, respond } from '../../helpers/screening-fixtures.js';
import { issueToken } from '../../helpers/tokens.js';
import type { RdapLookup } from '../../../src/core/rdap.js';
import { mswServer } from '../../setup/network.js';

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());
const DAY = 86_400_000;
const HOUR = 3_600_000;
const T_FREE = (): RdapLookup => ({ outcome: 'not_registered', reasonCode: null, httpStatus: 404, url: 'https://rdap.example/domain/x', retrievedAt: new Date(), body: null, facts: null });
const T_TIMEOUT = (): RdapLookup => ({ outcome: 'unknown', reasonCode: 'TIMEOUT', httpStatus: null, url: '', retrievedAt: new Date(), body: null, facts: null });
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
const NAMES = ['superpro', 'superbox', 'supertech', 'superhealth', 'supermedia', 'superlab', 'superhub', 'supershop', 'superworks', 'supergroup', 'superhouse', 'superstore', 'megapro', 'megatech', 'megahealth', 'megamedia', 'megalab', 'megahub',
  'megaworks', 'megagroup', 'megahouse', 'smartpro', 'smartbox', 'smarttech', 'smarthealth', 'smartmedia', 'smartlab', 'smarthub', 'smartshop', 'smartworks', 'smartgroup', 'smarthouse', 'smartstore', 'quickpro', 'quickbox'];
const nm = (i: number) => `${NAMES[i]}.com`;

type Outcome = 'pass' | 'taken' | 'form' | 'timeout';
interface Seed { domain: string; outcome?: Outcome; origin?: 'intake' | 'drop_list'; records?: boolean }
/** A full-plan run on the seeded settings with every planned check seeded (one name = one outcome); `origin` also writes the candidate_screenings row. */
async function seedRun(x: ScreeningHarness, names: Seed[], o: { status?: 'done' | 'partial' | 'running'; ageHours?: number } = {}): Promise<string> {
  const sel = await db.selectFrom('selection_settings').select(['id', 'label', 'values']).where('label', '=', 'v1').executeTakeFirstOrThrow();
  const id = `run_${randomUUID()}`;
  const plan = planFor(sel.values as never, 'S3');
  const created = new Date(x.clock.t - (o.ageHours ?? 1) * HOUR);
  const status = o.status ?? 'done';
  await db.insertInto('screening_runs').values({
    id, created_at: created, created_by: 'intakeScreening', mode: 'full', backtest: false, settings_id: sel.id, settings_label: 'v1', buy_hold: true, tranche_id: null,
    input: JSON.stringify({ names: names.map((n, idx) => ({ idx, domain: n.domain, lane: 'S3', leads_ab: 0 })) }),
    gate_plan: JSON.stringify({ S3: plan }), list_versions: '{}', status, deadline_at: new Date(x.clock.t + HOUR), finished_at: status === 'running' ? null : created,
  }).execute();
  for (const [idx, n] of names.entries()) {
    const outcome = n.outcome ?? 'pass';
    for (const check of plan) {
      let st: 'PASS' | 'FAIL' | 'UNKNOWN' = 'PASS';
      let code: string | null = null;
      let fields: Record<string, unknown> = {};
      if (outcome === 'taken' && check === 'availability') { st = 'FAIL'; code = 'REGISTERED'; }
      if (outcome === 'form' && check === 'form') { st = 'FAIL'; code = 'UNKNOWN_TOKEN'; }
      if (outcome === 'timeout' && check === 'availability') { st = 'UNKNOWN'; code = 'TIMEOUT'; }
      if (check === 'price') fields = { bin_cents: 148800, ratio_at_bin: 3, ratio_at_floor: 2, score_0_100: 50, floor_cents: 96700, walkaway_cents: 71500 };
      if (check === 'quote') fields = { registrar: 'porkbun', first_year_cents: 1108, renewal_cents: 1208, quoted_at: new Date(x.clock.t - HOUR).toISOString() };
      if (check === 'tier') fields = { tier: 'A', tier_exact: true, fired: 'A' };
      await db.insertInto('screening_results').values({
        run_id: id, item_idx: idx, domain: n.domain, lane: 'S3', check_id: check, gate: GATE_OF[check as keyof typeof GATE_OF], rule_ids: ['X'], status: st, reason_code: code, reason: code ? 'seeded' : null,
        fields: JSON.stringify(fields), checked_at: created, settings_label: 'v1', list_versions: '{}', duration_ms: 0, upstream_calls: 0, source: 'auto',
      }).execute();
    }
    if (outcome === 'pass' && n.records !== false) {
      for (const kind of ['tm_us', 'history'] as const) {
        await db.insertInto('domain_records').values({ domain: n.domain, kind, record: JSON.stringify({ seeded: true }), checked_by: 'gavriel', checked_at: new Date(x.clock.t - 2 * HOUR), created_by: 'gavriel' }).execute();
      }
    }
    if (n.origin) await db.insertInto('candidate_screenings').values({ intake_id: null, domain: n.domain, origin: n.origin, run_id: id, day: today(x), at: created }).execute();
  }
  return id;
}

/** A drop list with, per name, the registry checks it has had, in order: [status, expected_drop_date]. */
async function dropList(x: ScreeningHarness, name: string, entries: { domain: string; checks: [string, string | null][]; kept?: boolean }[], ageDays = 0): Promise<void> {
  await db.insertInto('drop_lists').values({ name, list_date: today(x), created_by: 'scout-1', received_n: entries.length, kept_n: entries.length }).execute();
  await db.insertInto('drop_list_rows').values(entries.map((e) => ({ list_name: name, domain: e.domain, kept: e.kept ?? true, reason: null, tokens: ['drop', 'x'] }))).execute();
  let i = 0;
  for (const e of entries) {
    for (const [status, d] of e.checks) {
      await db.insertInto('drop_list_checks').values({ list_name: name, domain: e.domain, checked_at: new Date(x.clock.t - ageDays * DAY - (1000 - i++) * 1000), status: status as never, last_changed: null, expected_drop_date: d, drop_date_source: d ? 'estimate' : null, reason_code: null }).execute();
    }
  }
}
const ymd = (x: ScreeningHarness, plusDays: number) => new Date(x.clock.t + 3 * HOUR + plusDays * DAY).toISOString().slice(0, 10);
const rebuild = (x: ScreeningHarness) => x.post('/candidates/daily/rebuild', {});
const daily = async (x: ScreeningHarness) => (await x.get('/candidates/daily?limit=25')).json();
/** Lists so the lane names below read as: S2 city+trade, S4 tech+trade, S6 regime. */
async function lanes(): Promise<void> {
  await putList('trade', ['roofing', 'plumbing', 'restaurant', 'consultants', 'declarants'], 2);
  await putList('tech', ['voice', 'agent'], 2);
  await putList('regime', ['cbam', 'gdpr'], 2);
  await putList('dictionary_extra', ['declarants'], 2);
}
const LEFTOVER: [string, string | null][] = [['pending_delete', '__E__'], ['not_registered', null]];
const leftover = (x: ScreeningHarness, domain: string) => ({ domain, checks: LEFTOVER.map(([s, d]) => [s, d === '__E__' ? ymd(x, -1) : d] as [string, string | null]) });

describe('CR-020 A: lane fit', () => {
  it('T20-1 only the drop-list names that fit S2, S4 or S6 are screened, each under its lane; the generic ones show NO_KEPT_LANE on GET /selection/drop-lists/{name}', async () => {
    const x = await h();
    await lanes();
    const names = ['phoenixroofing', 'restaurantvoiceagent', 'cbamdeclarants', 'happyhouse', 'bluesky', 'bigdeal'].map((n) => `${n}.com`);
    await dropList(x, 'dl-20', names.map((n) => leftover(x, n)));
    const view = (await x.get('/selection/drop-lists/dl-20')).json();
    const screening = Object.fromEntries(view.rows.map((r: { domain: string; screening: object }) => [r.domain, r.screening]));
    expect(screening).toEqual({
      'phoenixroofing.com': { lane: 'S2', reason: null }, 'restaurantvoiceagent.com': { lane: 'S4', reason: null }, 'cbamdeclarants.com': { lane: 'S6', reason: null },
      'happyhouse.com': { lane: null, reason: 'NO_KEPT_LANE' }, 'bluesky.com': { lane: null, reason: 'NO_KEPT_LANE' }, 'bigdeal.com': { lane: null, reason: 'NO_KEPT_LANE' },
    });
    const r = await realJob(x).runOnce();
    expect(r).toMatchObject({ screened: 3, from_drop_lists: 3, no_kept_lane: 3 });
    const run = await db.selectFrom('screening_runs').select('input').where('id', '=', r.run_id!).executeTakeFirstOrThrow();
    expect((run.input as { names: { domain: string; lane: string }[] }).names.map((n) => [n.domain, n.lane])).toEqual([['cbamdeclarants.com', 'S6'], ['phoenixroofing.com', 'S2'], ['restaurantvoiceagent.com', 'S4']]); // oldest drop first, then by name
    expect((await db.selectFrom('candidate_screenings').select('origin').execute()).every((c) => c.origin === 'drop_list')).toBe(true);
    await x.app.screeningWorker.idle();
  }, 60_000);

  it.each([[undefined, 30, 0], [0.3, 21, 9]])('T20-2 30 scout names and 30 eligible drop-list names, share %s: %i scout + %i drop-list names are screened', async (share, nScout, nDrop) => {
    const cities = ['akron', 'albany', 'austin', 'boise', 'boston', 'dallas', 'denver', 'dublin', 'eugene', 'fargo', 'fresno', 'miami', 'omaha', 'paris', 'perth', 'plano', 'salem', 'tampa', 'tulsa', 'toledo', 'topeka', 'tucson',
      'dayton', 'laredo', 'lincoln', 'madison', 'memphis', 'newark', 'norfolk', 'olympia', 'oxnard', 'peoria', 'raleigh', 'tacoma', 'wichita', 'worcester', 'yonkers', 'houston', 'jackson'];
    const droppers = cities.map((c) => `${c}roofing.com`);
    const x = await h();
    await lanes();
    if (share !== undefined) await patchActiveSettings(['intake'], { drop_list_max_share: share });
    const s = await scout(x);
    for (let i = 0; i < 30; i += 5) await s.intake(Array.from({ length: 5 }, (_, k) => ({ domain: nm(i + k), lane: 'S3', source: 'bulk' })));
    await dropList(x, 'dl-30', droppers.map((d) => leftover(x, d)));
    const r = await realJob(x).runOnce();
    expect(r.leftovers).toBeGreaterThanOrEqual(30);
    expect(r.screened).toBe(INTAKE_DAILY_MAX);
    expect([r.from_intake, r.from_drop_lists]).toEqual([nScout, nDrop]);
    await x.app.screeningWorker.idle();
  }, 120_000);

  it('T20-3 the daily summary counts the NO_KEPT_LANE names and the why says so', async () => {
    const x = await h();
    await lanes();
    await dropList(x, 'dl-3', ['phoenixroofing', 'happyhouse', 'bluesky'].map((n) => leftover(x, `${n}.com`)));
    await rebuild(x);
    const l = await daily(x);
    expect(l.summary).toMatchObject({ leftovers_n: 3, no_kept_lane_n: 2 });
    expect(l.summary.why).toContain('2 names from the drop lists were skipped because they fit no kept lane.');
  });
});
