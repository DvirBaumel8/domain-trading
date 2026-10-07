// v2.9.0 (CR-010 acceptance findings): cancel (F-1, T10-8), source of each answer (F-3), lookup totals on screening runs (F-4), pending before the checks ran (F-5).
import { http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { RdapLookup, RdapLookupFn } from '../../src/rdap.js';
import { reopenRun } from '../../src/screening/engine.js';
import { rdapSourceOf } from '../../src/screening/rdap-batch.js';
import { siblingsBt1 } from '../../src/screening/siblings.js';
import { testDb as db } from '../helpers/db.js';
import { screeningHarness, type ScreeningHarness } from '../helpers/screening.js';
import { fixture, respond } from '../helpers/screening-fixtures.js';
import { issueToken } from '../helpers/tokens.js';
import { mswServer } from '../setup/network.js';

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());

const facts = (created: string | null) => ({ registrar: 'Fake Registrar', created_at: created, expires_at: null, updated_at: null, statuses: [], nameservers: [] });
const mk = (outcome: 'registered' | 'not_registered', url: string): RdapLookup => outcome === 'registered'
  ? { outcome, reasonCode: null, httpStatus: 200, url, retrievedAt: new Date(), body: '{"ldhName":"x"}', facts: facts('2010-01-01T00:00:00Z') }
  : { outcome, reasonCode: null, httpStatus: 404, url, retrievedAt: new Date(), body: null, facts: null };
const FEAT = { registered_share: 0.9, alt_tld_before_n: 0, prior_history: 1, n_words: 2, sld_chars: 8, is_geo: 0 };
const reg = (domain: string) => ({ domain, role: 'fit', label: 'sold', source: 'old', slice: 'R', as_of: '2024-06-01', features: FEAT });
const SIBS = siblingsBt1(['super', 'pro']).map((l) => `${l}.com`);

/** An rdap fake that holds every call until `release()`: the run is demonstrably mid-flight. */
function gated(): { fn: RdapLookupFn; calls: string[]; release: () => void } {
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  return { calls, release, fn: async (d) => { calls.push(d); await gate; return mk('not_registered', 'https://rdap.verisign.com/com/v1/domain/' + d); } };
}
async function h(rdapLookup: RdapLookupFn): Promise<ScreeningHarness> {
  mswServer.use(http.get('https://data.iana.org/rdap/dns.json', () => respond(fixture('iana-dns.json'))));
  const x = await screeningHarness({ screening: { rdapLookup } });
  app = x.app;
  return x;
}
/** Waits until the gated lookup has been asked at least once (the worker has started), instead of a fixed sleep. */
const started = (rdap: { calls: string[] }) => vi.waitFor(() => expect(rdap.calls.length).toBeGreaterThan(0), { timeout: 5_000, interval: 5 });
async function startSet(x: ScreeningHarness, name: string): Promise<string> {
  const r = await x.post('/selection/test-sets', { name, purpose: 'rescore', sibling_method: 'bt1@v1', slices: ['R'] });
  expect(r.statusCode, r.body).toBe(202);
  return r.json().run_id as string;
}

