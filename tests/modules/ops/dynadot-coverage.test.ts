// v5.80.0 (CR-099): Dynadot low-coverage days. Retry with pauses inside the step, LOW_COVERAGE under 90% of planned pages, a same-day top-up of the missing pages,
// the re-pull option of POST /jobs/run, the closeouts pages planned from the total, and the market steps leaving a LOW_COVERAGE day out.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { http, HttpResponse } from 'msw';
import { runDqMarket, runEpisodes } from '../../../src/modules/market/index.js';
import { DatasaveJob } from '../../../src/modules/ops/jobs/datasave/datasave.js';
import { dynadotNeedsRetry } from '../../../src/modules/ops/queue.js';
import { uploadDynadot } from '../../../src/modules/ops/jobs/datasave/dynadot-upload.js';
import { makeApp } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { issueToken } from '../../helpers/tokens.js';
import { mswServer } from '../../setup/network.js';

const BASE = 'https://api.dynadot.com';
const LISTINGS = `${BASE}/restful/v2/aftermarket/listings`;
const CO_PATH = '/restful/v2/aftermarket/fake_closeouts';
const DAY1 = Date.parse('2026-10-30T15:30:00Z');

let clock = DAY1;
const delays: number[] = [];
let app: FastifyInstance | undefined;
afterEach(async () => { clock = DAY1; delays.length = 0; await app?.close(); app = undefined; });

function dynadot(url: string, handler: (page: number) => { status?: number; body?: unknown }) {
  const seen: number[] = [];
  mswServer.use(http.get(url, ({ request }) => {
    const page = Number(new URL(request.url).searchParams.get('page'));
    seen.push(page);
    const r = handler(page);
    return HttpResponse.json((r.body ?? {}) as never, { status: r.status ?? 200 });
  }));
  return seen;
}
const ok = (data: unknown) => ({ body: { code: 200, message: 'Success', data } });
const listing = (domain: string, id: string, price: string) => ({ listing_id: id, domain, price, type: 'BIN' });
// 10 pages of 1 listing each (total 10); page n holds name-n.com at $600
const amPage = (page: number) => ok({ total: 10, listing_item_list: [listing(`name-${page}.com`, `L${page}`, '600')] });
const mk = () => new DatasaveJob({ db, now: () => clock, snapshotDir: '/nonexistent', dynadotKey: 'k_fake_0123456789', dynadotSecret: 's_fake_0123456789', dynadotCloseoutsPath: CO_PATH,
  sleep: async (ms) => { delays.push(ms); }, random: () => 0.5 });
const manifest = (source: string, d: string) => db.selectFrom('snapshot_manifests').selectAll().where('source', '=', source as never).where('data_date', '=', d).where('file_name', '=', 'bot_upload').executeTakeFirstOrThrow();

