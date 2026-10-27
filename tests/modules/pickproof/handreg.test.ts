// v5.66.0 (F47): the hand-registration paper test. Submit and seal (pool, picks, same-size random control from the stored seed), RDAP at the seal,
// M6 / M12 labels (RDAP mocked with MSW) and the report. Every outside call is mocked; the only network the code could make is Verisign RDAP, answered by MSW.
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { http, HttpResponse } from 'msw';
import { drawControl, mondayOf, poolSha } from '../../../src/modules/pickproof/handreg.js';
import { handregLabels } from '../../../src/modules/pickproof/index.js';
import { makeApp } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { issueToken } from '../../helpers/tokens.js';
import { mswServer } from '../../setup/network.js';

const at = (iso: string) => Date.parse(iso);
const WEEK = '2026-12-21'; // a Monday
let clock = at('2026-12-23T10:00:00Z'); // the Wednesday of that week
let app: FastifyInstance | undefined;
let n = 0;
afterEach(async () => { await app?.close(); app = undefined; });

const RDAP = 'https://rdap.verisign.com/com/v1/domain/:name';
type Answer = { registered: string; status?: string[] } | 'free' | 'error' | 'ratelimit';
const rdap = (answers: Record<string, Answer>, hits: string[] = []) => mswServer.use(http.get(RDAP, ({ params }) => {
  const name = String(params.name);
  hits.push(name);
  const a = answers[name] ?? 'free';
  if (a === 'error') return HttpResponse.error();
  if (a === 'ratelimit') return new HttpResponse(null, { status: 429, headers: { 'retry-after': '60' } });
  if (a === 'free') return HttpResponse.json({ errorCode: 404 }, { status: 404, headers: { 'content-type': 'application/rdap+json' } });
  return HttpResponse.json({ objectClassName: 'domain', ldhName: name, events: [{ eventAction: 'registration', eventDate: a.registered }], status: a.status ?? ['active'] }, { headers: { 'content-type': 'application/rdap+json' } });
}));

const boot = async () => {
  app = await makeApp({ testRoutes: false, now: () => clock });
  const bots = await issueToken('bots');
  const read = await issueToken('read');
  const write = await issueToken('write');
  const data = await issueToken('data');
  const submit = (body: unknown, auth = bots.auth) => app!.inject({ method: 'POST', url: '/handreg/weeks', headers: { ...auth, 'idempotency-key': `hr-${++n}` }, payload: body as object });
  const get = (url: string, auth = read.auth) => app!.inject({ method: 'GET', url, headers: auth });
  return { bots, read, write, data, submit, get };
};

const control_sha = (control: string[]) => createHash('sha256').update(JSON.stringify(control)).digest('hex');
const pool = (k: number) => Array.from({ length: k }, (_, i) => `name${String(i).padStart(3, '0')}.com`);
const POOL = pool(10);
const PICKS = ['name001.com', 'name004.com', 'name007.com'];

