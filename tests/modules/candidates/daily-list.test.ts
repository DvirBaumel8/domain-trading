// v2.14.0 (CR-012 parts B and C): the intake scope and route, the daily intake screening, the daily candidate list.
import { settleJob } from '../../helpers/app.js';
import { randomUUID } from 'node:crypto';
import { http } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { BuildDailyListJob } from '../../../src/modules/candidates/daily-list.js';
import { GATE_OF } from '../../../src/modules/selection/checks/index.js';
import { planFor } from '../../../src/modules/selection/engine.js';
import { INTAKE_DAILY_MAX, INTAKE_DEDUPE_DAYS, IntakeScreeningJob, intakeCensusList } from '../../../src/modules/candidates/intake.js';
import type { ScreeningWorker } from '../../../src/modules/selection/engine.js';
import { insertOwnedDomain, testDb as db } from '../../helpers/db.js';
import { putList, screeningHarness, type ScreeningHarness } from '../../helpers/screening.js';
import { fixture, respond } from '../../helpers/screening-fixtures.js';
import { issueToken } from '../../helpers/tokens.js';
import type { RdapLookup } from '../../../src/core/rdap.js';
import { mswServer } from '../../setup/network.js';

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());
const DAY = 86_400_000;
const HOUR = 3_600_000;
const free = (): RdapLookup => ({ outcome: 'not_registered', reasonCode: null, httpStatus: 404, url: 'https://rdap.example/domain/x', retrievedAt: new Date(), body: null, facts: null });
async function h(): Promise<ScreeningHarness> {
  mswServer.use(http.get('https://data.iana.org/rdap/dns.json', () => respond(fixture('iana-dns.json'))));
  const x = await screeningHarness({ screening: { rdapLookup: async () => free() } });
  app = x.app;
  return x;
}
/** A job that records its run but never executes it (the screening itself is covered elsewhere); `runToEnd` resolves at once. */
const fakeWorker = (x: ScreeningHarness, kicked: string[] = []): ScreeningWorker => ({ checks: x.app.screeningWorker.checks, kick: (id: string) => { kicked.push(id); }, runToEnd: async () => {} }) as unknown as ScreeningWorker;
const intakeJob = (x: ScreeningHarness, kicked: string[] = []) => new IntakeScreeningJob({ db, worker: fakeWorker(x, kicked), now: () => x.clock.t });
const ap = (x: ScreeningHarness, text: string) => ({ text, approved_at: new Date(x.clock.t - 3_600_000).toISOString() });
// two-word names (the intake word rules need a reading of 2 or 3 words by the bt1@v2 split)
const NAMES = ['superpro', 'superbox', 'supertech', 'superhealth', 'supermedia', 'superlab', 'superhub', 'supershop', 'superworks', 'supergroup', 'superhouse', 'superstore', 'megapro', 'megatech', 'megahealth', 'megamedia', 'megalab', 'megahub',
  'megaworks', 'megagroup', 'megahouse', 'smartpro', 'smartbox', 'smarttech', 'smarthealth', 'smartmedia', 'smartlab', 'smarthub', 'smartshop', 'smartworks', 'smartgroup', 'smarthouse', 'smartstore', 'quickpro', 'quickbox'];
const nm = (i: number) => `${NAMES[i]}.com`;
const COMPS = [
  { domain: 'alpha.com', price_usd: 1200, sold_on: '2026-01-05', venue: 'Afternic', source_url: 'https://example.com/a' },
  { domain: 'beta.com', price_usd: 900, sold_on: '2026-02-05', venue: 'Sedo', source_url: 'https://example.com/b' },
];

async function scout(x: ScreeningHarness, name = 'scout-1') {
  const t = await issueToken('intake', name);
  const call = (method: 'GET' | 'POST', url: string, payload?: object) => (x.clock.t += 7_000, x.app.inject({ method, url, headers: { ...t.auth, 'idempotency-key': randomUUID() }, ...(payload && { payload }) }));
  return { ...t, call, intake: (names: object[]) => call('POST', '/candidates/intake', { names }) };
}
const queuedRows = () => db.selectFrom('candidate_intake').selectAll().orderBy('id').execute();

