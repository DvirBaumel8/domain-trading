// v2.16.0 part A (tech debt): cohort abandon, record route reads inside the lock, seal needs a done run, run bookkeeping atomicity, geo LANDER-1 fails closed,
// intake lock and word rules, IDT dates, price-list query, CR-014 N-1..N-3 (T14-*), CR-015 I-1, I-2, I-4 (T15-*).
import { randomUUID } from 'node:crypto';
import { http } from 'msw';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { freezeReadyCohorts } from '../../../src/modules/candidates/cohorts.js';
import { watchStatusOf } from '../../../src/modules/candidates/drop-lists.js';
import { dropOutcomeOf } from '../../../src/modules/ops/jobs/cohort-outcomes.js';
import type { RdapLookup, RdapLookupFn } from '../../../src/core/rdap.js';
import { currentLists } from '../../../src/modules/selection/lists.js';
import { IntakeScreeningJob } from '../../../src/modules/candidates/intake.js';
import type { ScreeningWorker } from '../../../src/modules/selection/engine.js';
import { BuildDailyListJob } from '../../../src/modules/candidates/daily-list.js';
import { GATE_OF } from '../../../src/modules/selection/checks/index.js';
import { planFor } from '../../../src/modules/selection/engine.js';
import { featuresOfRun } from '../../../src/modules/selection/test-sets.js';
import { testDb as db } from '../../helpers/db.js';
import { putBrandLists, putList, screeningHarness, type ScreeningHarness } from '../../helpers/screening.js';
import { fixture, respond } from '../../helpers/screening-fixtures.js';
import { issueToken } from '../../helpers/tokens.js';
import { mswServer } from '../../setup/network.js';

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());
const DAY = 86_400_000;
const HOUR = 3_600_000;
const free = (): RdapLookup => ({ outcome: 'not_registered', reasonCode: null, httpStatus: 404, url: 'https://rdap.example/domain/x', retrievedAt: new Date(), body: null, facts: null });
async function h(rdapLookup: RdapLookupFn = async () => free()): Promise<ScreeningHarness> {
  mswServer.use(http.get('https://data.iana.org/rdap/dns.json', () => respond(fixture('iana-dns.json'))));
  const x = await screeningHarness({ screening: { rdapLookup } });
  app = x.app;
  return x;
}
const fakeWorker = (x: ScreeningHarness, kicked: string[] = []): ScreeningWorker => ({ checks: x.app.screeningWorker.checks, kick: (id: string) => { kicked.push(id); }, runToEnd: async () => {}, cancel: async () => null }) as unknown as ScreeningWorker;
const ap = (x: ScreeningHarness, text: string) => ({ text, approved_at: new Date(x.clock.t - HOUR).toISOString() });
const facts = (created: string | null) => ({ registrar: 'Fake Registrar', created_at: created, expires_at: null, updated_at: null, statuses: [], nameservers: [] });
const registered = (created: string | null): RdapLookup => ({ outcome: 'registered', reasonCode: null, httpStatus: 200, url: 'https://rdap.example/domain/x', retrievedAt: new Date(), body: '{"ldhName":"x"}', facts: facts(created) });

/** Makes every insert into `table` fail (a forced bookkeeping failure after the run was created). */
async function failInserts(table: string): Promise<() => Promise<void>> {
  await sql.raw(`CREATE OR REPLACE FUNCTION public.t16a_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced failure'; END $$`).execute(db);
  await sql.raw(`CREATE TRIGGER t16a_fail BEFORE INSERT ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.t16a_fail()`).execute(db);
  return async () => { await sql.raw(`DROP TRIGGER IF EXISTS t16a_fail ON public.${table}`).execute(db); };
}