describe('HR66 submit and seal', () => {
  it('HR66-1 a submission seals the picks with a same-size control: disjoint from the picks, a subset of the pool, reproducible from the stored seed', async () => {
    const { submit, get } = await boot();
    rdap({});
    const res = await submit({ pool: POOL, picks: PICKS });
    expect(res.statusCode).toBe(201);
    const b = res.json();
    expect(b).toMatchObject({ week: WEEK, pool_n: 10, picks_n: 3, control_n: 3, registered_at_seal_n: 0, pool_sha256: poolSha([...POOL].sort()) });
    expect(b.audit_id).toBeTruthy();
    const w = (await get(`/handreg/weeks/${WEEK}`)).json();
    const control = w.names.filter((x: { arm: string }) => x.arm === 'control').map((x: { domain: string }) => x.domain);
    const picks = w.names.filter((x: { arm: string }) => x.arm === 'pick').map((x: { domain: string }) => x.domain);
    expect(picks).toEqual(PICKS);
    expect(control).toHaveLength(3);
    expect(control.filter((d: string) => PICKS.includes(d))).toEqual([]);
    expect(control.every((d: string) => POOL.includes(d))).toBe(true);
    expect(w.seed).toBe(b.seed);
    expect(drawControl(POOL, PICKS, w.seed, 3)).toEqual(control); // anyone can redraw it from the pool, picks and seed
    expect(control_sha(control)).toBe(b.control_sha256);
    expect(w.names.every((x: { rdap_at_seal: string }) => x.rdap_at_seal === 'available')).toBe(true);
  });

  it('HR66-2 a second submission in the same week is 409 HANDREG_WEEK_SEALED and changes nothing; the next Monday is a new week', async () => {
    const { submit } = await boot();
    rdap({});
    expect((await submit({ pool: POOL, picks: PICKS })).statusCode).toBe(201);
    const again = await submit({ pool: POOL, picks: ['name002.com'] });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('HANDREG_WEEK_SEALED');
    expect(await db.selectFrom('handreg_weeks').select('picks_n').execute()).toEqual([{ picks_n: 3 }]);
    expect(mondayOf(at('2026-12-27T23:59:59Z'))).toBe(WEEK); // Sunday still belongs to the week
    expect(mondayOf(at('2026-12-28T00:00:00Z'))).toBe('2026-12-28');
    clock = at('2026-12-29T10:00:00Z');
    expect((await submit({ pool: POOL, picks: PICKS })).statusCode).toBe(201);
    clock = at('2026-12-23T10:00:00Z');
  });

  it('HR66-3 a pick outside the pool is 422 NOT_IN_POOL; a pool under twice the picks is 422 HANDREG_POOL_TOO_SMALL; nothing is stored', async () => {
    const { submit } = await boot();
    const out = await submit({ pool: POOL, picks: ['name001.com', 'zzz.com'] });
    expect(out.statusCode).toBe(422);
    expect(out.json().error).toMatchObject({ code: 'NOT_IN_POOL', details: { names: ['zzz.com'] } });
    const small = await submit({ pool: pool(5), picks: ['name000.com', 'name001.com', 'name002.com'] });
    expect(small.statusCode).toBe(422);
    expect(small.json().error.code).toBe('HANDREG_POOL_TOO_SMALL');
    const exact = await submit({ pool: pool(6), picks: ['name000.com', 'name001.com', 'name002.com'], dry_run: true });
    expect(exact.statusCode).toBe(200); // exactly twice is enough
    expect((await submit({ pool: [...POOL, 'bad name.net'], picks: PICKS })).json().error.code).toBe('VALIDATION_ERROR');
    expect((await submit({ pool: POOL, picks: ['name001.com', 'NAME001.com'] })).json().error.code).toBe('VALIDATION_ERROR'); // a pick twice after lower-casing
    expect(await db.selectFrom('handreg_weeks').select('week').execute()).toEqual([]);
  });

  it('HR66-4 a dry run validates, answers 200 and stores nothing: no draw, no RDAP, no week', async () => {
    const { submit } = await boot();
    const hits: string[] = [];
    rdap({}, hits);
    const res = await submit({ pool: POOL, picks: PICKS, dry_run: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ dry_run: true, week: WEEK, pool_n: 10, picks_n: 3, control_n: 3 });
    expect(res.json().seed).toBeUndefined();
    expect(hits).toEqual([]);
    expect(await db.selectFrom('handreg_weeks').select('week').execute()).toEqual([]);
    expect(await db.selectFrom('handreg_names').select('week').execute()).toEqual([]);
  });

  it('HR66-5 scopes: a data token and a read token cannot submit (403); bots and write can; read, bots and write can read, a data token cannot', async () => {
    const { submit, get, data, read, bots, write } = await boot();
    rdap({});
    expect((await submit({ pool: POOL, picks: PICKS, dry_run: true }, data.auth)).statusCode).toBe(403);
    expect((await submit({ pool: POOL, picks: PICKS, dry_run: true }, read.auth)).statusCode).toBe(403);
    expect((await submit({ pool: POOL, picks: PICKS, dry_run: true }, bots.auth)).statusCode).toBe(200);
    expect((await submit({ pool: POOL, picks: PICKS, dry_run: true }, write.auth)).statusCode).toBe(200);
    for (const url of ['/handreg/weeks', '/handreg/report']) {
      expect((await get(url, data.auth)).statusCode).toBe(403);
      expect((await get(url, read.auth)).statusCode).toBe(200);
      expect((await get(url, bots.auth)).statusCode).toBe(200);
      expect((await get(url, write.auth)).statusCode).toBe(200);
    }
    const noKey = await app!.inject({ method: 'POST', url: '/handreg/weeks', headers: bots.auth, payload: { pool: POOL, picks: PICKS } });
    expect(noKey.statusCode).toBe(400); // Idempotency-Key required
  });

  it('HR66-6 a name registered at the seal is recorded and left out of the report n; an RDAP error is recorded as unknown and never fails the call', async () => {
    const { submit, get } = await boot();
    rdap({ 'name001.com': { registered: '2019-05-01T00:00:00Z' }, 'name004.com': 'error' }, []);
    const res = await submit({ pool: POOL, picks: PICKS });
    expect(res.statusCode).toBe(201);
    const names: Array<{ domain: string; rdap_at_seal: string }> = (await get(`/handreg/weeks/${WEEK}`)).json().names;
    expect(names.find((x) => x.domain === 'name001.com')!.rdap_at_seal).toBe('registered');
    expect(names.find((x) => x.domain === 'name004.com')!.rdap_at_seal).toBe('unknown');
    expect(res.json().registered_at_seal_n).toBe(1);
    const rep = (await get('/handreg/report')).json();
    expect(rep.registered_at_seal_n).toBe(1);
    expect(rep.horizons.m6.picks.n).toBe(2); // 3 picks, one registered at the seal
    expect(rep.horizons.m6.control.n).toBe(3);
  });

  it('HR66-7 a 429 at the seal stops the lookups, the rest is unknown, and the call still succeeds', async () => {
    const { submit, get } = await boot();
    rdap(Object.fromEntries(POOL.map((d) => [d, 'ratelimit' as const])));
    const res = await submit({ pool: POOL, picks: PICKS });
    expect(res.statusCode).toBe(201);
    const names: Array<{ rdap_at_seal: string }> = (await get(`/handreg/weeks/${WEEK}`)).json().names;
    expect(names).toHaveLength(6);
    expect(names.every((x) => x.rdap_at_seal === 'unknown')).toBe(true);
  });

  it('HR66-8 GET /handreg/weeks lists the weeks with counts; an unknown week is 404 HANDREG_WEEK_NOT_FOUND', async () => {
    const { submit, get } = await boot();
    rdap({});
    await submit({ pool: POOL, picks: PICKS });
    const list = (await get('/handreg/weeks')).json();
    expect(list.weeks).toEqual([expect.objectContaining({ week: WEEK, pool_n: 10, picks_n: 3, control_n: 3, registered_at_seal_n: 0, labels_n: 0 })]);
    const miss = await get('/handreg/weeks/2026-01-05');
    expect(miss.statusCode).toBe(404);
    expect(miss.json().error.code).toBe('HANDREG_WEEK_NOT_FOUND');
  });
});