describe('cancel (CR-010 F-1, T10-8)', () => {
  it('T10-8 cancelling a running test set: cancelled at once, no further rdap calls, a read does not restart it, cancelling twice is 409 RUN_NOT_RUNNING', async () => {
    const rdap = gated();
    const x = await h(rdap.fn);
    await x.post('/selection/labelled-names', { rows: [reg('superpro.com')] });
    const runId = await startSet(x, 'CAN-1');
    await started(rdap);
    expect(rdap.calls.length).toBeGreaterThan(0);
    expect((await x.get('/selection/test-sets/CAN-1')).json()).toMatchObject({ status: 'computing', run: { status: 'running' } });
    const c = await x.post('/selection/test-sets/CAN-1/cancel', { reason: 'replaced by CAN-2' });
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json()).toMatchObject({ name: 'CAN-1', status: 'cancelled', run_id: runId, cancelled_by: 'gavriel' });
    const got = (await x.get('/selection/test-sets/CAN-1')).json();
    expect(got).toMatchObject({ status: 'cancelled', run: { status: 'cancelled' } });
    expect(got.timing.finished_at).not.toBeNull();
    const before = rdap.calls.length;
    rdap.release();
    await app!.screeningWorker.idle();
    expect(rdap.calls.length).toBe(before); // nothing after the cancel (the in-flight ones were already counted)
    // a read neither restarts nor reopens it, even with a stale heartbeat
    x.clock.t += 10 * 60_000;
    expect((await x.get('/selection/test-sets/CAN-1')).json().run.status).toBe('cancelled');
    expect((await x.get(`/screening/runs/${runId}`)).json().status).toBe('cancelled');
    expect(await reopenRun(db, runId, new Date(x.clock.t), 30)).toBe(false);
    expect(await app!.screeningWorker.resumeStalled()).toEqual({ resumed: [], finalized: [] });
    await app!.screeningWorker.runToEnd(runId);
    await app!.screeningWorker.idle();
    expect(rdap.calls.length).toBe(before);
    expect((await db.selectFrom('screening_runs').select('status').where('id', '=', runId).executeTakeFirstOrThrow()).status).toBe('cancelled');
    // unfinished checks are UNKNOWN CANCELLED; the audit row exists
    const codes = (await db.selectFrom('screening_results').select(['check_id', 'status', 'reason_code']).where('run_id', '=', runId).execute()).filter((r) => r.status === 'UNKNOWN').map((r) => r.reason_code);
    expect(codes.length).toBeGreaterThan(0);
    expect(new Set(codes)).toEqual(new Set(['CANCELLED']));
    expect((await db.selectFrom('audit_log').select('path').where('path', '=', '/selection/test-sets/CAN-1/cancel').execute())).toHaveLength(1);
    // twice and unknown
    const twice = await x.post('/selection/test-sets/CAN-1/cancel', {});
    expect([twice.statusCode, twice.json().error.code, twice.json().error.details.status]).toEqual([409, 'RUN_NOT_RUNNING', 'cancelled']);
    const none = await x.post('/selection/test-sets/NOPE-1/cancel', {});
    expect([none.statusCode, none.json().error.code]).toEqual([404, 'TEST_SET_NOT_FOUND']);
  });

  it('T10-8 a cancelled new set cannot be sealed (409 TEST_SET_NOT_READY, status cancelled); a finished set answers 409 RUN_NOT_RUNNING', async () => {
    const rdap = gated();
    const x = await h(rdap.fn);
    await x.post('/selection/labelled-names', { rows: [reg('superpro.com')] });
    await startSet(x, 'CAN-2');
    await started(rdap);
    // make it a purpose-new set for the seal check (the seal route reads purpose first)
    await db.updateTable('test_sets').set({ purpose: 'new' }).where('name', '=', 'CAN-2').execute();
    expect((await x.post('/selection/test-sets/CAN-2/cancel', {})).statusCode).toBe(200);
    const seal = await x.post('/selection/test-sets/CAN-2/seal', {});
    expect([seal.statusCode, seal.json().error.code, seal.json().error.details.status]).toEqual([409, 'TEST_SET_NOT_READY', 'cancelled']);
    rdap.release();
    await app!.screeningWorker.idle();
  });

  it('T10-8 cancel of a finished test set is 409 RUN_NOT_RUNNING with the run status', async () => {
    const rdap = gated();
    rdap.release();
    const x = await h(rdap.fn);
    await x.post('/selection/labelled-names', { rows: [reg('superpro.com')] });
    const runId = await startSet(x, 'CAN-3');
    await app!.screeningWorker.runToEnd(runId);
    const r = await x.post('/selection/test-sets/CAN-3/cancel', {});
    expect([r.statusCode, r.json().error.code]).toEqual([409, 'RUN_NOT_RUNNING']);
    expect(r.json().error.details.status).toMatch(/done|partial/);
  });

  it('T10-8 POST /screening/runs/{id}/cancel: 200 shape, kept results, UNKNOWN CANCELLED for the rest, 409 twice, 404 unknown, strict body, WRITE only', async () => {
    const x = await screeningHarness({ stopAfterResults: 1 });
    app = x.app;
    const { id } = await x.run({ mode: 'full', checks: ['form', 'census'], names: [{ domain: 'tampapoolsco.com', lane: 'S3' }, { domain: 'tulsaroofingco.com', lane: 'S3' }] });
    await app.screeningWorker.runToEnd(id);
    expect((await x.get(`/screening/runs/${id}`)).json().status).toBe('running');
    expect((await x.post(`/screening/runs/${id}/cancel`, { nope: 1 })).statusCode).toBe(422);
    expect((await x.post(`/screening/runs/${id}/cancel`, { reason: 'x'.repeat(201) })).statusCode).toBe(422);
    const read = await issueToken('read');
    const denied = await app.inject({ method: 'POST', url: `/screening/runs/${id}/cancel`, headers: { ...read.auth, 'idempotency-key': randomUUID() }, payload: {} });
    expect(denied.statusCode).toBe(403);
    const c = await x.post(`/screening/runs/${id}/cancel`, {});
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json()).toMatchObject({ id, status: 'cancelled', cancelled_by: 'gavriel' });
    expect(Date.parse(c.json().cancelled_at)).toBe(x.clock.t);
    const body = (await x.get(`/screening/runs/${id}`)).json();
    expect(body).toMatchObject({ status: 'cancelled', cancelled_by: 'gavriel' });
    expect(body.finished_at).toBe(body.cancelled_at);
    const rows = await db.selectFrom('screening_results').select(['check_id', 'status', 'reason_code']).where('run_id', '=', id).execute();
    expect(rows.filter((r) => r.status === 'UNKNOWN').every((r) => r.reason_code === 'CANCELLED')).toBe(true);
    expect(rows.length).toBe(4); // the one real result kept, three CANCELLED
    expect(body.names.every((n: any) => n.final_status !== 'pending' && n.final_status !== 'running')).toBe(true);
    const twice = await x.post(`/screening/runs/${id}/cancel`, {});
    expect([twice.statusCode, twice.json().error.code, twice.json().error.details.status]).toEqual([409, 'RUN_NOT_RUNNING', 'cancelled']);
    const unknown = await x.post('/screening/runs/run_nope/cancel', {});
    expect([unknown.statusCode, unknown.json().error.code]).toEqual([404, 'RUN_NOT_FOUND']);
    const finished = await x.runDone({ mode: 'full', checks: ['form'], names: [{ domain: 'tampapoolsco.com', lane: 'S3' }] });
    const f = await x.post(`/screening/runs/${finished.id}/cancel`, {});
    expect([f.statusCode, f.json().error.code]).toEqual([409, 'RUN_NOT_RUNNING']);
  });
});

