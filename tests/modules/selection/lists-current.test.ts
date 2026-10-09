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

describe('item 9 price lists', () => {
  it('A16-3 currentLists returns the highest version of each named list in one query, and leaves out a list with no rows', async () => {
    await putList('brand', ['a'], 1);
    await putList('brand', ['a', 'b'], 2);
    await putList('brand', ['a', 'b', 'c'], 3);
    await putList('bigco', ['x'], 1);
    await putList('event', ['e'], 1);
    await putList('event', ['e', 'f'], 2);
    expect(await currentLists(db, ['brand', 'bigco', 'event', 'nolist'])).toEqual({
      brand: { version: 3, terms: ['a', 'b', 'c'] }, bigco: { version: 1, terms: ['x'] }, event: { version: 2, terms: ['e', 'f'] },
    });
    expect(await currentLists(db, [])).toEqual({});
  });
});