/** A sealed week built straight in the tables: picks and control names with their RDAP state at the seal. */
const fixtureWeek = async (week: string, picks: string[], control: string[], atSeal: Record<string, 'registered' | 'unknown'> = {}) => {
  await db.insertInto('handreg_weeks').values({ week, pool_n: picks.length * 3, pool_sha256: 'a'.repeat(64), picks_n: picks.length, seed: 7, control_sha256: 'b'.repeat(64), submitted_by: 'test', sealed_at: new Date(`${week}T09:00:00Z`) }).execute();
  await db.insertInto('handreg_names').values([
    ...picks.map((domain, i) => ({ week, domain, arm: 'pick' as const, rank: i + 1, rdap_at_seal: atSeal[domain] ?? ('available' as const) })),
    ...control.map((domain, i) => ({ week, domain, arm: 'control' as const, rank: i + 1, rdap_at_seal: atSeal[domain] ?? ('available' as const) })),
  ]).execute();
};
const label = (week: string, domain: string, horizon: 'm6' | 'm12' = 'm6') => db.selectFrom('handreg_labels').selectAll().where('week', '=', week).where('domain', '=', domain).where('horizon', '=', horizon).executeTakeFirst();
const noSleep = async () => undefined;
const W = '2026-01-05'; // a Monday; m6 is due from 2026-07-06, m12 from 2027-01-05
const DUE6 = at('2026-07-06T10:00:00Z');

