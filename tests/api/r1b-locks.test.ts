// R1b: database locks instead of in-process flags, one shared RDAP pacer per host, fewer engine round trips, light progress reads, step timings.
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import type { KyselyPlugin, PluginTransformQueryArgs, PluginTransformResultArgs } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { lockText, trySessionLock, withAdvisoryLock, withSessionLock } from '../../src/core/locks.js';
import { createRun } from '../../src/modules/selection/engine.js';
import { TEST_SET_RDAP_CONCURRENCY, hostPacer, lookupCached, pacerFor, settleHostPacers } from '../../src/modules/selection/rdap-batch.js';
import type { RdapLookup, RdapLookupFn } from '../../src/core/rdap.js';
import type { ScreeningDeps } from '../../src/modules/selection/types.js';
import { makeApp, runJobToEnd } from '../helpers/app.js';
import { testDb } from '../helpers/db.js';
import { OFFLINE, putBrandLists, putList, screeningHarness } from '../helpers/screening.js';

const JOB_TOKEN = 'job_token_fake_0123456789abcdef0123456789';
const bearer = { authorization: `Bearer ${JOB_TOKEN}` };
const apps: FastifyInstance[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });
const make = async (extra: Parameters<typeof makeApp>[0] = {}) => {
  const a = await makeApp({ testRoutes: false, env: { JOB_TRIGGER_TOKEN: JOB_TOKEN }, ...extra });
  apps.push(a);
  return a;
};
let n = 0;
// v3.0.0: enqueue (202) and wait for the worker; an overlap comes back as {skipped:true, steps:{}}.
const run = (app: FastifyInstance, job: string) => runJobToEnd(app, job, { headers: bearer, key: `r1b-${++n}` });
const until = async (f: () => boolean) => { for (let i = 0; i < 400 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); expect(f()).toBe(true); };

