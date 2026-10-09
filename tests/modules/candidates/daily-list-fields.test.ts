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

describe('CR-020 B: who_chases', () => {
  const WHO = 'Bulk investors chase AI + word brandables; nobody researches restaurant voice-agent vendors for an $11 name.';
  it('T20-4 accepted, stored with the intake row, shown on the daily entry (and on almost_ready rows); the newest intake that carries one wins', async () => {
    const x = await h();
    const s = await scout(x);
    const r = await s.intake([{ domain: 'goodone.com', lane: 'S3', source: 'scout', who_chases: WHO }, { domain: 'norecords.com', lane: 'S3', source: 'scout', who_chases: 'first line' }]);
    expect(r.statusCode, r.body).toBe(200);
    expect((await db.selectFrom('candidate_intake').select('who_chases').orderBy('id').execute()).map((q) => q.who_chases)).toEqual([WHO, 'first line']);
    await s.intake([{ domain: 'norecords.com', lane: 'S3', source: 'scout-2', who_chases: 'second line' }, { domain: 'goodone.com', lane: 'S3', source: 'scout-3' }]);
    await seedRun(x, [{ domain: 'goodone.com' }, { domain: 'norecords.com', records: false }]);
    await rebuild(x);
    const l = await daily(x);
    expect(l.entries.find((e: { domain: string }) => e.domain === 'goodone.com').who_chases).toBe(WHO);
    expect(l.sections.almost_ready.find((e: { domain: string }) => e.domain === 'norecords.com').who_chases).toBe('second line');
  });

  it('T20-5 an email address in who_chases is 422 NO_PII and stores nothing; 301 characters is 422 VALIDATION_ERROR', async () => {
    const x = await h();
    const s = await scout(x);
    const pii = await s.intake([{ domain: 'goodone.com', lane: 'S3', source: 'scout', who_chases: 'ask bob@example.com' }]);
    expect([pii.statusCode, pii.json().error.code, pii.json().error.details]).toEqual([422, 'NO_PII', { index: 0, field: 'who_chases' }]);
    const long = await s.intake([{ domain: 'goodone.com', lane: 'S3', source: 'scout', who_chases: 'x'.repeat(301) }]);
    expect([long.statusCode, long.json().error.code]).toEqual([422, 'VALIDATION_ERROR']);
    expect(await db.selectFrom('candidate_intake').select('id').execute()).toHaveLength(0);
    const edge = await s.intake([{ domain: 'goodone.com', lane: 'S3', source: 'scout', who_chases: 'x'.repeat(300) }]);
    expect(edge.statusCode).toBe(200);
  });

  it('T20-6 an intake without who_chases works as before and the entry shows null', async () => {
    const x = await h();
    const s = await scout(x);
    expect((await s.intake([{ domain: 'goodone.com', lane: 'S3', source: 'scout' }])).statusCode).toBe(200);
    await seedRun(x, [{ domain: 'goodone.com' }]);
    await rebuild(x);
    expect((await daily(x)).entries[0]).toMatchObject({ domain: 'goodone.com', who_chases: null });
  });
});

describe('CR-020 C: partial', () => {
  it('T20-7 after a run that finished and a rebuild, summary.partial is false (also with a stale running status of another day)', async () => {
    const x = await h();
    await seedRun(x, [{ domain: 'slowone.com', outcome: 'timeout', origin: 'intake' }], { status: 'partial' });
    await rebuild(x);
    const l = await daily(x);
    expect(l.summary).toMatchObject({ partial: false, screening_ended_partial: true, timeout_n: 1 });
  });

  it('T20-8 a run that hit its deadline with N TIMEOUT names: screening_ended_partial and timeout_n; partial follows only a run still running', async () => {
    const x = await h();
    await seedRun(x, [{ domain: 'slowone.com', outcome: 'timeout', origin: 'intake' }, { domain: 'slowtwo.com', outcome: 'timeout', origin: 'intake' }, { domain: 'okname.com', origin: 'intake' }], { status: 'partial' });
    await rebuild(x);
    expect((await daily(x)).summary).toMatchObject({ partial: false, screening_ended_partial: true, timeout_n: 2 });
    expect((await daily(x)).summary.why).toContain('The screening run ran out of time before every name was checked.');
    const running = await seedRun(x, [{ domain: 'stillgoing.com', origin: 'intake' }], { status: 'running' });
    await rebuild(x);
    expect((await daily(x)).summary).toMatchObject({ partial: true });
    await db.updateTable('screening_runs').set({ status: 'done', finished_at: new Date(x.clock.t) }).where('id', '=', running).execute();
    await rebuild(x);
    expect((await daily(x)).summary).toMatchObject({ partial: false });
  });
});
