// v2.8.0 (CR-007 §22): drop lists (G-2 source A: upload, filters, dropWatch, window reads, DROP_FEED_STALE) and cohorts (G-1: creation, exclusions,
// frozen decisions, daily outcomes, the forward report). RDAP answers are injected recordings; no registrar adapter is ever called.
import { createHash } from 'node:crypto';
import { http } from 'msw';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FWD_MIN_N, FWD_MIN_RATIO, classRate, windowVerdict } from '../../../src/modules/candidates/cohorts.js';
import { DROP_LIST_RETENTION_DAYS, DROP_WATCH_MAX_PER_RUN, watchStatusOf } from '../../../src/modules/candidates/drop-lists.js';
import { addDays } from '../../../src/core/dates.js';
import { CohortOutcomesJob } from '../../../src/modules/ops/jobs/cohort-outcomes.js';
import { DropWatchJob } from '../../../src/modules/ops/jobs/drop-watch.js';
import type { RdapLookup } from '../../../src/core/rdap.js';
import { wilson95 } from '../../../src/modules/selection/test-sets.js';
import { makeApp, runJobToEnd } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { patchActiveSettings, screeningHarness, type ScreeningHarness } from '../../helpers/screening.js';
import { fixture, respond } from '../../helpers/screening-fixtures.js';
import { issueToken } from '../../helpers/tokens.js';
import { mswServer } from '../../setup/network.js';

const DAY = 86_400_000;
const at = (iso: string) => Date.parse(iso);
let app: FastifyInstance | undefined;
afterEach(async () => app?.close());

const facts = (o: Partial<NonNullable<RdapLookup['facts']>> = {}) => ({ registrar: 'Fake Registrar', created_at: '2015-06-01T00:00:00.000Z', expires_at: null, updated_at: null, statuses: ['client transfer prohibited'], nameservers: [], ...o });
const registered = (o: Partial<NonNullable<RdapLookup['facts']>> = {}): RdapLookup => ({ outcome: 'registered', reasonCode: null, httpStatus: 200, url: 'https://rdap.example/domain/x', retrievedAt: new Date(), body: '{"ldhName":"x"}', facts: facts(o) });
const notRegistered = (): RdapLookup => ({ outcome: 'not_registered', reasonCode: null, httpStatus: 404, url: 'https://rdap.example/domain/x', retrievedAt: new Date(), body: null, facts: null });
const unknown = (): RdapLookup => ({ outcome: 'unknown', reasonCode: 'TIMEOUT', httpStatus: null, url: 'https://rdap.example/domain/x', retrievedAt: new Date(), body: null, facts: null });

const rdap = { table: {} as Record<string, RdapLookup>, calls: [] as string[] };
async function h(): Promise<ScreeningHarness> {
  rdap.table = {}; rdap.calls = [];
  mswServer.use(http.get('https://data.iana.org/rdap/dns.json', () => respond(fixture('iana-dns.json'))));
  const x = await screeningHarness({ screening: { sleep: async () => {}, rdapLookup: async (d) => { rdap.calls.push(d); return rdap.table[d] ?? notRegistered(); } } });
  app = x.app;
  return x;
}
const watch = (x: ScreeningHarness, maxPerRun?: number) => new DropWatchJob({ db, screening: (x.app as any).screeningWorker.deps.screening, now: () => x.clock.t, ...(maxPerRun !== undefined && { maxPerRun }) });
const outcomes = (x: ScreeningHarness) => new CohortOutcomesJob({ db, screening: (x.app as any).screeningWorker.deps.screening, now: () => x.clock.t });
const upload = (x: ScreeningHarness, name: string, domains: string[], list_date = '2026-10-06') => x.post('/selection/drop-lists', { name, list_date, domains });
const latest = (domain: string) => db.selectFrom('drop_list_checks').selectAll().where('domain', '=', domain).orderBy('id', 'desc').executeTakeFirst();

describe('drop lists: upload and filters (G-2)', () => {
  it('V28-1 every removal reason with its count; kept names are lower-cased with their split-v2 tokens; 201 shape', async () => {
    const x = await h();
    const domains = ['superhealth.com', 'SuperTech.com', 'theeventhouse.com', 'bad name.com', 'sub.super.com', 'super.org', 'supertech.com', 'super1pro.com', 'super-pro.com', 'zzqxjkvv.com', 'thebestcoffeeshop.com', 'mountain.com'];
    const r = await upload(x, 'snap-1006', domains);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toEqual({
      name: 'snap-1006', list_date: '2026-10-06', received_n: 12, kept_n: 3,
      removed: { DOMAIN_INVALID: 3, DUPLICATE_IN_UPLOAD: 1, HAS_DIGIT: 1, HAS_HYPHEN: 1, NO_SPLIT: 1, TOO_MANY_WORDS: 1, ONE_WORD: 1 },
    });
    const g = (await x.get('/selection/drop-lists/snap-1006')).json();
    expect(g).toMatchObject({ name: 'snap-1006', list_date: '2026-10-06', received_n: 12, kept_n: 3 });
    expect(g.rows).toHaveLength(12);
    expect(g.rows.filter((q: any) => q.kept).map((q: any) => [q.domain, q.tokens])).toEqual([['superhealth.com', ['super', 'health']], ['supertech.com', ['super', 'tech']], ['theeventhouse.com', ['the', 'event', 'house']]]);
    expect(g.rows.find((q: any) => q.domain === 'thebestcoffeeshop.com')).toMatchObject({ kept: false, reason: 'TOO_MANY_WORDS', tokens: ['the', 'best', 'coffee', 'shop'], status: null, expected_drop_date: null, checked_at: null });
    expect(g.rows.find((q: any) => q.domain === 'mountain.com').reason).toBe('ONE_WORD');
  });
  it('V28-2 DROP_LIST_NAME_TAKEN (409), DROP_LIST_NOT_FOUND (404), a bad name, a future list_date and an empty list are refused and store nothing', async () => {
    const x = await h();
    expect((await upload(x, 'snap-a1', ['superhealth.com'])).statusCode).toBe(201);
    const again = await upload(x, 'snap-a1', ['supertech.com']);
    expect([again.statusCode, again.json().error.code]).toEqual([409, 'DROP_LIST_NAME_TAKEN']);
    const nf = await x.get('/selection/drop-lists/nope-list');
    expect([nf.statusCode, nf.json().error.code]).toEqual([404, 'DROP_LIST_NOT_FOUND']);
    expect((await upload(x, 'Bad Name', ['superhealth.com'])).statusCode).toBe(422);
    expect((await upload(x, 'snap-a2', ['superhealth.com'], '2026-10-09')).statusCode).toBe(422);
    expect((await upload(x, 'snap-a3', [])).statusCode).toBe(422);
    expect(await db.selectFrom('drop_lists').select('name').execute()).toEqual([{ name: 'snap-a1' }]);
    expect(await db.selectFrom('drop_list_rows').selectAll().execute()).toHaveLength(1);
  });
});