describe('CR-015 I-2 GET /audit names the token (T15-2)', () => {
  it('T15-2 rows carry token_name (never the hash); a job or admin row has null', async () => {
    const x = await h();
    await x.post('/candidates/intake', { names: [{ domain: 'superpro.com', lane: 'S3', source: 's' }] });
    const rows = (await x.get('/audit?limit=50')).json().rows;
    const intake = rows.find((r: any) => r.path === '/candidates/intake');
    expect(intake).toMatchObject({ token_name: 'gavriel' });
    expect(typeof intake.token_id).toBe('number');
    expect(JSON.stringify(rows)).not.toMatch(/token_sha256|sha256/);
    await db.insertInto('audit_log').values({ id: 'aud_' + '2'.repeat(32), method: 'JOB', path: '/job/x', status_code: 200, scope: 'job' }).execute();
    const again = (await x.get('/audit?limit=50')).json().rows;
    expect(again.find((r: any) => r.id === 'aud_' + '2'.repeat(32)).token_name).toBeNull();
    expect(again.every((r: any) => 'token_name' in r)).toBe(true);
  });
});

interface Seed { domain: string; noRecords?: boolean; recordsAgeDays?: number; firstYearCents?: number }
/** A finished full-plan run on settings v1 (hold on), every planned check seeded as PASS (history/tm_us MANUAL_REQUIRED when noRecords); fresh domain records unless noRecords. */
async function seedRun(x: ScreeningHarness, names: Seed[]): Promise<string> {
  const sel = await db.selectFrom('selection_settings').select(['id', 'label', 'values']).where('label', '=', 'v1').executeTakeFirstOrThrow();
  const id = `run_${randomUUID()}`;
  const gate_plan: Record<string, string[]> = { S3: planFor(sel.values as never, 'S3') };
  const created = new Date(x.clock.t - HOUR);
  await db.insertInto('screening_runs').values({
    id, created_at: created, created_by: 'test', mode: 'full', backtest: false, settings_id: sel.id, settings_label: 'v1', buy_hold: true, tranche_id: null,
    input: JSON.stringify({ names: names.map((n, idx) => ({ idx, domain: n.domain, lane: 'S3', leads_ab: 0 })) }),
    gate_plan: JSON.stringify(gate_plan), list_versions: '{}', status: 'done', deadline_at: new Date(x.clock.t + 3_600_000), finished_at: created,
  }).execute();
  for (const [idx, n] of names.entries()) {
    for (const check of gate_plan.S3!) {
      let status: 'PASS' | 'MANUAL_REQUIRED' = 'PASS';
      let reason_code: string | null = null;
      let fields: Record<string, unknown> = {};
      if ((check === 'tm_us' || check === 'history') && n.noRecords) { status = 'MANUAL_REQUIRED'; reason_code = 'MANUAL_SOURCE'; }
      if (check === 'price') fields = { bin_cents: 148800, ratio_at_bin: 3, ratio_at_floor: 2, score_0_100: 50, floor_cents: 96700, walkaway_cents: 71500 };
      if (check === 'quote') fields = { registrar: 'porkbun', first_year_cents: n.firstYearCents ?? 1108, renewal_cents: 1208, quoted_at: new Date(x.clock.t - HOUR).toISOString() };
      if (check === 'tier') fields = { tier: 'A', tier_exact: true, fired: 'A' };
      await db.insertInto('screening_results').values({
        run_id: id, item_idx: idx, domain: n.domain, lane: 'S3', check_id: check, gate: GATE_OF[check as keyof typeof GATE_OF], rule_ids: ['X'], status, reason_code, reason: reason_code ? 'seeded' : null,
        fields: JSON.stringify(fields), checked_at: created, settings_label: 'v1', list_versions: '{}', duration_ms: 0, upstream_calls: 0, source: 'auto',
      }).execute();
    }
    if (!n.noRecords) {
      for (const kind of ['tm_us', 'history'] as const) {
        await db.insertInto('domain_records').values({ domain: n.domain, kind, record: JSON.stringify({ seeded: true }), checked_by: 'gavriel', checked_at: new Date(x.clock.t - (n.recordsAgeDays ?? 0) * DAY - 2 * HOUR), created_by: 'gavriel' }).execute();
      }
    }
  }
  return id;
}
const TM_OK = (d: string) => ({ phrases_queried: [d.replace('.com', '').toUpperCase()], control_ok: true, exact_or_core_live: [], generic_live: [] });
