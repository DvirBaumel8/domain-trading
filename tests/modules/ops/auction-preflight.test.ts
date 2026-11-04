// v6.7.0 (CR-104): GET /auctions/preflight, the pre-run gate PF-01..PF-06 (rules: docs/internal/auctions.md "Pre-run gate"). Test ids CR104-T1..T14.
// Fixtures insert auction_shortlist, the closeouts pools and the manifests directly (the steps themselves are covered by their own tests).
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { makeApp, runJobToEnd } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { inventoryHandlers } from '../../helpers/datasave.js';
import { issueToken } from '../../helpers/tokens.js';
import { mswServer } from '../../setup/network.js';
import { getShortlist } from '../../../src/modules/ops/auctions/shortlist.js';
import { pf01UnscoredRows, pf02CountsReconcile, pf03JunkAtTop, pf04PriorKillServed, pf05Coverage, pf06StaleAsOf, PREFLIGHT_CHECKS, runChecks, runPreflight, type PreflightCtx } from '../../../src/modules/ops/auctions/preflight.js';

const NOW = Date.parse('2026-11-04T09:00:00Z');
const DATE = '2026-11-03';
const HOUR = 3_600_000;
let app: FastifyInstance | null = null;
afterEach(async () => { await app?.close(); app = null; });

const GOOD = ['northwind', 'bluecrest', 'silvermoon', 'tallpine', 'redwood'];
const SETTINGS = { preflight_max_digits: 4, preflight_min_coverage_bp: 9000, preflight_max_age_hours: 6 };

async function seedShortlist(names: string[] = GOOD, o: { generatedAt?: number; fieldN?: number } = {}): Promise<void> {
  await db.insertInto('auction_shortlist').values(names.map((n, i) => ({
    data_date: DATE, domain: `${n}.com`, rank: i + 1, score: 50, score_version: 'auction-v2', parts: JSON.stringify({}), price_cents: 2000, bids: 3,
    end_time: new Date(NOW + 30 * HOUR), auction_type: 'Bid', valuation_cents: null, domain_age: null, pageviews: null, max_bid_suggested_cents: 3000, reasons: [], prebid_id: null,
    prebid_verdict: null, dropped_reason: null, generated_at: new Date(o.generatedAt ?? NOW - HOUR), field_n: o.fieldN ?? names.length,
  }))).execute();
}
type Pool = [string, { score?: number | null; reason?: string | null; filter?: string | null }?][];
async function seedPools(gd: Pool, dy: Pool): Promise<void> {
  const ends = new Date(NOW + 86_400_000);
  const scored = (o: { score?: number | null; reason?: string | null; filter?: string | null } = {}) => ({ score: o.score === undefined ? 40 : o.score, score_reason: o.reason ?? null, filter_code: o.filter ?? null, scored_at: new Date(NOW) });
  if (gd.length) await db.insertInto('datasave_pool').values(gd.map(([domain, o]) => ({ data_date: DATE, source: 'godaddy_closeouts', domain, price_cents: 500, ends_at: ends, ...scored(o) }))).execute();
  if (dy.length) await db.insertInto('dynadot_rows').values(dy.map(([domain, o]) => ({ data_date: DATE, kind: 'closeouts' as const, domain, price_cents: 700, ends_at: ends, ...scored(o) }))).execute();
}
const manifest = (source: 'godaddy_inventory' | 'dynadot_closeouts' | 'dynadot_aftermarket', coverage: unknown = null, sealedAt = NOW - 2 * HOUR) =>
  db.insertInto('snapshot_manifests').values({
    source, data_date: DATE, file_name: source === 'godaddy_inventory' ? 'closeout_listings.json.zip' : 'bot_upload', status: 'complete', sha256: 'a'.repeat(64), sealed_at: new Date(sealedAt), rows: 1,
    coverage: coverage === null ? null : JSON.stringify(coverage),
  }).execute();
const FULL = { pages_planned: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], pages_ok: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], pages_failed: [], coverage_ratio: 1, coverage_status: 'OK' };
/** A clean day: a shortlist, scored closeouts on both sources, both sealed, full coverage. */
async function clean(): Promise<void> {
  await seedShortlist();
  await seedPools([['gdone.com'], ['gdtwo.com', { score: null, reason: 'NO_ACTIVE_MODEL' }]], [['dyone.com'], ['dytwo.com']]);
  await manifest('godaddy_inventory');
  await manifest('dynadot_closeouts', FULL);
}
const run = (q: { date?: string } = {}, now = NOW) => runPreflight(db, now, q);
const check = async (id: string, now = NOW) => (await run({}, now)).checks.find((c) => c.id === id)!;
async function ctxOf(over: Partial<PreflightCtx> = {}): Promise<PreflightCtx> {
  const shortlist = await getShortlist(db, { date: DATE, limit: 10_000, offset: 0 }, NOW);
  return { db, nowMs: NOW, dataDate: DATE, shortlist, settings: SETTINGS, ...over };
}