interface Seed {
  domain: string; lane?: 'S3' | 'S7'; ratio?: number; score?: number; exact?: boolean; fail?: boolean; unknownPrice?: boolean; noRecords?: boolean; registrar?: string;
  ageHours?: number; records?: boolean; first_year_cents?: number;
}
/** A finished full-plan run on settings v1 (hold on), every planned check seeded; `records` writes fresh tm_us and history domain records. */
async function seedRun(x: ScreeningHarness, names: Seed[]): Promise<string> {
  const sel = await db.selectFrom('selection_settings').select(['id', 'label', 'values']).where('label', '=', 'v1').executeTakeFirstOrThrow();
  const id = `run_${randomUUID()}`;
  const gate_plan: Record<string, string[]> = {};
  for (const n of names) gate_plan[n.lane ?? 'S3'] ??= planFor(sel.values as never, n.lane ?? 'S3');
  const created = new Date(x.clock.t - (names[0]?.ageHours ?? 1) * HOUR);
  await db.insertInto('screening_runs').values({
    id, created_at: created, created_by: 'test', mode: 'full', backtest: false, settings_id: sel.id, settings_label: 'v1', buy_hold: true, tranche_id: null,
    input: JSON.stringify({ names: names.map((n, idx) => ({ idx, domain: n.domain, lane: n.lane ?? 'S3', leads_ab: 0 })) }),
    gate_plan: JSON.stringify(gate_plan), list_versions: '{}', status: 'done', deadline_at: new Date(x.clock.t + 3_600_000), finished_at: created,
  }).execute();
  for (const [idx, n] of names.entries()) {
    const lane = n.lane ?? 'S3';
    for (const [i, check] of gate_plan[lane]!.entries()) {
      let status: 'PASS' | 'FAIL' | 'FLAG' | 'UNKNOWN' | 'MANUAL_REQUIRED' = 'PASS';
      let reason_code: string | null = null;
      let fields: Record<string, unknown> = {};
      if (n.fail && i === 1) { status = 'FAIL'; reason_code = 'BRAND_HIT'; }
      if (check === 'tm_us' || check === 'history') { if (n.noRecords) { status = 'MANUAL_REQUIRED'; reason_code = 'MANUAL_SOURCE'; } }
      if (check === 'price') {
        fields = { bin_cents: 148800, ratio_at_bin: (n.ratio ?? 2) + 1, ratio_at_floor: n.ratio ?? 2, score_0_100: n.score ?? 50, floor_cents: 96700, walkaway_cents: 71500 };
        if (n.unknownPrice) { status = 'UNKNOWN'; reason_code = 'NO_QUOTE'; }
      }
      if (check === 'quote') fields = { registrar: n.registrar ?? 'porkbun', first_year_cents: n.first_year_cents ?? 1108, renewal_cents: 1208, quoted_at: new Date(x.clock.t - HOUR).toISOString() };
      if (check === 'tier') fields = { tier: 'A', tier_exact: n.exact !== false, fired: 'A' };
      if (check === 'tm_us' && status === 'PASS' && n.domain.startsWith('flag')) { status = 'FLAG'; reason_code = 'TM_GENERIC_HITS'; }
      await db.insertInto('screening_results').values({
        run_id: id, item_idx: idx, domain: n.domain, lane, check_id: check, gate: GATE_OF[check as keyof typeof GATE_OF], rule_ids: ['X'], status, reason_code, reason: reason_code ? 'seeded' : null,
        fields: JSON.stringify(fields), checked_at: created, settings_label: 'v1', list_versions: '{}', duration_ms: 0, upstream_calls: 0, source: 'auto',
      }).execute();
    }
    if (n.records !== false && !n.noRecords) {
      for (const kind of ['tm_us', 'history'] as const) {
        await db.insertInto('domain_records').values({ domain: n.domain, kind, record: JSON.stringify({ seeded: true }), checked_by: 'gavriel', checked_at: new Date(x.clock.t - 2 * HOUR), created_by: 'gavriel' }).execute();
      }
    }
  }
  return id;
}
const build = (x: ScreeningHarness) => new BuildDailyListJob({ db, worker: fakeWorker(x), now: () => x.clock.t }).runOnce();