describe('source of each answer (CR-010 F-3)', () => {
  it('rdapSourceOf: Verisign is verisign_rdap, any other base its hostname, no url null', () => {
    expect(rdapSourceOf('https://rdap.verisign.com/com/v1/domain/a.com')).toBe('verisign_rdap');
    expect(rdapSourceOf('https://rdap.verisign.com/net/v1/domain/a.net')).toBe('verisign_rdap');
    expect(rdapSourceOf('https://rdap.publicinterestregistry.org/rdap/domain/a.org')).toBe('rdap.publicinterestregistry.org');
    expect(rdapSourceOf('')).toBeNull();
  });

  it('V29-1 census siblings and ext_dates entries carry source; a reused answer carries the stored source; an old row without one shows null', async () => {
    const urls = (d: string) => (d.endsWith('.com') ? 'https://rdap.verisign.com/com/v1/domain/' : 'https://rdap.other-registry.example/rdap/domain/') + d;
    const calls: string[] = [];
    const x = await h(async (d) => { calls.push(d); return mk('not_registered', urls(d)); });
    await x.post('/selection/labelled-names', { rows: [reg('superpro.com')] });
    const a = await startSet(x, 'SRC-A');
    await app!.screeningWorker.runToEnd(a);
    const fields = async (id: string, check: string) => (await db.selectFrom('screening_results').select('fields').where('run_id', '=', id).where('check_id', '=', check).executeTakeFirstOrThrow()).fields as any;
    const ca = await fields(a, 'census');
    expect(ca.siblings.every((s: any) => s.source === 'verisign_rdap' && s.reused === false)).toBe(true);
    const ea = await fields(a, 'ext_dates');
    const answered = ea.extensions.filter((e: any) => e.status !== 'unknown');
    expect(answered.length).toBeGreaterThan(0);
    expect(answered.every((e: any) => e.source === 'rdap.other-registry.example' || e.source === 'verisign_rdap')).toBe(true);
    expect(ea.extensions.filter((e: any) => e.status === 'unknown').every((e: any) => e.source === null)).toBe(true);
    // an old stored answer (no source) reads null; a stored one with a source keeps it
    await db.updateTable('rdap_lookups').set({ source: null }).where('domain', '=', SIBS[0]!).execute();
    const before = calls.length;
    const b = await startSet(x, 'SRC-B');
    await app!.screeningWorker.runToEnd(b);
    expect(calls.length).toBe(before);
    const cb = await fields(b, 'census');
    expect(cb.siblings.every((s: any) => s.reused === true)).toBe(true);
    expect(cb.siblings.find((s: any) => s.domain === SIBS[0]).source).toBeNull();
    expect(cb.siblings.filter((s: any) => s.domain !== SIBS[0]).every((s: any) => s.source === 'verisign_rdap')).toBe(true);
  });
});