describe('pre-run gate (CR-104)', () => {
  it('CR104-T1: PF-01 passes when every shortlist row is scored and closeouts rows are scored or NO_ACTIVE_MODEL', async () => {
    await clean();
    expect(await check('PF-01')).toMatchObject({ pass: true, reason_code: null });
  });

  it('CR104-T2: PF-01 fails UNSCORED_ROWS on a NOT_SCORED_YET closeouts row (BUG-063 class), with source, n and sample; SCORE_FAILED fails too', async () => {
    await clean();
    await seedPools([['gdbad.com', { score: null, reason: null }]], [['dybad1.com', { score: null, reason: 'SCORE_FAILED' }], ['dybad2.com', { score: null, reason: null }]]);
    const c = await check('PF-01');
    expect(c).toMatchObject({ pass: false, reason_code: 'UNSCORED_ROWS' });
    const src = (c.details.sources as { source: string; n: number; sample: string[] }[]);
    expect(src.find((x) => x.source === 'godaddy')).toMatchObject({ n: 1, sample: ['gdbad.com'] });
    expect(src.find((x) => x.source === 'dynadot')).toMatchObject({ n: 2 });
    expect(src.find((x) => x.source === 'dynadot')!.sample).toEqual(['dybad1.com', 'dybad2.com']);
  });

  it('CR104-T3: PF-02 passes on real data (total + prior_kill_excluded_n + ended_n + prebid_dropped_n + not_stored_n = field_n), including not-stored names', async () => {
    await seedShortlist(GOOD, { fieldN: 9 });
    await db.updateTable('auction_shortlist').set({ end_time: new Date(NOW - HOUR) }).where('domain', '=', 'redwood.com').execute();
    await db.updateTable('auction_shortlist').set({ dropped_reason: 'prebid fail' }).where('domain', '=', 'tallpine.com').execute();
    const c = await check('PF-02');
    expect(c).toMatchObject({ pass: true, details: { total: 3, ended_n: 1, prebid_dropped_n: 1, not_stored_n: 4, field_n: 9, diff: 0 } });
  });

  it('CR104-T4: PF-02 fails COUNTS_DONT_RECONCILE on a fabricated summary, with each term and the diff', async () => {
    await clean();
    const c0 = await ctxOf();
    const r = await pf02CountsReconcile({ ...c0, shortlist: { ...c0.shortlist, field_n: c0.shortlist.field_n + 3 } });
    expect(r).toMatchObject({ pass: false, reason_code: 'COUNTS_DONT_RECONCILE', details: { total: 5, field_n: 8, sum: 5, diff: -3 } });
    expect(Object.keys(r.details)).toEqual(expect.arrayContaining(['prior_kill_excluded_n', 'ended_n', 'prebid_dropped_n', 'not_stored_n']));
  });

  it('CR104-T5: PF-03 passes on clean names; 4 digits are within the limit, a word-and-digits name is not junk', async () => {
    await seedShortlist([...GOOD, 'room1234', 'decade']);
    await seedPools([['abcd.com'], ['cloud9.com']], [['wellness.com']]);
    await manifest('godaddy_inventory');
    await manifest('dynadot_closeouts', FULL);
    expect(await check('PF-03')).toMatchObject({ pass: true, reason_code: null });
  });

  it('CR104-T6: PF-03 fails JUNK_AT_TOP on all-digit, hex-like and many-digit names in the shortlist and in closeouts, with source and rank', async () => {
    await seedShortlist(['northwind', '48213907', 'bluecrest', 'deadbeef7', 'plot12345']);
    await seedPools([['goodname.com', { score: 90 }]], [['9988776655.com', { score: 80 }], ['quietlake.com', { score: 10 }]]);
    await manifest('godaddy_inventory');
    await manifest('dynadot_closeouts', FULL);
    const c = await check('PF-03');
    expect(c).toMatchObject({ pass: false, reason_code: 'JUNK_AT_TOP' });
    const names = c.details.names as { domain: string; source: string; rank: number }[];
    expect(names.filter((n) => n.source === 'shortlist')).toEqual([
      { domain: '48213907.com', source: 'shortlist', rank: 2 }, { domain: 'deadbeef7.com', source: 'shortlist', rank: 4 }, { domain: 'plot12345.com', source: 'shortlist', rank: 5 },
    ]);
    expect(names.find((n) => n.domain === '9988776655.com')).toMatchObject({ source: 'closeouts_dynadot', rank: 2 });
  });

  it('CR104-T7: PF-04 passes when a killed name is left out of the served rows by the shortlist', async () => {
    await clean();
    await db.insertInto('auction_kills').values({ domain: 'northwind.com', kill_stage: 'prior_exclude', data_date_at_kill: '2026-11-02', run_id: 'p1', killed_at: new Date(NOW - 24 * HOUR), by: 'buyer' }).execute();
    const j = await getShortlist(db, { date: DATE, limit: 100, offset: 0 }, NOW);
    expect(j.rows.map((r) => r.domain)).not.toContain('northwind.com');
    expect(await check('PF-04')).toMatchObject({ pass: true, reason_code: null });
  });

  it('CR104-T8: PF-04 fails PRIOR_KILL_SERVED when a served row has an active kill and no prior_kill (fabricated served rows); a revoked kill does not count', async () => {
    await clean();
    const kill = (await db.insertInto('auction_kills').values({ domain: 'northwind.com', kill_stage: 'prior_exclude', data_date_at_kill: '2026-11-02', run_id: 'p1', killed_at: new Date(NOW - 24 * HOUR), by: 'buyer' }).returning('id').executeTakeFirstOrThrow());
    await db.insertInto('auction_kills').values({ domain: 'bluecrest.com', kill_stage: 'prior_exclude', data_date_at_kill: '2026-11-02', run_id: 'p1', killed_at: new Date(NOW - 24 * HOUR), by: 'buyer' }).execute();
    const bl = await db.selectFrom('auction_kills').select('id').where('domain', '=', 'bluecrest.com').executeTakeFirstOrThrow();
    await db.insertInto('auction_kills').values({ domain: 'bluecrest.com', kill_stage: 'revoked', supersedes: bl.id, data_date_at_kill: '2026-11-02', run_id: 'p2', killed_at: new Date(NOW - HOUR), by: 'buyer' }).execute();
    expect(kill.id).toBeDefined();
    const c0 = await ctxOf();
    const fake = (domain: string) => ({ ...c0.shortlist.rows[0]!, domain, prior_kill: null });
    const r = await pf04PriorKillServed({ ...c0, shortlist: { ...c0.shortlist, rows: [...c0.shortlist.rows, fake('northwind.com')] } });
    expect(r).toMatchObject({ pass: false, reason_code: 'PRIOR_KILL_SERVED', details: { n: 1, names: ['northwind.com'] } });
    // bluecrest.com's kill is revoked: not a blocker
    expect(await pf04PriorKillServed({ ...c0, shortlist: { ...c0.shortlist, rows: [fake('bluecrest.com')] } })).toMatchObject({ pass: true });
  });

  it('CR104-T9: PF-05 passes with full coverage, a flagged partial day above the minimum, and a source without a manifest (noted)', async () => {
    await seedShortlist();
    await manifest('godaddy_inventory');
    await manifest('dynadot_closeouts', { ...FULL, pages_ok: [1, 2, 3, 4, 5, 6, 7, 8, 9], pages_failed: [10], coverage_ratio: 0.9, coverage_status: 'OK' });
    const c = await check('PF-05');
    expect(c).toMatchObject({ pass: true, reason_code: null });
    expect((c.details.sources as Record<string, unknown>).dynadot_aftermarket).toBe('no manifest for the date');
  });

  it('CR104-T10: PF-05 fails COVERAGE_UNFLAGGED when pages failed and no coverage_status flag is present', async () => {
    await seedShortlist();
    await manifest('dynadot_closeouts', { pages_planned: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], pages_ok: [1, 2, 3, 4, 5, 6, 7, 8, 9], pages_failed: [10] });
    const c = await check('PF-05');
    expect(c).toMatchObject({ pass: false, reason_code: 'COVERAGE_UNFLAGGED' });
    expect((c.details.problems as { source: string }[])[0]).toMatchObject({ source: 'dynadot_closeouts', code: 'COVERAGE_UNFLAGGED', pages_failed: 1 });
  });

  it('CR104-T10b: PF-05 fails COVERAGE_BELOW_MIN when the ratio is under settings.preflight_min_coverage_bp even if flagged (and the setting moves the line)', async () => {
    await seedShortlist();
    await manifest('dynadot_aftermarket', { pages_planned: [1, 2, 3, 4], pages_ok: [1, 2], pages_failed: [3, 4], coverage_ratio: 0.5, coverage_status: 'LOW_COVERAGE' });
    const c = await check('PF-05');
    expect(c).toMatchObject({ pass: false, reason_code: 'COVERAGE_BELOW_MIN' });
    expect((c.details.problems as { coverage: number; min_coverage: number }[])[0]).toMatchObject({ coverage: 0.5, min_coverage: 0.9 });
    expect(await pf05Coverage(await ctxOf({ settings: { ...SETTINGS, preflight_min_coverage_bp: 4000 } }))).toMatchObject({ pass: true });
  });

  it('CR104-T11: PF-06 passes when the shortlist is younger than preflight_max_age_hours (age_h and newest_seal_at in details)', async () => {
    await clean();
    const c = await check('PF-06');
    expect(c).toMatchObject({ pass: true, details: { age_h: 1, max_age_h: 12 } });
    expect(c.details.newest_seal_at).not.toBeNull();
  });

  it('CR104-T12: PF-06 fails STALE_AS_OF when as_of is more than 12 hours (the default) after generated_at, and when there is no shortlist at all', async () => {
    await clean();
    const late = await check('PF-06', NOW + 12 * HOUR);
    expect(late).toMatchObject({ pass: false, reason_code: 'STALE_AS_OF', details: { age_h: 13, max_age_h: 12 } });
    expect(await check('PF-06', NOW + 8 * HOUR)).toMatchObject({ pass: true }); // the nightly run, about 8.5 h after the build
    expect(await pf06StaleAsOf(await ctxOf({ settings: { ...SETTINGS, preflight_max_age_hours: 24 } }))).toMatchObject({ pass: true });
    await db.deleteFrom('auction_shortlist').execute();
    const none = await run({});
    expect(none.checks.find((c) => c.id === 'PF-06')).toMatchObject({ pass: false, reason_code: 'STALE_AS_OF', details: { reason: 'no shortlist' } });
    expect(none.pass).toBe(false);
  });

  it('CR104-T13: pass is false when any check fails; the datasave step preflight reports the same answer; a retired check passes with its reason; checks_sha256 is the hash of the checks', async () => {
    // a clean day but a stale shortlist (PF-06) -> pass:false; everything else passes
    await seedShortlist(GOOD, { generatedAt: NOW - 14 * HOUR });
    await seedPools([['gdone.com']], [['dyone.com']]);
    await manifest('godaddy_inventory');
    await manifest('dynadot_closeouts', FULL);
    const direct = await run({});
    expect(direct.pass).toBe(false);
    expect(direct.checks.filter((c) => !c.pass).map((c) => [c.id, c.reason_code])).toEqual([['PF-06', 'STALE_AS_OF']]);
    expect(direct.checks_sha256).toBe(createHash('sha256').update(JSON.stringify(direct.checks)).digest('hex'));
    expect(PREFLIGHT_CHECKS.map((c) => c.id)).toEqual(['PF-01', 'PF-02', 'PF-03', 'PF-04', 'PF-05', 'PF-06']);
    const retired = await runChecks(await ctxOf(), [{ ...PREFLIGHT_CHECKS[5]!, retired: 'replaced by a better check' }]);
    expect(retired[0]).toMatchObject({ id: 'PF-06', pass: true, reason_code: null, details: { retired: 'replaced by a better check' } });

    mswServer.use(...inventoryHandlers());
    app = await makeApp({ testRoutes: false, now: () => NOW, env: { JOB_TRIGGER_TOKEN: 'job_token_fake_0123456789abcdef0123456789' } });
    const job = await runJobToEnd(app, 'datasave');
    const steps = job.json().steps as Record<string, { status: string; summary?: Record<string, unknown> }>;
    expect(Object.keys(steps).pop()).toBe('preflight');
    expect(steps.preflight).toMatchObject({ status: 'done' });
    const viaStep = steps.preflight!.summary as { pass: boolean; checks: { id: string; pass: boolean; reason_code: string | null }[] };
    expect(viaStep.pass).toBe(false);
    expect(viaStep.checks.filter((c) => !c.pass).map((c) => [c.id, c.reason_code])).toEqual([['PF-06', 'STALE_AS_OF']]);
  });

  it('CR104-T14: READ and bots tokens get 200, no token gets 401, and the route writes nothing', async () => {
    await clean();
    app = await makeApp({ now: () => NOW });
    const r = (await issueToken('read', 'reader')).auth;
    const b = (await issueToken('bots', 'buyer')).auth;
    const tables = ['audit_log', 'auction_shortlist', 'auction_kills', 'datasave_pool', 'dynadot_rows', 'snapshot_manifests', 'settings', 'job_runs', 'job_steps', 'api_usage'];
    const counts = async () => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, Number((await sql<{ n: string }>`select count(*)::text as n from ${sql.table(t)}`.execute(db)).rows[0]!.n)])));
    const before = await counts();
    const res = await app.inject({ method: 'GET', url: `/auctions/preflight?date=${DATE}`, headers: r });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ data_date: DATE, pass: true, checks: expect.any(Array) });
    expect(res.json().checks.map((c: { id: string }) => c.id)).toEqual(['PF-01', 'PF-02', 'PF-03', 'PF-04', 'PF-05', 'PF-06']);
    expect((await app.inject({ method: 'GET', url: '/auctions/preflight', headers: b })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/auctions/preflight' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/auctions/preflight?date=nope', headers: r })).statusCode).toBe(400);
    expect(await counts()).toEqual(before);
  });
});
