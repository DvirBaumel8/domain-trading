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

describe('daily run (G-1, G-2)', () => {
  it('V28-19 dropWatch and cohortOutcomes are daily steps after portfolioCheck and before referenceRefresh; no registrar adapter is called', async () => {
    const adapter = new FakeAdapter('porkbun');
    const a = await makeApp({
      testRoutes: false, env: { JOB_TRIGGER_TOKEN: 'job_token_fake_0123456789abcdef0123456789' }, adapters: [adapter], now: () => at('2026-10-20T09:00:00Z'),
      screening: { sleep: async () => {}, rdapLookup: async () => registered({ statuses: ['pendingDelete'], updated_at: '2026-10-18T00:00:00.000Z' }) },
    });
    app = a;
    const w = (await issueToken('write', 'gavriel')).auth;
    const up = await a.inject({ method: 'POST', url: '/selection/drop-lists', headers: { ...w, 'idempotency-key': 'dl-1' }, payload: { name: 'snap-day', list_date: '2026-10-20', domains: ['superhealth.com', 'supertech.com'] } });
    expect(up.statusCode, up.body).toBe(201);
    const before = adapter.calls.length;
    const res = await runJobToEnd(a, 'daily', { key: 'dw-1' });
    expect(res.statusCode, res.body).toBe(202);
    const steps = Object.keys(res.json().steps);
    expect(steps.slice(steps.indexOf('portfolioCheck'))).toEqual(['portfolioCheck', 'dropWatch', 'intakeScreening', 'buildDailyList', 'cohortOutcomes', 'referenceRefresh', 'outsideReview', 'postsRefresh', 'backupExport']);
    expect(res.json().steps.dropWatch).toMatchObject({ ok: true, summary: { checked: 2, pending_delete: 2, left_for_next_run: 0 } });
    expect(res.json().steps.cohortOutcomes).toMatchObject({ ok: true, summary: { frozen: 0, checked: 0 } });
    // v2.14.0: the intakeScreening run also screens the two pending-delete names, and its quote check asks the registrar for a read-only `quote`; dropWatch and cohortOutcomes still only use RDAP, and nothing is ever registered.
    expect(adapter.calls.slice(before).every((c) => c.startsWith('findDomain') || c.startsWith('quote '))).toBe(true);
    expect(await db.selectFrom('drop_list_checks').select('expected_drop_date').execute()).toEqual([{ expected_drop_date: '2026-10-23' }, { expected_drop_date: '2026-10-23' }]);
  });
});