describe('CR-099 Dynadot low coverage', () => {
  it('CR099-1: pages failing in a row pause 15/30/60/120 s, end the sweep after 5, get one retry sweep; the day is sealed LOW_COVERAGE; a same-day top-up adds only the missing pages', async () => {
    let down = true;
    const seen = dynadot(LISTINGS, (p) => (down && p >= 3 ? { status: 500 } : amPage(p)));
    const s = await mk().dynadotAftermarket() as Record<string, unknown>;
    expect(s).toMatchObject({ status: 'partial', sealed: true, rows_n: 2, coverage_status: 'LOW_COVERAGE' });
    expect(s.coverage).toMatchObject({ pages_ok: [1, 2], pages_failed: [3, 4, 5, 6, 7, 8, 9, 10], coverage_ratio: 0.2, coverage_status: 'LOW_COVERAGE', stopped_by: 'consecutive_failures', retried_pages_n: 8 });
    // the pauses after failures (jitter 0.5 = none): 15, 30, 60, 120 s in the first sweep, 120 s before the retry sweep, 15, 30, 60, 120 s in the retry sweep
    expect(delays.filter((d) => d !== 5000)).toEqual([15_000, 30_000, 60_000, 120_000, 120_000, 15_000, 30_000, 60_000, 120_000]);
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 3, 4, 5, 6, 7]);
    const before = await manifest('dynadot_aftermarket', '2026-10-30');
    // later the same day Dynadot answers again: only pages 3..10 are asked, their rows are added, the seal stays, the sha256 moves
    down = false; seen.length = 0; clock += 3_600_000;
    const t = await mk().dynadotAftermarket() as Record<string, unknown>;
    expect(seen).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    expect(t).toMatchObject({ top_up: true, status: 'sealed', rows_n: 10, added_n: 8, coverage_status: 'OK' });
    const after = await manifest('dynadot_aftermarket', '2026-10-30');
    expect(after.sealed_at!.getTime()).toBe(before.sealed_at!.getTime());
    expect(after.sha256).not.toBe(before.sha256);
    expect(after.rows).toBe(10);
    expect(after.coverage).toMatchObject({ pages_ok: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], pages_failed: [], coverage_status: 'OK', top_ups: [{ pages_tried_n: 8, pages_ok_n: 8 }] });
    // a full-coverage day is frozen: the next run is the no-op
    seen.length = 0;
    expect(await mk().dynadotAftermarket()).toMatchObject({ status: 'SNAPSHOT_SEALED' });
    expect(seen).toEqual([]);
  });

  it('CR099-2: a pull stops at its time budget and says so', async () => {
    dynadot(LISTINGS, (p) => { if (p === 4) clock += 51 * 60_000; return amPage(p); });
    const s = await mk().dynadotAftermarket() as Record<string, unknown>;
    expect(s.coverage).toMatchObject({ pages_ok: [1, 2, 3, 4], pages_failed: [5, 6, 7, 8, 9, 10], stopped_by: 'time_cap', coverage_status: 'LOW_COVERAGE' });
  });

  it('CR099-3 (d): closeouts with a total are planned from it, so the pages past the end are never asked or counted as failed', async () => {
    const item = (n: number) => ({ domain_name: `c${n}.com`, current_price: '1500', end_time_stamp: 1792000000000 });
    const seen = dynadot(`${BASE}${CO_PATH}`, (p) => (p <= 3 ? ok({ total: 5, closeout_item_list: p < 3 ? [item(p * 2 - 1), item(p * 2)] : [item(5)] }) : { status: 500 }));
    const s = await mk().dynadotCloseouts() as Record<string, unknown>;
    expect(seen).toEqual([1, 2, 3]);
    expect(s).toMatchObject({ status: 'sealed', rows_n: 5, coverage_status: 'OK' });
    expect(s.coverage).toMatchObject({ pages_planned: [1, 2, 3], pages_failed: [], total_listings: 5 });
  });

  it('CR099-4 (c): POST /jobs/run {job: datasave, only} re-pulls one source for a LOW_COVERAGE or open day (WRITE only); a full-coverage day is 409 SNAPSHOT_SEALED', async () => {
    const JOB = 'job_token_fake_0123456789abcdef0123456789';
    app = await makeApp({ now: () => clock, env: { JOB_TRIGGER_TOKEN: JOB } });
    const w = (await issueToken('write', 'gavriel')).auth;
    const r = (await issueToken('read')).auth;
    const run = (h: Record<string, string>, body: object) => app!.inject({ method: 'POST', url: '/jobs/run', headers: { ...h, 'idempotency-key': randomUUID() }, payload: body });
    // open day: queued with just that step
    const open = await run(w, { job: 'datasave', only: 'dynadot_aftermarket' });
    expect(open.statusCode).toBe(202);
    expect(open.json().steps).toEqual(['dynadotAftermarket']);
    await db.deleteFrom('job_steps').execute();
    await db.deleteFrom('job_queue_runs').execute();
    const cov = (okPages: number[]) => ({ origin: 'server' as const, coverage: { partial: true, calls_n: 1, pages_planned: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], pages_ok: okPages, pages_failed: [], rows_received_n: 1 } });
    // aftermarket sealed with full coverage, closeouts sealed with 2 of 10 pages
    await uploadDynadot(db, { kind: 'aftermarket', data_date: '2026-10-30', rows: [{ domain: 'a.com', listing_id: 'L1', price_cents: 60_000 }], final: true }, clock, cov([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    await uploadDynadot(db, { kind: 'closeouts', data_date: '2026-10-30', rows: [{ domain: 'c.com', price_cents: 1_500 }], final: true }, clock, cov([1, 2]));
    const full = await run(w, { job: 'datasave', only: 'dynadot_aftermarket' });
    expect(full.statusCode).toBe(409);
    expect(full.json().error).toMatchObject({ code: 'SNAPSHOT_SEALED', details: { source: 'dynadot_aftermarket', data_date: '2026-10-30', coverage_ratio: 1 } });
    const low = await run(w, { job: 'datasave', only: 'dynadot_closeouts' });
    expect(low.statusCode).toBe(202);
    expect(low.json().steps).toEqual(['dynadotCloseouts']);
    // a sealed full day can never be changed, also not by the guard's top-up rule
    await expect(db.updateTable('snapshot_manifests').set({ rows: 99 }).where('source', '=', 'dynadot_aftermarket').execute()).rejects.toThrow(/UPDATE is not allowed/);
    expect((await run(w, { job: 'daily', only: 'dynadot_aftermarket' })).statusCode).toBe(422);
    // the Worker's job token can't re-pull (a WRITE token's run is audited under its name)
    expect((await run({ authorization: `Bearer ${JOB}` }, { job: 'datasave', only: 'dynadot_closeouts' })).statusCode).toBe(403);
    // the LOW_COVERAGE day shows in /health and /report
    const h = (await app.inject({ method: 'GET', url: '/health', headers: r })).json();
    expect(h.datasave_detail.dynadot_low_coverage).toEqual([{ source: 'dynadot_closeouts', data_date: '2026-10-30', coverage_ratio: 0.2, pages_ok_n: 2, pages_planned_n: 10 }]);
    const rep = (await app.inject({ method: 'GET', url: '/report', headers: r })).json();
    expect(rep.warnings.find((x: { code: string }) => x.code === 'DYNADOT_LOW_COVERAGE')).toBeTruthy();
  });

  it('CR099-5 (a): episodes and the DQ leave a LOW_COVERAGE day out: a name missing from it stays one episode and is still open; DQ coverage fails that day', async () => {
    const day = async (d: string, names: string[], okPages: number[]) => uploadDynadot(db, { kind: 'aftermarket', data_date: d, rows: names.map((n, i) => ({ domain: n, listing_id: `${d}-${i}`, price_cents: 60_000 })), final: true },
      Date.parse(`${d}T20:00:00Z`), { origin: 'server', coverage: { partial: false, calls_n: 10, pages_planned: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], pages_ok: okPages, pages_failed: [], rows_received_n: names.length } });
    const all = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    await day('2026-10-28', ['keep.com', 'other.com'], all);
    await day('2026-10-29', ['keep.com', 'other.com'], all);
    await day('2026-10-30', ['other.com'], [1, 2]); // LOW_COVERAGE: keep.com is on a page that failed
    const s = await runEpisodes(db, Date.parse('2026-10-31T16:00:00Z'));
    expect(s.sealed_days.dynadot_aftermarket).toBe('2026-10-29');
    const keep = await db.selectFrom('market_names').selectAll().where('name', '=', 'keep.com').execute();
    expect(keep).toHaveLength(1);
    expect(keep[0]).toMatchObject({ last_seen: '2026-10-29' });
    const dq = await runDqMarket(db, Date.parse('2026-10-31T16:00:00Z'));
    expect(dq.results.find((r) => r.check === 'coverage' && r.day === '2026-10-30')).toMatchObject({ status: 'fail', detail: { coverage_status: 'LOW_COVERAGE', pages_ok_n: 2, pages_planned_n: 10 } });
  });

  it('CR099-6 (b): a Dynadot step that ended LOW_COVERAGE, error or failed is retried alone an hour later; a datasave run with params.only plans just that step', async () => {
    expect(dynadotNeedsRetry({ status: 'done', summary: { status: 'partial', coverage_status: 'LOW_COVERAGE' } })).toBe(true);
    expect(dynadotNeedsRetry({ status: 'done', summary: JSON.stringify({ status: 'error' }) })).toBe(true);
    expect(dynadotNeedsRetry({ status: 'failed' })).toBe(true);
    for (const summary of [{ status: 'sealed', coverage_status: 'OK' }, { status: 'not_configured' }, { status: 'gap' }, { status: 'SNAPSHOT_SEALED' }]) expect(dynadotNeedsRetry({ status: 'done', summary })).toBe(false);
    app = await makeApp({ now: () => clock });
    expect(app.jobRunner.plan('datasave', { params: { retry: true, only: ['dynadotAftermarket'] } }).map((p) => p.name)).toEqual(['dynadotAftermarket']);
    expect(app.jobRunner.plan('datasave').map((p) => p.name)).toHaveLength(12);
  });
});