describe('HR66 labels step', () => {
  it('HR66-10 with nothing due the step answers {ok, 0, 0} and makes no outside call; m6 is due on week + 182 days, not a day earlier', async () => {
    await fixtureWeek(W, ['p1.com'], ['c1.com']);
    const hits: string[] = [];
    rdap({}, hits);
    expect(await handregLabels({ db, now: () => at('2026-07-05T23:59:00Z'), sleep: noSleep })).toEqual({ status: 'ok', checked_n: 0, due_n: 0 });
    expect(hits).toEqual([]);
    expect(await handregLabels({ db, now: () => DUE6, sleep: noSleep })).toMatchObject({ status: 'ok', due_n: 2, checked_n: 2 });
    expect(hits.sort()).toEqual(['c1.com', 'p1.com']);
  });

  it('HR66-11 m6 labels: registered and active is taken; free is not_taken; redemption period is not_taken; an error is unknown with its reason; registered-at-seal names are never asked', async () => {
    await fixtureWeek(W, ['p1.com', 'p2.com', 'p3.com'], ['c1.com', 'c2.com'], { 'c2.com': 'registered' });
    const hits: string[] = [];
    rdap({ 'p1.com': { registered: '2026-03-01T00:00:00Z' }, 'p3.com': { registered: '2019-05-01T00:00:00Z', status: ['client delete prohibited', 'redemptionPeriod'] }, 'c1.com': 'error' }, hits);
    const s = await handregLabels({ db, now: () => DUE6, sleep: noSleep });
    expect(s).toMatchObject({ status: 'ok', due_n: 4, checked_n: 4, taken_n: 1, not_taken_n: 2, unknown_n: 1 });
    expect(hits).not.toContain('c2.com');
    expect(await label(W, 'p1.com')).toMatchObject({ label: 'taken', attempts: 1 });
    expect((await label(W, 'p1.com'))!.created_at_rdap!.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(await label(W, 'p2.com')).toMatchObject({ label: 'not_taken' });
    expect(await label(W, 'p3.com')).toMatchObject({ label: 'not_taken' });
    expect(await label(W, 'c1.com')).toMatchObject({ label: 'unknown', reason: 'SOURCE_ERROR' });
    expect(await label(W, 'c2.com')).toBeUndefined();
    expect(await label(W, 'p1.com', 'm12')).toBeUndefined(); // m12 is not due yet
  });

  it('HR66-12 a final label is not asked again; an unknown one is retried and stops after 5 attempts', async () => {
    await fixtureWeek(W, ['p1.com'], ['c1.com']);
    const hits: string[] = [];
    rdap({ 'c1.com': 'error' }, hits);
    await handregLabels({ db, now: () => DUE6, sleep: noSleep });
    expect(hits.sort()).toEqual(['c1.com', 'p1.com']);
    hits.length = 0;
    await db.deleteFrom('rdap_cache').execute(); // the cache would answer; the retry must reach the registry
    expect(await handregLabels({ db, now: () => DUE6 + 3_600_000, sleep: noSleep })).toMatchObject({ due_n: 1, checked_n: 1 });
    expect(hits).toEqual(['c1.com']);
    expect(await label(W, 'c1.com')).toMatchObject({ label: 'unknown', attempts: 2 });
    for (let i = 0; i < 5; i++) { await db.deleteFrom('rdap_cache').execute(); await handregLabels({ db, now: () => DUE6 + (i + 2) * 3_600_000, sleep: noSleep }); }
    expect(await label(W, 'c1.com')).toMatchObject({ label: 'unknown', attempts: 5 });
    expect(await handregLabels({ db, now: () => DUE6 + 10 * 3_600_000, sleep: noSleep })).toEqual({ status: 'ok', checked_n: 0, due_n: 0 });
  });

  it('HR66-13 m12 is due on week + 365 days and labels the same name a second time (one lookup serves both horizons when both are due)', async () => {
    await fixtureWeek(W, ['p1.com'], ['c1.com']);
    rdap({ 'p1.com': { registered: '2026-03-01T00:00:00Z' } });
    await handregLabels({ db, now: () => DUE6, sleep: noSleep });
    const hits: string[] = [];
    rdap({ 'p1.com': 'free' }, hits);
    await db.deleteFrom('rdap_cache').execute();
    const s = await handregLabels({ db, now: () => at('2027-01-05T10:00:00Z'), sleep: noSleep });
    expect(s).toMatchObject({ due_n: 2, checked_n: 2 });
    expect(await label(W, 'p1.com', 'm6')).toMatchObject({ label: 'taken' }); // the m6 label is final
    expect(await label(W, 'p1.com', 'm12')).toMatchObject({ label: 'not_taken' });
    expect(hits.sort()).toEqual(['c1.com', 'p1.com']);
    const both = '2025-12-01'; // a week due for both horizons at once
    await fixtureWeek(both, ['q1.com'], ['d1.com']);
    hits.length = 0;
    await handregLabels({ db, now: () => at('2026-12-01T10:00:00Z'), sleep: noSleep });
    expect(hits.filter((h) => h === 'q1.com')).toHaveLength(1);
    expect(await label(both, 'q1.com', 'm6')).toBeDefined();
    expect(await label(both, 'q1.com', 'm12')).toBeDefined();
  });

  it('HR66-14 a 429 ends the run: nothing after it is looked up, the 429 itself stores no label, and the next run continues', async () => {
    await fixtureWeek(W, ['a1.com', 'a2.com', 'a3.com'], ['b1.com']);
    const hits: string[] = [];
    rdap({ 'a2.com': 'ratelimit' }, hits);
    const s = await handregLabels({ db, now: () => DUE6, sleep: noSleep });
    expect(s).toMatchObject({ status: 'stopped', stopped_reason: 'RATE_LIMITED', checked_n: 1 });
    expect(hits).toEqual(['a1.com', 'a2.com']);
    expect(await label(W, 'a1.com')).toBeDefined();
    expect(await label(W, 'a2.com')).toBeUndefined();
    rdap({}, hits);
    await db.deleteFrom('rdap_cache').execute();
    expect(await handregLabels({ db, now: () => DUE6 + 60_000, sleep: noSleep })).toMatchObject({ status: 'ok', checked_n: 3, due_n: 3 });
  });

  it('HR66-15 at most handreg_labels_max_per_run lookups a run, oldest week first', async () => {
    await fixtureWeek('2026-01-12', ['n1.com', 'n2.com'], ['n3.com']);
    await fixtureWeek(W, ['o1.com', 'o2.com'], ['o3.com']);
    await db.updateTable('settings').set({ handreg_labels_max_per_run: 4 }).execute();
    const hits: string[] = [];
    rdap({}, hits);
    const s = await handregLabels({ db, now: () => at('2026-07-20T10:00:00Z'), sleep: noSleep });
    expect(s).toMatchObject({ status: 'stopped', stopped_reason: 'CAP', checked_n: 4, due_n: 6 });
    expect(hits.sort()).toEqual(['n1.com', 'o1.com', 'o2.com', 'o3.com']);
    expect(await label('2026-01-12', 'n2.com')).toBeUndefined();
  });

  it('HR66-16 the datasave job has the handregLabels step right after pickproofLabels, and it runs while pickproof_enabled is false', async () => {
    const { runJobToEnd } = await import('../../helpers/app.js');
    const { inventoryHandlers } = await import('../../helpers/datasave.js');
    app = await makeApp({ testRoutes: false, now: () => clock, env: { JOB_TRIGGER_TOKEN: 'job_token_fake_0123456789abcdef0123456789' } });
    mswServer.use(...inventoryHandlers());
    const run = await runJobToEnd(app, 'datasave');
    const steps = Object.keys(run.json().steps as Record<string, unknown>);
    expect(steps.slice(-4)).toEqual(['pickproofLabels', 'handregLabels', 'dynadotCloseouts', 'dynadotAftermarket']);
    const hl = (run.json().steps as Record<string, { status: string; summary: unknown }>).handregLabels!;
    expect(hl.status).toBe('done');
    expect(hl.summary).toEqual({ status: 'ok', checked_n: 0, due_n: 0 });
  });
});

describe('HR66 report', () => {
  const lab = (week: string, domain: string, horizon: 'm6' | 'm12', l: 'taken' | 'not_taken' | 'unknown') =>
    db.insertInto('handreg_labels').values({ week, domain, horizon, label: l, checked_at: new Date(), created_at_rdap: null, reason: null, attempts: 1 }).execute();

  it('HR66-20 per horizon and arm: n without registered-at-seal names, labelled, taken, taken_pct, sold, unknown, pending; fewer than 10 taken events is UNPOWERED with no p', async () => {
    const { get } = await boot();
    await fixtureWeek(W, ['p1.com', 'p2.com', 'p3.com', 'p4.com'], ['c1.com', 'c2.com', 'c3.com', 'c4.com'], { 'p4.com': 'registered' });
    await lab(W, 'p1.com', 'm6', 'taken'); await lab(W, 'p2.com', 'm6', 'not_taken'); await lab(W, 'p3.com', 'm6', 'unknown');
    await lab(W, 'c1.com', 'm6', 'taken'); await lab(W, 'c2.com', 'm6', 'not_taken');
    await db.insertInto('market_sales').values({ name: 'p1.com', venue: 'afternic', sale_price_cents: 90000, sale_date: '2026-03-01', source: 'test', tier: 'A', by: 'test' }).execute();
    await db.insertInto('market_sales').values({ name: 'c2.com', venue: 'afternic', sale_price_cents: 90000, sale_date: '2026-01-05', source: 'test', tier: 'A', by: 'test' }).execute(); // same day as the week: not after it
    const rep = (await get('/handreg/report')).json();
    expect(rep.note).toBe('proxy, not profit');
    expect(rep.weeks_n).toBe(1);
    expect(rep.horizons.m6.picks).toEqual({ n: 3, labelled_n: 2, taken_n: 1, taken_pct: 50, sold_n: 1, unknown_n: 1, pending_n: 0 });
    expect(rep.horizons.m6.control).toEqual({ n: 4, labelled_n: 2, taken_n: 1, taken_pct: 50, sold_n: 0, unknown_n: 0, pending_n: 2 });
    expect(rep.horizons.m6.comparison).toEqual({ status: 'UNPOWERED', events_n: 2, fisher_p: null });
    expect(rep.horizons.m12.picks).toMatchObject({ n: 3, labelled_n: 0, taken_n: 0, taken_pct: null, pending_n: 3 });
    expect(rep.horizons.m12.comparison.status).toBe('UNPOWERED');
  });

  it('HR66-21 with 10 or more taken events the comparison is a one-sided Fisher p (picks higher)', async () => {
    const { get } = await boot();
    const picks = Array.from({ length: 12 }, (_, i) => `pk${i}.com`);
    const control = Array.from({ length: 12 }, (_, i) => `ct${i}.com`);
    await fixtureWeek(W, picks, control);
    for (const [i, d] of picks.entries()) await lab(W, d, 'm6', i < 9 ? 'taken' : 'not_taken'); // 9 of 12
    for (const [i, d] of control.entries()) await lab(W, d, 'm6', i < 3 ? 'taken' : 'not_taken'); // 3 of 12
    const cmp = (await get('/handreg/report')).json().horizons.m6.comparison;
    expect(cmp).toMatchObject({ status: 'OK', events_n: 12 });
    // hypergeometric P(X >= 9) with 12 + 12, 12 events, 12 picks = 0.0089...
    expect(cmp.fisher_p).toBeGreaterThan(0.005);
    expect(cmp.fisher_p).toBeLessThan(0.02);
  });
});

describe('HR66 immutability', () => {
  it('HR66-30 a sealed week and its names cannot be changed or deleted; labels are the only table that moves', async () => {
    await fixtureWeek(W, ['p1.com'], ['c1.com']);
    await expect(db.updateTable('handreg_weeks').set({ picks_n: 5 }).execute()).rejects.toThrow();
    await expect(db.deleteFrom('handreg_weeks').execute()).rejects.toThrow();
    await expect(db.updateTable('handreg_names').set({ arm: 'control' }).where('domain', '=', 'p1.com').execute()).rejects.toThrow();
    await expect(db.deleteFrom('handreg_names').execute()).rejects.toThrow();
    await db.insertInto('handreg_labels').values({ week: W, domain: 'p1.com', horizon: 'm6', label: 'unknown', checked_at: new Date(), created_at_rdap: null, reason: null, attempts: 1 }).execute();
    await db.updateTable('handreg_labels').set({ label: 'taken' }).execute();
    expect(await label(W, 'p1.com')).toMatchObject({ label: 'taken' });
  });
});
