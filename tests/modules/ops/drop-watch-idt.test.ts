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

describe('item 7 IDT dates at the 00:00-03:00 edge', () => {
  it('A16-1 watchStatusOf takes the IDT day of RDAP updated_at', () => {
    // 2026-03-01T22:30Z is 00:30 IDT on 2 March (UTC+2): the IDT day is the 2nd, so pending delete + 5 days is the 7th (UTC date would give the 6th)
    const w = watchStatusOf({ outcome: 'registered', reasonCode: null, facts: { ...facts(null), statuses: ['pendingDelete'], updated_at: '2026-03-01T22:30:00Z' } });
    expect(w).toMatchObject({ status: 'pending_delete', last_changed: '2026-03-02', expected_drop_date: '2026-03-07' });
    const r = watchStatusOf({ outcome: 'registered', reasonCode: null, facts: { ...facts(null), statuses: ['redemptionPeriod'], updated_at: '2026-10-09T21:30:00Z' } }); // 00:30 IDT on 10 Oct (UTC+3)
    expect(r).toMatchObject({ last_changed: '2026-10-10', expected_drop_date: '2026-11-14' });
  });
  it('A16-2 dropOutcomeOf takes the IDT day of the registry creation date', () => {
    // created 2026-10-09T22:30Z = 01:30 IDT on 10 Oct; expected drop date 11 Oct: the IDT day (10 Oct) is on or after expected - 1 day, so someone caught it at the drop
    const f = (created: string) => ({ outcome: 'registered' as const, reasonCode: null, facts: { ...facts(created), statuses: ['ok'] } });
    expect(dropOutcomeOf(f('2026-10-09T22:30:00Z'), '2026-10-11').result).toBe('caught_at_drop');
    expect(dropOutcomeOf(f('2026-10-09T20:30:00Z'), '2026-10-11').result).toBe('restored'); // 23:30 IDT on the 9th
  });
});
