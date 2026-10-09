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

describe('item 6 intake: one screening at a time, and the drop-list word rules', () => {
  it('A16-11 two instances racing take the queue once: one run, every name screened once', async () => {
    const x = await h();
    const names = ['superpro', 'superbox', 'supertech', 'superhealth', 'supermedia'].map((n) => `${n}.com`);
    expect((await x.post('/candidates/intake', { names: names.map((domain) => ({ domain, lane: 'S3', source: 'bulk' })) })).statusCode).toBe(200);
    const kicked: string[] = [];
    const [a, b] = await Promise.all([1, 2].map(() => new IntakeScreeningJob({ db, worker: fakeWorker(x, kicked), now: () => x.clock.t }).runOnce()));
    const taken = [a!, b!].filter((r) => !r.skipped);
    expect(taken).toHaveLength(1);
    expect(taken[0]).toMatchObject({ screened: 5, from_intake: 5 });
    expect([a!, b!].find((r) => r.skipped)).toMatchObject({ skipped: true, reason: 'NO_NAMES' });
    expect(await db.selectFrom('screening_runs').select('id').execute()).toHaveLength(1);
    const screened = await db.selectFrom('candidate_screenings').select('domain').execute();
    expect(screened.map((s) => s.domain).sort()).toEqual([...names].sort());
    expect(kicked).toHaveLength(1);
  });
  it('A16-12 NO_SPLIT and ONE_WORD are removal reasons on /candidates/intake, as on a drop list; a good name is still accepted', async () => {
    const x = await h();
    const r = await x.post('/candidates/intake', { names: ['zzqxjkvv.com', 'mountain.com', 'thebestcoffeeshop.com', 'superpro.com'].map((domain) => ({ domain, lane: 'S3', source: 's' })) });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().removed).toEqual([{ domain: 'zzqxjkvv.com', reason: 'NO_SPLIT' }, { domain: 'mountain.com', reason: 'ONE_WORD' }, { domain: 'thebestcoffeeshop.com', reason: 'TOO_MANY_WORDS' }]);
    expect(r.json().accepted).toEqual([{ domain: 'superpro.com', intake_id: expect.any(Number) }]);
  });
});

describe('CR-015 I-1 intake note and source carry no personal data (T15-1)', () => {
  it('T15-1 an "@" in note or source is 422 NO_PII with {index, field}; nothing is stored', async () => {
    const x = await h();
    const bad1 = await x.post('/candidates/intake', { names: [{ domain: 'superpro.com', lane: 'S3', source: 'ok' }, { domain: 'superbox.com', lane: 'S3', source: 's', note: 'ask bob@example.com' }] });
    expect([bad1.statusCode, bad1.json().error.code, bad1.json().error.details]).toEqual([422, 'NO_PII', { index: 1, field: 'note' }]);
    const bad2 = await x.post('/candidates/intake', { names: [{ domain: 'superbox.com', lane: 'S3', source: 'scout@host' }] });
    expect([bad2.statusCode, bad2.json().error.code, bad2.json().error.details]).toEqual([422, 'NO_PII', { index: 0, field: 'source' }]);
    expect(await db.selectFrom('candidate_intake').selectAll().execute()).toEqual([]);
    expect((await x.post('/candidates/intake', { names: [{ domain: 'superbox.com', lane: 'S3', source: 'scout-1/run-4', note: 'seen on a list' }] })).statusCode).toBe(200);
  });
});