describe('R1b-1 lock registry', () => {
  it('a domain key hashes the bare domain (the key /buy has always used); other keys hash as written', () => {
    expect(lockText('domain:example.com')).toBe('example.com');
    expect(lockText('posts_cap')).toBe('posts_cap');
    expect(lockText('pack:example.com')).toBe('pack:example.com');
  });

  it('a session lock is held by one session at a time and is free again after release', async () => {
    const a = await trySessionLock(testDb, 'job:daily');
    expect(a).not.toBeNull();
    expect(await trySessionLock(testDb, 'job:daily')).toBeNull();
    expect((await withSessionLock(testDb, 'job:daily', async () => 1)).ran).toBe(false);
    await a!.release();
    expect(await withSessionLock(testDb, 'job:daily', async () => 7)).toEqual({ ran: true, value: 7 });
    const again = await trySessionLock(testDb, 'job:daily');
    expect(again).not.toBeNull();
    await again!.release();
  });

  it('a session lock is released when the work throws', async () => {
    await expect(withSessionLock(testDb, 'review_run', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    const l = await trySessionLock(testDb, 'review_run');
    expect(l).not.toBeNull();
    await l!.release();
  });

  it('withAdvisoryLock serialises two transactions on the same key', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const first = withAdvisoryLock(testDb, 'posts_cap', async () => { order.push('first in'); await gate; order.push('first out'); });
    await until(() => order.includes('first in'));
    const second = withAdvisoryLock(testDb, 'posts_cap', async () => { order.push('second in'); });
    await new Promise((r) => setTimeout(r, 100));
    expect(order).toEqual(['first in']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first in', 'first out', 'second in']);
  });
});

describe('R1b-2 runs are exclusive across app instances', () => {
  it('two app instances on one database do not run daily at the same time; the second is skipped:true', async () => {
    let started = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const a = await make({ backupExport: { runOnce: async () => { started = true; await gate; return { skipped: true, reason: 'test' }; } } });
    const b = await make();
    const first = run(a, 'daily');
    await until(() => started);
    const second = await run(b, 'daily');
    expect(second.json()).toMatchObject({ job: 'daily', skipped: true, steps: {} });
    // tick is its own lock: it still runs while the daily run is going
    expect((await run(b, 'tick')).json()).toMatchObject({ job: 'tick', skipped: false });
    release();
    expect((await first).json()).toMatchObject({ job: 'daily', skipped: false });
    expect((await run(b, 'daily')).json()).toMatchObject({ job: 'daily', skipped: false });
  });

  it('a job run on another instance is reported as skipped by the job itself', async () => {
    const a = await make();
    const lock = await trySessionLock(testDb, 'job:price');
    expect(lock).not.toBeNull();
    expect(await a.priceJob.runOnce()).toMatchObject({ skipped: true });
    await lock!.release();
    expect(await a.priceJob.runOnce()).toMatchObject({ skipped: false });
  });

  it('every step of a job run carries its duration in ms', async () => {
    const a = await make();
    const steps = (await run(a, 'daily')).json().steps as Record<string, { ms: unknown }>;
    expect(Object.keys(steps).length).toBeGreaterThan(5);
    for (const s of Object.values(steps)) expect(typeof s.ms).toBe('number');
    const stored = (await testDb.selectFrom('job_runs').select('steps').orderBy('id', 'desc').executeTakeFirstOrThrow()).steps as Record<string, { ms: unknown }>;
    expect(Object.values(stored).every((s) => typeof s.ms === 'number')).toBe(true);
  });
});

const rdapResult = (outcome: 'not_registered' | 'unknown', status = 404): RdapLookup => ({ outcome, reasonCode: outcome === 'unknown' ? 'RATE_LIMITED' : null, httpStatus: status, url: 'https://rdap.example/domain/x', retrievedAt: new Date(), body: null, facts: null, retryAfterMs: null });
const sleep = async () => {};
const ctxOf = (settings: { rdap_min_ms_between: number; rdap_concurrency: number }, testSet?: object) =>
  ({ shared: new Map(), run: { testSet }, settings: { run: settings }, deps: { sleep } }) as never;

describe('R1b-3 one RDAP pacer per host for the whole process', () => {
  it('two runs on the same host share its 4-in-flight ceiling', async () => {
    let inFlight = 0; let max = 0;
    const rdap: RdapLookupFn = async () => { inFlight++; max = Math.max(max, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; return rdapResult('not_registered'); };
    const deps = { rdapLookup: rdap, sleep } as unknown as ScreeningDeps;
    const a = pacerFor(ctxOf({ rdap_min_ms_between: 1, rdap_concurrency: 8 }, { maxAnswerAgeDays: 7 }));
    const b = pacerFor(ctxOf({ rdap_min_ms_between: 1, rdap_concurrency: 8 }, { maxAnswerAgeDays: 7 }));
    const o = (pace: typeof a) => ({ maxAgeHours: 0, evidenceMaxBytes: 1000, pace });
    await Promise.all(Array.from({ length: 24 }, (_, i) => lookupCached(testDb, deps, `shared${i}x.com`, o(i % 2 ? a : b))));
    expect(max).toBeLessThanOrEqual(TEST_SET_RDAP_CONCURRENCY);
    expect(max).toBeGreaterThan(1);
  });

  it('a live run with a stricter limit keeps it on top of the shared one (min of the two)', async () => {
    let inFlight = 0; let max = 0;
    const rdap: RdapLookupFn = async () => { inFlight++; max = Math.max(max, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; return rdapResult('not_registered'); };
    const deps = { rdapLookup: rdap, sleep } as unknown as ScreeningDeps;
    const live = pacerFor(ctxOf({ rdap_min_ms_between: 1000, rdap_concurrency: 1 }));
    expect([live.maxConcurrency, live.minGapMs]).toEqual([1, 1000]);
    await Promise.all(Array.from({ length: 8 }, (_, i) => lookupCached(testDb, deps, `gate${i}x.com`, { maxAgeHours: 0, evidenceMaxBytes: 1000, pace: live })));
    expect(max).toBe(1);
    // a live run with a looser limit than the ceiling is held to the ceiling
    const loose = pacerFor(ctxOf({ rdap_min_ms_between: 10, rdap_concurrency: 16 }));
    expect([loose.maxConcurrency, loose.minGapMs]).toEqual([TEST_SET_RDAP_CONCURRENCY, 250]);
  });

  it('the circuit breaker and the slow-down are shared between runs, and settle when no run is going', async () => {
    const deps = { rdapLookup: async () => rdapResult('unknown', 429), sleep } as unknown as ScreeningDeps;
    const a = pacerFor(ctxOf({ rdap_min_ms_between: 250, rdap_concurrency: 4 }, { maxAnswerAgeDays: 7 }));
    for (let i = 0; i < 6; i++) await lookupCached(testDb, deps, `brk${i}x.com`, { maxAgeHours: 0, evidenceMaxBytes: 1000, pace: a });
    expect(a.breakerOpen).toBe(true);
    const b = pacerFor(ctxOf({ rdap_min_ms_between: 250, rdap_concurrency: 4 }, { maxAnswerAgeDays: 7 }));
    expect(b.breakerOpen).toBe(true);
    expect(b.minGapMs).toBeGreaterThan(250);
    // another host is unaffected
    expect(pacerFor(ctxOf({ rdap_min_ms_between: 250, rdap_concurrency: 4 }, { maxAnswerAgeDays: 7 }), 'https://rdap.other.example/').breakerOpen).toBe(false);
    // when no run is going any more the shared pacers settle back to the base rate (a later run is not held back by it)
    settleHostPacers(sleep);
    expect(b.breakerOpen).toBe(false);
    expect([b.minGapMs, b.maxConcurrency]).toEqual([250, 4]);
    expect(hostPacer('x.example', sleep)).toBe(hostPacer('x.example', sleep));
  });
});

interface Counted { sqls: string[] }
const counter = (c: Counted): KyselyPlugin => ({
  transformQuery(args: PluginTransformQueryArgs) { c.sqls.push(testDb.getExecutor().compileQuery(args.node, args.queryId).sql); return args.node; },
  async transformResult(args: PluginTransformResultArgs) { return args.result; },
});

describe('R1b-4 screening engine round trips', () => {
  it('a 20-name run writes the heartbeat a few times, not once per result, and reads manual rows only for manual-capable checks', async () => {
    await putBrandLists();
    const c: Counted = { sqls: [] };
    const x = await screeningHarness({ db: testDb.withPlugin(counter(c)) });
    apps.push(x.app);
    const names = Array.from({ length: 20 }, (_, i) => ({ domain: `rtname${String.fromCharCode(97 + i)}roofing.com`, lane: 'S3' }));
    const { body } = await x.runDone({ checks: ['form', 'brand_lists', 'concentration'], names });
    expect(body.names).toHaveLength(20);
    const inserts = c.sqls.filter((s) => /^insert into "screening_results"/.test(s)).length;
    const beats = c.sqls.filter((s) => /^update "screening_runs" set "heartbeat_at"/.test(s)).length;
    const manualReads = c.sqls.filter((s) => /from "screening_results"/.test(s) && /"source" = \$/.test(s) && /"check_id" = \$/.test(s) && /order by "id" desc limit/.test(s)).length;
    const statusReads = c.sqls.filter((s) => /^select "status" from "screening_runs"/.test(s)).length;
    if (process.env.R1B_COUNT) process.stderr.write(`R1B-COUNT ${JSON.stringify({ total: c.sqls.length, inserts, beats, manualReads, statusReads })}\n`);
    expect(inserts).toBeGreaterThanOrEqual(40);
    expect(beats).toBeLessThanOrEqual(2); // was one per result
    expect(manualReads).toBe(0); // was one per result
    expect(statusReads).toBeLessThanOrEqual(2); // was one per check
  });
});