describe('lookups on screening runs (CR-010 F-4) and pending (F-5)', () => {
  it('V29-2 GET /screening/runs/{id} (both views) carries lookups equal to the test-set totals', async () => {
    const x = await h(async (d) => mk('not_registered', 'https://rdap.verisign.com/com/v1/domain/' + d));
    await x.post('/selection/labelled-names', { rows: [reg('superpro.com')] });
    const runId = await startSet(x, 'LK-A');
    await app!.screeningWorker.runToEnd(runId);
    const set = (await x.get('/selection/test-sets/LK-A')).json();
    for (const view of ['summary', 'full']) {
      const run = (await x.get(`/screening/runs/${runId}?view=${view}`)).json();
      expect(Object.keys(run.lookups).sort()).toEqual(['fresh', 'rate_limited', 'reused', 'unknown']);
      expect(run.lookups).toEqual(set.lookups);
    }
    expect(set.lookups.fresh).toBeGreaterThanOrEqual(20);
  });

  it('V29-3 a running run shows pending (not would_buy) and no ranking while a planned check has no result; a finished run is unchanged', async () => {
    const x = await screeningHarness({ stopAfterResults: 1 });
    app = x.app;
    const { id } = await x.run({ mode: 'full', checks: ['form', 'census'], names: [{ domain: 'tampapoolsco.com', lane: 'S3' }] });
    await app.screeningWorker.runToEnd(id);
    const mid = (await x.get(`/screening/runs/${id}`)).json();
    expect(mid.status).toBe('running');
    expect(mid.names[0]).toMatchObject({ final_status: 'pending' });
    expect(mid.ranking).toEqual([]);
    expect(mid.funnel.by_final_status).toEqual({ pending: 1 });
    await app.screeningWorker.runToEnd(id); // the first-execution stop is spent: it finishes
    const end = (await x.get(`/screening/runs/${id}`)).json();
    expect(end.status).toBe('done');
    expect(end.names[0].final_status).not.toBe('pending');
  });
});