describe('daily candidate list (CR-012 T12-7..T12-13)', () => {
  it('V214-8 not built yet: 200 with empty entries and summary not_built; built with nothing: the day funnel, never padded', async () => {
    const x = await h();
    const r = await x.get('/candidates/daily');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ date: '2026-10-06', built_at: null, entries: [], sections: { almost_ready: [], upcoming: [] }, summary: { not_built: true } });
    expect(await build(x)).toMatchObject({ day: '2026-10-06', entries_n: 0, partial: false, version: 1 });
    const e = (await x.get('/candidates/daily?date=2026-10-06')).json();
    expect(e.entries).toEqual([]);
    expect(e.summary).toMatchObject({ screened_today: 0, failed_by_check: {}, waiting_for_records: 0, unknown_by_reason: {}, partial: false });
    expect(e.summary.not_built).toBeUndefined();
    expect((await x.get('/candidates/daily?date=2026-10-05')).json().summary).toEqual({ not_built: true });
    for (const bad of ['?limit=26', '?limit=0', '?date=yesterday', '?foo=1']) expect((await x.get(`/candidates/daily${bad}`)).statusCode).toBe(400);
  });

  it('V214-9 ranking: exact tier first, then ratio at the floor, then score, then arrival; held true while the hold is on; would_be_blocked from the /buy gates; no walk-away anywhere', async () => {
    const x = await h();
    const s = await scout(x);
    await seedRun(x, [
      { domain: 'alphaone.com', ratio: 2, score: 50 }, { domain: 'alphatwo.com', ratio: 3, score: 40 }, { domain: 'alphathree.com', ratio: 3, score: 60 },
      { domain: 'alphafour.com', ratio: 9, score: 99, exact: false }, { domain: 'alphafive.com', ratio: 2, score: 50 },
    ]);
    // equal ratio and score: the earlier arrival ranks first (alphafive arrived before alphaone)
    await s.intake([{ domain: 'alphafive.com', lane: 'S3', source: 'first' }]);
    x.clock.t += 60_000;
    await s.intake([{ domain: 'alphaone.com', lane: 'S3', source: 'second', comps: COMPS }]);
    await build(x);
    const res = await x.get('/candidates/daily?limit=25');
    const list = res.json();
    expect(list.entries.map((e: any) => [e.rank, e.domain])).toEqual([[1, 'alphathree.com'], [2, 'alphatwo.com'], [3, 'alphafive.com'], [4, 'alphaone.com'], [5, 'alphafour.com']]);
    const one = list.entries.find((e: any) => e.domain === 'alphaone.com');
    expect(one).toMatchObject({
      lane: 'S3', held: true, final_status: 'would_buy', settings_version: 'v1', run_id: expect.stringMatching(/^run_/),
      sources: [{ source: 'second', token_name: 'scout-1', received_at: expect.any(String) }], comps: COMPS,
      price: { registrar: 'porkbun', first_year_cents: 1108, first_year: '$11.08', renewal_cents: 1208, quoted_at: expect.any(String) },
      plan: { bin_cents: 148800, floor_cents: 96500, min_offer_cents: 10000 }, why: { tier: 'A', tier_exact: true, clause: 'A', ratio_at_floor: 2, ratio_at_bin: 3 },
      dates: { expiry_or_drop: null, buyable_from: '2026-10-06' },
      records: { tm_us: { result: 'PASS', checked_by: 'gavriel', source: 'domain_record' }, history: { result: 'PASS', checked_by: 'gavriel' } },
    });
    expect(one.checks.map((c: any) => c.check)).toContain('price');
    expect(one.would_be_blocked).toEqual(['BUY_HOLD', 'SCREENING_PACK_REQUIRED', 'NO_TRANCHE']);
    expect(list.entries.find((e: any) => e.domain === 'alphafour.com').why.tier_exact).toBe(false);
    expect(res.body.toLowerCase()).not.toContain('walkaway');
    expect(res.body.toLowerCase()).not.toContain('walk_away');
    // limit applies on read
    const two = (await x.get('/candidates/daily?limit=2')).json();
    expect(two.entries.map((e: any) => e.domain)).toEqual(['alphathree.com', 'alphatwo.com']);
    expect((await x.get('/candidates/daily')).json().entries).toHaveLength(5); // default 10, only 5 exist: never padded
  });

  it('V214-10 exclusions: a FAIL, a gating UNKNOWN, a stale run (over 72 h), an owned name; missing records go to almost_ready; the summary counts them', async () => {
    const x = await h();
    await seedRun(x, [{ domain: 'goodname.com' }, { domain: 'failname.com', fail: true }, { domain: 'unkname.com', unknownPrice: true }, { domain: 'ownedone.com' }, { domain: 'norecords.com', noRecords: true }]);
    await seedRun(x, [{ domain: 'oldname.com', ageHours: 73 }]);
    await insertOwnedDomain(db, { domain: 'ownedone.com' });
    // a name whose run row says PASS but whose records are not kept: also almost ready (the records are the gate)
    await seedRun(x, [{ domain: 'bareone.com', records: false }]);
    await build(x);
    const l = (await x.get('/candidates/daily')).json();
    expect(l.entries.map((e: any) => e.domain)).toEqual(['goodname.com']);
    expect(l.sections.almost_ready.map((a: any) => a.domain).sort()).toEqual(['bareone.com', 'norecords.com']);
    expect(l.sections.almost_ready.find((a: any) => a.domain === 'norecords.com').missing).toEqual([{ kind: 'tm_us', reason: 'NO_RECORD' }, { kind: 'history', reason: 'NO_RECORD' }]);
    expect(l.sections.almost_ready.find((a: any) => a.domain === 'bareone.com').missing).toEqual([{ kind: 'tm_us', reason: 'NO_RECORD' }, { kind: 'history', reason: 'NO_RECORD' }]);
    expect(l.summary).toMatchObject({ failed_by_check: { brand_lists: 1 }, waiting_for_records: 2, unknown_by_reason: { NO_QUOTE: 1 }, partial: false });
    // a stale record is missing, with the reason
    await db.insertInto('domain_records').values({ domain: 'norecords.com', kind: 'tm_us', record: JSON.stringify({}), checked_by: 'gavriel', checked_at: new Date(x.clock.t - 40 * DAY), created_by: 'gavriel' }).execute();
    await build(x);
    expect((await x.get('/candidates/daily')).json().sections.almost_ready.find((a: any) => a.domain === 'norecords.com').missing[0]).toEqual({ kind: 'tm_us', reason: 'STALE' });
  });

  it('V214-11 upcoming: a drop name still registered, expected to drop within 7 days, that passed everything else; a later drop is not upcoming', async () => {
    const x = await h();
    await seedRun(x, [{ domain: 'dropsoon.com' }, { domain: 'droplater.com' }]);
    // turn the availability row of both into REGISTERED fails and their price/quote into UNKNOWN (what a registered name gives)
    for (const d of ['dropsoon.com', 'droplater.com']) {
      await db.connection().execute(async (conn) => {
        const { sql } = await import('kysely');
        await sql`SET session_replication_role = replica`.execute(conn);
        await sql`UPDATE screening_results SET status = 'FAIL', reason_code = 'REGISTERED' WHERE domain = ${d} AND check_id = 'availability'`.execute(conn);
        await sql`UPDATE screening_results SET status = 'UNKNOWN', reason_code = 'NO_QUOTE' WHERE domain = ${d} AND check_id IN ('quote', 'price')`.execute(conn);
        await sql`SET session_replication_role = origin`.execute(conn);
      });
    }
    await db.insertInto('drop_lists').values({ name: 'dl-up', list_date: '2026-10-06', created_by: 'scout-1', received_n: 2, kept_n: 2 }).execute();
    await db.insertInto('drop_list_rows').values(['dropsoon.com', 'droplater.com'].map((domain) => ({ list_name: 'dl-up', domain, kept: true, reason: null, tokens: ['drop', 'x'] }))).execute();
    await db.insertInto('drop_list_checks').values([['dropsoon.com', '2026-10-09'], ['droplater.com', '2026-10-20']].map(([domain, d]) => ({ list_name: 'dl-up', domain: domain!, checked_at: new Date(x.clock.t), status: 'pending_delete' as const, last_changed: null, expected_drop_date: d!, drop_date_source: 'estimate', reason_code: null }))).execute();
    await build(x);
    const l = (await x.get('/candidates/daily')).json();
    expect(l.entries).toEqual([]);
    expect(l.sections.upcoming).toHaveLength(1);
    expect(l.sections.upcoming[0]).toMatchObject({ domain: 'dropsoon.com', expected_drop_date: '2026-10-09', buyable_from: '2026-10-09', list_name: 'dl-up', missing_records: [], sources: [{ source: 'dl-up', token_name: 'scout-1' }] });
    // v3.2.0 (CR-019 C-3): a name in pending delete is dropping, not taken
    expect(l.summary.failed_by_check).toEqual({});
    expect(l.summary.dropping_n).toBe(2);
  });

  it('V214-12 same-day rebuild keeps the first build order, appends new names, shows a changed name with its reason and a dropped one in removed_since_first', async () => {
    const x = await h();
    await seedRun(x, [{ domain: 'namea.com', ratio: 3 }, { domain: 'nameb.com', ratio: 2 }, { domain: 'namec.com', ratio: 1 }]);
    await build(x);
    expect((await x.get('/candidates/daily')).json().entries.map((e: any) => e.domain)).toEqual(['namea.com', 'nameb.com', 'namec.com']);
    x.clock.t += 5 * 60_000;
    // a newer run: B now ranks above A and its quote changed; D is new and best; C was bought
    await seedRun(x, [{ domain: 'nameb.com', ratio: 9 }, { domain: 'named.com', ratio: 20 }, { domain: 'namea.com', ratio: 3, registrar: 'namecheap', first_year_cents: 999 }]);
    await insertOwnedDomain(db, { domain: 'namec.com' });
    const second = await build(x);
    expect(second).toMatchObject({ version: 2, entries_n: 3 });
    const l = (await x.get('/candidates/daily')).json();
    expect(l.version).toBe(2);
    expect(l.entries.map((e: any) => [e.rank, e.domain])).toEqual([[1, 'namea.com'], [2, 'nameb.com'], [3, 'named.com']]);
    expect(l.entries[0].changed_since_first).toEqual({ reason: 'STATE_CHANGED', changes: ['price'] });
    expect(l.entries[1].changed_since_first).toBeUndefined();
    expect(l.entries[2].changed_since_first).toBeUndefined();
    expect(l.sections.removed_since_first).toEqual([{ domain: 'namec.com', was_rank: 3, reason: 'OWNED' }]);
    expect(await db.selectFrom('daily_candidate_lists').select('id').execute()).toHaveLength(2);
    await expect(db.updateTable('daily_candidate_lists').set({ day: '2026-01-01' }).execute()).rejects.toThrow(/append-only/);
  });

  it('V214-13 a run that is still running when the wait ends: the list is built from what is done and marked partial', async () => {
    const x = await h();
    await seedRun(x, [{ domain: 'doneone.com' }]);
    const sel = await db.selectFrom('selection_settings').select(['id']).where('label', '=', 'v1').executeTakeFirstOrThrow();
    const rid = `run_${randomUUID()}`;
    await db.insertInto('screening_runs').values({
      id: rid, created_at: new Date(x.clock.t - 60_000), created_by: 'intakeScreening', mode: 'full', backtest: false, settings_id: sel.id, settings_label: 'v1', buy_hold: true, tranche_id: null,
      input: JSON.stringify({ names: [{ idx: 0, domain: 'slowone.com', lane: 'S3', leads_ab: 0 }] }), gate_plan: JSON.stringify({ S3: planFor((await db.selectFrom('selection_settings').select('values').where('label', '=', 'v1').executeTakeFirstOrThrow()).values as never, 'S3') }),
      list_versions: '{}', status: 'running', deadline_at: new Date(x.clock.t + 3_600_000),
    }).execute();
    await db.insertInto('candidate_screenings').values({ intake_id: null, domain: 'slowone.com', origin: 'drop_list', run_id: rid, day: '2026-10-06' }).execute();
    const stuck = { checks: {}, kick: () => {}, runToEnd: () => new Promise<void>(() => {}) } as unknown as ScreeningWorker;
    const r = await new BuildDailyListJob({ db, worker: stuck, now: () => x.clock.t, waitMs: 30 }).runOnce();
    expect(r).toMatchObject({ partial: true, entries_n: 1 });
    expect((await x.get('/candidates/daily')).json().summary.partial).toBe(true);
  });
});
