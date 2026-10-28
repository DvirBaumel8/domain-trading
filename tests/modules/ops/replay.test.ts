// v5.59.0 (CR-081): the daily archive, the pick-proof switch-off and the historical replay. Rules and ids: docs/internal/replay.md. No outside call: the inventory host is mocked (MSW),
// the archive lives in the test folder, the replay reads only files and the test database.
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../../../src/config.js';
import { DatasaveJob } from '../../../src/modules/ops/jobs/datasave/datasave.js';
import { archivePath, archiveStatus } from '../../../src/modules/ops/archive/godaddy-archive.js';
import { liftAsOf } from '../../../src/modules/ops/replay/logic.js';
import { computeReplay, type ReplayDeps } from '../../../src/modules/ops/replay/run.js';
import { bootstrap } from '../../../src/modules/ops/replay/report.js';
import { loadLiftSeed, trainLift } from '../../../src/modules/engine/index.js';
import { makeApp, runJobToEnd } from '../../helpers/app.js';
import { auctionsJson, closeoutsJson, FILES, inventoryHandlers, makeZip } from '../../helpers/datasave.js';
import { testDb as db } from '../../helpers/db.js';
import { testEnv } from '../../helpers/env.js';
import { issueToken } from '../../helpers/tokens.js';
import { mswServer } from '../../setup/network.js';

const CFG = loadConfig(testEnv());
const ARCH = CFG.archiveDir;
const SNAP = CFG.snapshotDir;
const D = '2026-10-20';
const D1 = '2026-10-21';
const NOW = Date.parse('2026-10-26T12:00:00Z');
let app: FastifyInstance | undefined;
let n = 0;

beforeEach(async () => { await rm(ARCH, { recursive: true, force: true }); await rm(SNAP, { recursive: true, force: true }); });
afterEach(async () => { await app?.close(); app = undefined; });

// ---------- helpers ----------
type Raw = Record<string, unknown>;
const gd = (domain: string, price: string, bids: number, end: string, extra: Raw = {}): Raw => ({
  domainName: domain.toUpperCase(), link: 'https://x.example', auctionType: 'Bid', auctionEndTime: end, price, numberOfBids: bids, domainAge: 8, pageviews: 0, valuation: '$410', isAdult: false,
  exactMatchTlds: 1, keywordRegistrations: 1, developedTlds: 0, semrushSearchVolume: 0, semrushCpc: 0, ...extra,
});
async function writeArchive(day: string, kind: 'all_biddable_auctions' | 'closeout_listings', rows: Raw[]): Promise<void> {
  const p = archivePath(ARCH, day, kind);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, gzipSync(rows.map((r) => JSON.stringify(r)).join('\n') + '\n'));
}
const WORDS = ['sun', 'red', 'big', 'top', 'fun', 'hot', 'sea', 'box', 'pet', 'car', 'bus', 'map'];
const pairs = WORDS.flatMap((a) => WORDS.filter((b) => b !== a).map((b) => `${a}${b}.com`)); // 132 names
/** The biddable rows of day D: every name has bids and ends inside the horizon; ages and bids vary so the scores differ. */
const dayRows = (end = `${D}T20:00:00Z`): Raw[] => pairs.map((d, i) => gd(d, `$${1 + (i % 9)}`, 1 + (i % 7), end, { domainAge: 1 + (i % 15), developedTlds: i % 4, exactMatchTlds: 1 + (i % 6) }));
const body = (o: Raw) => ({ date: D, kind: 'auctions', n: 10, ...o });

async function boot() {
  app = await makeApp({ testRoutes: false, now: () => NOW, env: { JOB_TRIGGER_TOKEN: 'job_token_fake_0123456789abcdef0123456789' } });
  const write = await issueToken('write');
  const read = await issueToken('read');
  const bots = await issueToken('bots');
  const post = (payload: unknown, auth = write.auth, key = `rp-${++n}`) => app!.inject({ method: 'POST', url: '/replay/runs', headers: { ...auth, 'idempotency-key': key }, payload: payload as never });
  const get = (url: string, auth = read.auth) => app!.inject({ method: 'GET', url, headers: auth });
  const finish = async (id: number) => { await app!.replayRunner.idle(); return (await get(`/replay/runs/${id}`)).json(); };
  return { write, read, bots, post, get, finish };
}
const deps = (): ReplayDeps => ({ db, now: () => NOW, archiveDir: ARCH });
const features = (r: { names: { ours: Raw[]; random: Raw[] } }) => ({
  ours: r.names.ours.map((x) => ({ domain: x.domain, rank: x.rank, score: x.score, parts: x.score_parts, max: x.our_max_cents })),
  random: r.names.random.map((x) => ({ domain: x.domain, rank: x.rank, score: x.score, parts: x.score_parts, max: x.our_max_cents })),
});

// ---------- 1. the daily archive ----------
describe('RP archive: written by the datasave step', () => {
  const biddable = makeZip('all_biddable_auctions.json', auctionsJson([
    { domainName: 'Alpha-Deal.COM', price: '$12', auctionEndTime: '2026-10-21T10:00:00Z', numberOfBids: 3, exactMatchTlds: 2 },
    { domainName: 'pricey.com', price: '$900', auctionEndTime: '2026-10-21T10:00:00Z', numberOfBids: 3 },
    { domainName: 'other.net', price: '$5', auctionEndTime: '2026-10-21T10:00:00Z', numberOfBids: 1 },
    { domainName: 'cap.com', price: '$250', auctionEndTime: '2026-10-21T10:00:00Z', numberOfBids: 1, isAdult: true },
  ]));
  const closeouts = makeZip('closeout_listings.json', closeoutsJson([
    { domainName: 'Bravo.COM', price: '$11', auctionEndTime: '2026-10-21T12:00:00Z' },
    { domainName: 'big.info', price: '$5', auctionEndTime: '2026-10-21T12:00:00Z' },
  ]));
  const job = (o: Partial<ConstructorParameters<typeof DatasaveJob>[0]> = {}) => new DatasaveJob({ db, now: () => NOW, snapshotDir: SNAP, archiveDir: ARCH, ...o });

  it('RPY81-1 the step archives .com rows at or under the S8 cap, all fields kept, gzip, named <data_date>-<file base>.jsonl.gz; a second run skips', async () => {
    mswServer.use(...inventoryHandlers({ bodies: { 'all_biddable_auctions.json.zip': biddable, 'closeout_listings.json.zip': closeouts } }));
    const r = await job().godaddyInventory() as { archive: { written: string[]; skipped: string[]; error?: string } };
    expect(r.archive.error).toBeUndefined();
    expect(r.archive.written.sort()).toEqual([`${D}-all_biddable_auctions.jsonl.gz`, `${D}-closeout_listings.jsonl.gz`]);
    const auctions = gunzipSync(readFileSync(archivePath(ARCH, D, 'all_biddable_auctions'))).toString().trim().split('\n').map((l) => JSON.parse(l));
    expect(auctions.map((a) => a.domainName)).toEqual(['Alpha-Deal.COM', 'cap.com']); // $900 is over the cap, .net is not .com; adult rows are kept (all rows)
    expect(auctions[0]).toMatchObject({ price: '$12', numberOfBids: 3, exactMatchTlds: 2, link: 'https://x.example' });
    const co = gunzipSync(readFileSync(archivePath(ARCH, D, 'closeout_listings'))).toString().trim().split('\n').map((l) => JSON.parse(l));
    expect(co.map((a) => a.domainName)).toEqual(['Bravo.COM']);
    // the cap is the setting, not a constant
    await sql`update settings set s8_max_price_cents = 1000`.execute(db);
    mswServer.use(...inventoryHandlers({ lastModified: Object.fromEntries(FILES.map((f) => [f, '2026-10-21T14:41:59Z'])), bodies: { 'all_biddable_auctions.json.zip': biddable, 'closeout_listings.json.zip': closeouts } }));
    await job().godaddyInventory();
    expect(gunzipSync(readFileSync(archivePath(ARCH, D1, 'all_biddable_auctions'))).toString().trim().split('\n')).toHaveLength(1);
    const again = await job().godaddyInventory() as { archive: { written: string[]; skipped: string[] } };
    expect(again.archive.written).toEqual([]);
    expect(again.archive.skipped.sort()).toEqual([`${D1}-all_biddable_auctions.jsonl.gz`, `${D1}-closeout_listings.jsonl.gz`]);
  });

  it('RPY81-2 an archive failure never fails the step: the summary carries archive.error and the manifests are complete', async () => {
    mswServer.use(...inventoryHandlers({ bodies: { 'all_biddable_auctions.json.zip': biddable, 'closeout_listings.json.zip': closeouts } }));
    await mkdir(SNAP, { recursive: true });
    const blocker = join(SNAP, 'a-file');
    await writeFile(blocker, 'x');
    const r = await job({ archiveDir: join(blocker, 'nested') }).godaddyInventory() as { complete_n: number; archive: { written: string[]; error?: string } };
    expect(r.complete_n).toBe(5);
    expect(r.archive.written).toEqual([]);
    expect(r.archive.error).toMatch(/all_biddable_auctions|closeout_listings/);
    expect(existsSync(archivePath(ARCH, D, 'closeout_listings'))).toBe(false);
  });

  it('RPY81-3 a sealed day whose raw zip is still on disk but has no archive file is archived on the next run', async () => {
    mswServer.use(...inventoryHandlers({ bodies: { 'all_biddable_auctions.json.zip': biddable, 'closeout_listings.json.zip': closeouts } }));
    await job({ archiveDir: undefined }).godaddyInventory(); // sealed, nothing archived
    expect(existsSync(archivePath(ARCH, D, 'all_biddable_auctions'))).toBe(false);
    const r = await job().godaddyInventory() as { sealed_n: number; archive: { written: string[] } };
    expect(r.sealed_n).toBe(5);
    expect(r.archive.written.sort()).toEqual([`${D}-all_biddable_auctions.jsonl.gz`, `${D}-closeout_listings.jsonl.gz`]);
  });

  it('RPY81-4 /health.archive: days with both files, first, last and the calendar days in between that lack a file; no retention deletes the archive', async () => {
    const { get } = await boot();
    const empty = (await get('/health')).json().archive;
    expect(empty).toEqual({ days_n: 0, first: null, last: null, missing_days: [] });
    for (const d of ['2026-10-20', '2026-10-21', '2026-10-23']) { await writeArchive(d, 'all_biddable_auctions', [gd('a.com', '$1', 1, `${d}T20:00:00Z`)]); await writeArchive(d, 'closeout_listings', [gd('a.com', '$1', 0, `${d}T20:00:00Z`)]); }
    await writeArchive('2026-10-22', 'closeout_listings', [gd('a.com', '$1', 0, '2026-10-22T20:00:00Z')]); // only one of the two files
    const h = (await get('/health')).json().archive;
    expect(h).toEqual({ days_n: 3, first: '2026-10-20', last: '2026-10-23', missing_days: ['2026-10-22'] });
    expect((await archiveStatus(ARCH)).days).toEqual(['2026-10-20', '2026-10-21', '2026-10-23']);
    const j = new DatasaveJob({ db, now: () => NOW + 400 * 86_400_000, snapshotDir: SNAP, archiveDir: ARCH });
    await j.snapshotRetention();
    expect((await archiveStatus(ARCH)).days_n).toBe(3);
  });
});

// ---------- 2. the pick-proof is off ----------
describe('RP pick-proof off', () => {
  const job = () => new DatasaveJob({ db, now: () => NOW, snapshotDir: SNAP });
  it('RPY81-5 pickproofSeal and pickproofLabels report {status: off, reason: CR-081} and do nothing while settings.pickproof_enabled is false (the default)', async () => {
    expect((await sql<{ e: boolean }>`select pickproof_enabled as e from settings`.execute(db)).rows[0]!.e).toBe(false);
    expect(await job().pickproofSeal()).toEqual({ status: 'off', reason: 'CR-081' });
    expect(await job().pickproofLabels()).toEqual({ status: 'off', reason: 'CR-081' });
    await sql`update settings set pickproof_enabled = true`.execute(db);
    expect(await job().pickproofSeal()).not.toMatchObject({ status: 'off' });
    expect(await job().pickproofLabels()).not.toMatchObject({ status: 'off' });
  });
  it('RPY81-6 a new pick day is not frozen while off (409 PICKPROOF_STOPPED, no pickproof_pool rows); the datasave job still ends ok', async () => {
    const { read, bots } = await boot();
    const m = await app!.inject({ method: 'GET', url: '/pickproof/2026-10-27/manifest', headers: read.auth });
    expect(m.statusCode).toBe(409);
    expect(m.json().error.code).toBe('PICKPROOF_STOPPED');
    const p = await app!.inject({ method: 'POST', url: '/pickproof/2026-10-27/picks', headers: { ...bots.auth, 'idempotency-key': 'rp6' }, payload: { names: ['a.com'] } });
    expect(p.json().error.code).toBe('PICKPROOF_STOPPED');
    expect(await db.selectFrom('pickproof_pool').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('pickproof_days').selectAll().execute()).toEqual([]);
    mswServer.use(...inventoryHandlers({ lastModified: Object.fromEntries(FILES.map((f) => [f, '2026-10-26T11:41:59Z'])) })); // BUG-060: the run day is published
    const run = await runJobToEnd(app!, 'datasave');
    expect(run.json().ok).toBe(true);
    expect(run.json().steps.pickproofSeal.summary).toEqual({ status: 'off', reason: 'CR-081' });
    expect(run.json().steps.pickproofLabels.summary).toEqual({ status: 'off', reason: 'CR-081' });
  });
});

// ---------- 3. the replay ----------
describe('RP replay: routes', () => {
  it('RPY81-7 POST /replay/runs: WRITE only, Idempotency-Key, strict body, an unarchived day is 404 ARCHIVE_DAY_MISSING', async () => {
    const { post, read, bots, get } = await boot();
    await writeArchive(D, 'all_biddable_auctions', dayRows());
    expect((await post(body({}), read.auth)).statusCode).toBe(403);
    expect((await post(body({}), bots.auth)).statusCode).toBe(403);
    const noKey = await app!.inject({ method: 'POST', url: '/replay/runs', headers: (await issueToken('write')).auth, payload: body({}) });
    expect(noKey.statusCode).toBe(400);
    expect((await post(body({ date: '2026-02-30' }))).statusCode).toBe(422);
    expect((await post(body({ n: 201 }))).statusCode).toBe(422);
    expect((await post(body({ n: 0 }))).statusCode).toBe(422);
    expect((await post(body({ kind: 'both' }))).statusCode).toBe(422);
    expect((await post(body({ extra: 1 }))).statusCode).toBe(422);
    const missing = await post(body({ date: '2026-10-19' }));
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('ARCHIVE_DAY_MISSING');
    const noCloseouts = await post(body({ kind: 'closeouts' }));
    expect(noCloseouts.json().error.code).toBe('ARCHIVE_DAY_MISSING');
    expect((await get('/replay/runs/0')).statusCode).toBe(400);
    expect((await get('/replay/runs/99')).statusCode).toBe(404);
    expect((await get('/replay/runs?limit=0')).statusCode).toBe(400);
    const audits = await db.selectFrom('audit_log').select('path').where('path', '=', '/replay/runs').execute();
    expect(audits.length).toBeGreaterThan(0);
  });

  it('RPY81-8 a run is queued (202 {id}), worked, and read back with its status and report by READ and bots tokens; the list has no report body', async () => {
    const { post, get, finish, bots } = await boot();
    await writeArchive(D, 'all_biddable_auctions', dayRows());
    const r = await post(body({}));
    expect(r.statusCode, r.body).toBe(202);
    const { id } = r.json();
    const done = await finish(id);
    expect(done).toMatchObject({ id, date: D, kind: 'auctions', n: 10, seed: expect.stringMatching(/^sha:[0-9a-f]{16}$/), status: 'done' });
    expect(done.logic_version).toMatch(/^replay-v1\|auction-v4\|lift:seed:/);
    expect(done.report.groups.ours.n).toBe(10);
    expect(done.report.groups.random.n).toBe(10);
    expect(done.report.field.field_n).toBeGreaterThan(20);
    expect(done.report.outcome_status.retail).toMatchObject({ status: 'no_data' });
    const list = (await get('/replay/runs', bots.auth)).json();
    expect(list.runs[0]).toMatchObject({ id, status: 'done' });
    expect(list.runs[0].report).toBeUndefined();
    expect((await get(`/replay/runs/${id}`, bots.auth)).statusCode).toBe(200);
    // a failing run is stored as error with its message (the day file is damaged after queueing)
    await writeFile(archivePath(ARCH, D, 'all_biddable_auctions'), 'not gzip');
    const r2 = await post(body({ seed: 'x' }));
    const bad = await finish(r2.json().id);
    expect(bad.status).toBe('error');
    expect(bad.error).toBeTruthy();
  });

  it('RPY81-9 dry_run answers 200 with the report at once and stores no run', async () => {
    const { post } = await boot();
    await writeArchive(D, 'all_biddable_auctions', dayRows());
    const r = await post(body({ dry_run: true }));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ dry_run: true, report: { groups: { ours: { n: 10 } } } });
    expect(await db.selectFrom('replay_day_runs').selectAll().execute()).toEqual([]);
  });

  it('RPY81-10 a run left running by a dead process is queued again and finished by the next read', async () => {
    const { get, finish } = await boot();
    await writeArchive(D, 'all_biddable_auctions', dayRows());
    const row = await db.insertInto('replay_day_runs').values({ date: D, kind: 'auctions', n: 5, seed: 's', status: 'running', started_at: new Date(NOW - 3_600_000), requested_by: 'x', audit_id: null, report: null, error: null, logic_version: null, finished_at: null }).returning('id').executeTakeFirstOrThrow();
    await get('/replay/runs');
    expect((await finish(Number(row.id))).status).toBe('done');
  });
});

describe('RP replay: GET /replay/{date}', () => {
  it('RPY81-20 GET /replay/{date} returns the newest finished report of that date / kind / n / seed (default seed from the archive file), 404 REPLAY_NOT_RUN otherwise; it writes nothing; READ and bots; logic current only', async () => {
    const { post, get, finish, bots } = await boot();
    await writeArchive(D, 'all_biddable_auctions', dayRows());
    const miss = await get(`/replay/${D}`);
    expect(miss.statusCode).toBe(404);
    expect(miss.json().error.code).toBe('REPLAY_NOT_RUN');
    expect((await get('/replay/2026-10-19')).json().error.code).toBe('REPLAY_NOT_RUN');
    const r = await post({ date: D, kind: 'auctions' }); // n 25, seed derived
    const run = await finish(r.json().id);
    const rep = await get(`/replay/${D}`, bots.auth);
    expect(rep.statusCode).toBe(200);
    expect(rep.json().id).toBe(run.id);
    expect(rep.json().report.groups.ours.n).toBe(25);
    expect(rep.json().seed).toMatch(/^sha:[0-9a-f]{16}$/);
    expect((await get(`/replay/${D}?n=10`)).json().error.code).toBe('REPLAY_NOT_RUN');
    expect((await get(`/replay/${D}?seed=${run.seed}&logic=current`)).statusCode).toBe(200);
    expect((await get(`/replay/${D}?kind=closeouts`)).json().error.code).toBe('REPLAY_NOT_RUN');
    expect((await get(`/replay/${D}?as_of_date=2026-10-01`)).json().error.code).toBe('REPLAY_LOGIC_UNAVAILABLE');
    expect((await post({ date: D, kind: 'auctions', as_of_date: '2026-10-01' })).json().error.code).toBe('REPLAY_LOGIC_UNAVAILABLE');
    expect((await post({ date: D, kind: 'auctions', logic: 'frozen' })).statusCode).toBe(422);
    expect((await get('/replay/nope')).statusCode).toBe(400);
    expect(await db.selectFrom('replay_day_runs').select('id').execute()).toHaveLength(1);
    const again = await post({ date: D, kind: 'auctions' });
    await finish(again.json().id);
    expect((await get(`/replay/${D}`)).json().id).toBe(again.json().id); // the newest
  });
  it('RPY81-21 the pick-proof picks of an unsealed day are refused 409 PICKPROOF_STOPPED while off, an unsealed existing day included', async () => {
    const { bots } = await boot();
    await db.insertInto('pickproof_days').values({ day: '2026-10-27', data_date: '2026-10-26', pool_sha256: 'a'.repeat(64), seed: 1, k: 100, pool_n: 0, sources: '{}', deadline: new Date('2026-10-27T16:00:00Z'), recipe_version: 'pickproof-v2' as never }).execute();
    const p = await app!.inject({ method: 'POST', url: '/pickproof/2026-10-27/picks', headers: { ...bots.auth, 'idempotency-key': 'rp21' }, payload: { names: ['a.com'] } });
    expect(p.statusCode).toBe(409);
    expect(p.json().error.code).toBe('PICKPROOF_STOPPED');
  });
});

describe('RP replay: logic, random group, outcomes', () => {
  it('RPY81-11 the random group is N names of the same filtered field, not among our top N, shuffled with the pick-proof MT19937 / Fisher-Yates seeded from the seed and date: reproducible, and a new seed draws others', async () => {
    await writeArchive(D, 'all_biddable_auctions', dayRows());
    const a = (await computeReplay(deps(), { date: D, kind: 'auctions', n: 10, seed: expect.stringMatching(/^sha:[0-9a-f]{16}$/) })).report;
    const b = (await computeReplay(deps(), { date: D, kind: 'auctions', n: 10, seed: expect.stringMatching(/^sha:[0-9a-f]{16}$/) })).report;
    const c = (await computeReplay(deps(), { date: D, kind: 'auctions', n: 10, seed: 'other' })).report;
    expect(features(a)).toEqual(features(b));
    const ours = new Set(a.names.ours.map((x) => x.domain));
    expect(a.names.random).toHaveLength(10);
    for (const r of a.names.random) { expect(ours.has(r.domain)).toBe(false); expect(r.rank).toBeGreaterThan(10); }
    expect(c.names.ours.map((x) => x.domain)).toEqual(a.names.ours.map((x) => x.domain));
    expect(c.names.random.map((x) => x.domain)).not.toEqual(a.names.random.map((x) => x.domain));
    // ours are the top of the ranking: scores do not rise
    const sc = a.names.ours.map((x) => x.score);
    expect([...sc].sort((p, q) => q - p)).toEqual(sc);
  });

  it('RPY81-12 the field uses the shortlist filters: over-cap, no-bid, outside-horizon, non-.com and rule-failing names are dropped and counted', async () => {
    const rows = [...dayRows(), gd('overcap.com', '$900', 3, `${D}T20:00:00Z`), gd('nobids.com', '$3', 0, `${D}T20:00:00Z`), gd('late.com', '$3', 2, `${D}T20:00:00Z`.replace('20', '20').replace(D, '2026-11-20')), gd('early.com', '$3', 2, `${D}T10:00:00Z`)];
    await writeArchive(D, 'all_biddable_auctions', rows);
    const r = (await computeReplay(deps(), { date: D, kind: 'auctions', n: 5, seed: 's' })).report;
    expect(r.field.dropped).toMatchObject({ over_cap: 1, no_bids: 1, outside_horizon: 2 });
    expect(r.field.rows_read_n).toBe(rows.length);
    const all = [...r.names.ours, ...r.names.random].map((x) => x.domain);
    for (const bad of ['overcap.com', 'nobids.com', 'late.com', 'early.com']) expect(all).not.toContain(bad);
  });

  it('RPY81-13 (point in time) the picks, scores, parts and suggested maximums of day D are identical with and without the D+1 file; only the outcomes change', async () => {
    await writeArchive(D, 'all_biddable_auctions', dayRows());
    const before = (await computeReplay(deps(), { date: D, kind: 'auctions', n: 12, seed: 'pit' })).report;
    // day D+1: the same names with other prices, bids, ages and demand fields, and the first ones gone
    const changed = dayRows(`${D1}T20:00:00Z`).slice(5).map((r, i) => ({ ...r, price: `$${200 + (i % 40)}`, numberOfBids: 40 + i, domainAge: 1, developedTlds: 0, exactMatchTlds: 0 }));
    await writeArchive(D1, 'all_biddable_auctions', changed);
    await writeArchive(D1, 'closeout_listings', changed);
    await sql`insert into market_sales (name, venue, sale_price_cents, sale_date, source, tier, listing_type, by) select ${pairs[0]!}, 'dnjournal', 90000, ${D1}::date, 'test', 'A', 'bin', 'test'`.execute(db);
    const after = (await computeReplay(deps(), { date: D, kind: 'auctions', n: 12, seed: 'pit' })).report;
    expect(features(after)).toEqual(features(before));
    expect(after.field).toEqual(before.field);
    expect(after.logic.version).toBe(before.logic.version);
    expect(JSON.stringify(after.names.ours.map((x) => x.score))).toBe(JSON.stringify(before.names.ours.map((x) => x.score)));
    // the outcomes did change
    expect(before.outcome_status.retail.status).toBe('no_data');
    expect(after.outcome_status.retail.status).toBe('ok');
    const anyFinal = [...after.names.ours, ...after.names.random].filter((x) => x.final_price_cents !== null && x.final_basis === 'last_archived');
    expect(anyFinal.length).toBeGreaterThan(0);
    const maxBefore = Math.max(...[...before.names.ours, ...before.names.random].map((x) => Number(x.final_price_cents)));
    expect(maxBefore).toBeLessThan(1000); // day D's own rows only: prices of $1-$9
    expect(Math.max(...anyFinal.map((x) => Number(x.final_price_cents)))).toBeGreaterThanOrEqual(20000);
  });

  it('RPY81-14 auction outcomes: reached_100, beat_our_max, ended known or not; the ended-auction tracker (godaddy_auctions) wins over the last archived row', async () => {
    await writeArchive(D, 'all_biddable_auctions', dayRows());
    const base = (await computeReplay(deps(), { date: D, kind: 'auctions', n: 8, seed: 'o' })).report;
    const picks = base.names.ours.map((x) => x.domain as string);
    const rand = base.names.random.map((x) => x.domain as string);
    const row = (d: string, price: string, bids: number): Raw => gd(d, price, bids, `${D}T20:00:00Z`);
    // D+1 archive: the last rows of the auctions that ended on D (listed again the next day only as a leftover for picks[0]; its end day is D, so it is ignored)
    await writeArchive(D1, 'all_biddable_auctions', [row(picks[0]!, '$300', 50), row('zzzz.com', '$1', 1)]);
    await writeArchive('2026-10-22', 'all_biddable_auctions', [row('zzzz.com', '$1', 1)]);
    // the tracker knows picks[1] ended at $120 and rand[0] ended at $60
    for (const [d, p, b] of [[picks[1]!, 12000, 9], [rand[0]!, 6000, 4], [picks[2]!, 100, 1]] as const) {
      await db.insertInto('godaddy_auctions').values({ domain: d, end_time: new Date(`${D}T20:00:00Z`), auction_type: 'Bid', first_seen: D, last_seen: D, last_price_cents: p, max_price_cents: p, last_bid_count: b, ended: true, final_state_at: D }).execute();
    }
    const r = (await computeReplay(deps(), { date: D, kind: 'auctions', n: 8, seed: 'o' })).report;
    const by = (d: string) => [...r.names.ours, ...r.names.random].find((x) => x.domain === d)!;
    expect(by(picks[1]!)).toMatchObject({ final_price_cents: 12000, final_bids: 9, final_basis: 'godaddy_auctions', ended: true, labels: { reached_100: true } });
    expect(by(picks[1]!).labels.beat_our_max).toBe(12000 >= by(picks[1]!).our_max_cents);
    expect(by(rand[0]!).labels).toMatchObject({ reached_100: false });
    expect(by(picks[2]!).labels).toMatchObject({ reached_100: false, beat_our_max: false });
    // picks[0] is only in the archive after its end day: the D row is the last one before the end, the ended flag follows the newest archived day
    expect(by(picks[0]!)).toMatchObject({ final_basis: 'last_archived', ended: true });
    expect(by(picks[0]!).final_price_cents).toBeLessThan(30000);
    // a name with nothing after D and the newest archived day still before its end: ended unknown, labels null
    const stats = r.groups.ours.labels.reached_100!;
    expect(stats.known_n + stats.unknown_n).toBe(8);
    expect(r.labels.reached_100).toMatchObject({ too_small: true });
    expect(r.did_well.map((x) => x.domain)).toContain(picks[1]);
  });

  it('RPY81-15 retail: with no reported sale after D the report says no_data; with market_sales or engine_sales rows after D the labels retail_sale / retail_500 appear (the godaddy_auctions_file rows are not retail)', async () => {
    await writeArchive(D, 'all_biddable_auctions', dayRows());
    const base = (await computeReplay(deps(), { date: D, kind: 'auctions', n: 6, seed: 'r' })).report;
    expect(base.outcome_status.retail).toEqual({ status: 'no_data', sales_after_d_n: 0 });
    expect(base.labels.retail_sale).toBeUndefined();
    const picks = base.names.ours.map((x) => x.domain as string);
    const rand = base.names.random.map((x) => x.domain as string);
    await db.insertInto('engine_uploads').values({ kind: 'sales', by: 'test', rows_n: 3, accepted_n: 3, duplicate_n: 0, rejected_n: 0 } as never).execute().catch(() => {});
    await sql`insert into market_sales (name, venue, sale_price_cents, sale_date, source, tier, listing_type, by) values (${picks[0]!}, 'unreported', 120000, '2026-10-25', 'UnreportedSales', 'A', 'bin', 't'), (${rand[0]!}, 'dnjournal', 30000, '2026-10-24', 'DNJournal', 'A', 'bin', 't'), (${picks[1]!}, 'godaddy', 9000, '2026-10-24', 'x', 'A', 'closeout', 't')`.execute(db);
    const r = (await computeReplay(deps(), { date: D, kind: 'auctions', n: 6, seed: 'r' })).report;
    expect(r.outcome_status.retail).toMatchObject({ status: 'ok', sales_after_d_n: 2 }); // the closeout row is not retail
    const by = (d: string) => [...r.names.ours, ...r.names.random].find((x) => x.domain === d)!;
    expect(by(picks[0]!).labels).toMatchObject({ retail_sale: true, retail_500: true });
    expect(by(rand[0]!).labels).toMatchObject({ retail_sale: true, retail_500: false });
    expect(by(picks[1]!).labels).toMatchObject({ retail_sale: false });
    expect(r.groups.ours.labels.retail_sale).toMatchObject({ positives: 1, known_n: 6, rate: 0.1667 });
    expect(r.did_well.map((x) => x.domain).sort()).toEqual([picks[0], rand[0]].sort());
  });

  it('RPY81-16 closeouts: the same filters and the lift/name scoring without bids; RDAP taken vs dropped is pending before D+30 and reads only stored closeout_expiries tags', async () => {
    const co = pairs.map((d, i) => gd(d, `$${3 + (i % 9)}`, 0, `${D1}T10:00:00Z`, { auctionType: 'BuyNow', domainAge: 1 + (i % 15), developedTlds: i % 3 }));
    await writeArchive(D, 'closeout_listings', co);
    const first = (await computeReplay({ ...deps(), now: () => Date.parse('2026-11-01T00:00:00Z') }, { date: D, kind: 'closeouts', n: 6, seed: 'c' })).report;
    expect(first.outcome_status.rdap).toMatchObject({ status: 'pending', ready_on: '2026-11-19', stored_n: 0 });
    expect(first.groups.ours.labels.taken).toMatchObject({ positives: 0, known_n: 0, rate: null });
    expect(first.field.dropped.no_bids).toBeUndefined();
    const picks = first.names.ours.map((x) => x.domain as string);
    const rand = first.names.random.map((x) => x.domain as string);
    for (const [d, tag] of [[picks[0]!, 'held'], [picks[1]!, 'dropped'], [rand[0]!, 'dropped'], [rand[1]!, 'pending']] as const) {
      await db.insertInto('closeout_expiries').values({ domain: d, ends_at: new Date(`${D1}T10:00:00Z`), ends_on: D1, first_seen_on: D, tag, final: tag !== 'pending' }).execute();
    }
    const second = (await computeReplay({ ...deps(), now: () => Date.parse('2026-11-25T00:00:00Z') }, { date: D, kind: 'closeouts', n: 6, seed: 'c' })).report;
    expect(second.outcome_status.rdap).toMatchObject({ status: 'ready', stored_n: 3 });
    expect(second.groups.ours.labels.taken).toMatchObject({ positives: 1, known_n: 2, unknown_n: 4 });
    expect(second.groups.random.labels.taken).toMatchObject({ positives: 0, known_n: 1 });
    expect(features(second)).toEqual(features(first));
  });

  it('RPY81-17 lift table as of D: the newest model trained on or before D, else the CR-002 seed table; a model trained after D is never used', async () => {
    const seed = loadLiftSeed();
    const t = trainLift([], seed!.rows)!;
    const bins = JSON.stringify(t.bins);
    const ins = (at: string, key: string) => db.insertInto('lift_models').values({ version: 'lift-v1', trained_at: new Date(at), data_key: key, source: 'seed', sold_n: 0, unsold_n: 0, seed_sold_n: 1, seed_unsold_n: 1, seed_weight: 1, auc: 0.8, bins }).returning('id').executeTakeFirstOrThrow();
    expect((await liftAsOf(db, D)).source).toMatch(/^seed:/);
    const after = await ins('2026-10-22T10:00:00Z', 'k-after');
    expect((await liftAsOf(db, D)).source).toMatch(/^seed:/);
    const same = await ins('2026-10-20T08:00:00Z', 'k-same-day');
    expect((await liftAsOf(db, D)).source).toMatch(new RegExp(`^model:${same.id}@2026-10-20`));
    expect((await liftAsOf(db, '2026-10-23')).source).toMatch(new RegExp(`^model:${after.id}@`));
    await writeArchive(D, 'all_biddable_auctions', dayRows());
    expect((await computeReplay(deps(), { date: D, kind: 'auctions', n: 3, seed: 's' })).logic_version).toContain(`lift:model:${same.id}@`);
  });
});

describe('RP replay: the report numbers', () => {
  it('RPY81-18 paired bootstrap: 1,000 seeded resamples, the share where ours wins; reproducible; ties are not wins', () => {
    const ours = Array.from({ length: 30 }, (_, i) => i < 20);
    const rand = Array.from({ length: 30 }, (_, i) => i < 5);
    const a = bootstrap(ours, rand, 'seed|label');
    expect(a).toEqual(bootstrap(ours, rand, 'seed|label'));
    expect(a).toMatchObject({ resamples: 1000, pairs_n: 30 });
    expect(a.ours_win_share).toBeGreaterThan(0.99);
    expect(a.mean_diff).toBeGreaterThan(0.4);
    expect(bootstrap(ours, rand, 'seed|other').ours_win_share).not.toBeNull();
    const tie = bootstrap([true, false, true, false], [true, false, true, false], 's');
    expect(tie).toMatchObject({ ours_win_share: 0, tie_share: 1, mean_diff: 0 });
    expect(bootstrap([null, null], [true, false], 's')).toMatchObject({ pairs_n: 0, ours_win_share: null });
    expect(bootstrap([true, null, false], [false, true, false], 's').pairs_n).toBe(2);
  });

  it('RPY81-19 every label shows its counts; too_small is true under 20 positives in total (ours + random) and false from 20', async () => {
    await writeArchive(D, 'all_biddable_auctions', dayRows());
    const base = (await computeReplay(deps(), { date: D, kind: 'auctions', n: 30, seed: 'big' })).report;
    const names = [...base.names.ours, ...base.names.random].map((x) => x.domain as string);
    // 19 names reach $100 on the tracker -> too small; one more -> 20 -> decidable
    const track = async (ds: string[]) => { for (const d of ds) await db.insertInto('godaddy_auctions').values({ domain: d, end_time: new Date(`${D}T20:00:00Z`), auction_type: 'Bid', first_seen: D, last_seen: D, last_price_cents: 15000, max_price_cents: 15000, last_bid_count: 5, ended: true, final_state_at: D }).execute(); };
    await track(names.slice(0, 19));
    const r19 = (await computeReplay(deps(), { date: D, kind: 'auctions', n: 30, seed: 'big' })).report;
    expect(r19.labels.reached_100).toMatchObject({ positives_total: 19, too_small: true });
    await track(names.slice(19, 20));
    const r20 = (await computeReplay(deps(), { date: D, kind: 'auctions', n: 30, seed: 'big' })).report;
    expect(r20.labels.reached_100).toMatchObject({ positives_total: 20, too_small: false });
    for (const g of ['ours', 'random'] as const) {
      const s = r20.groups[g].labels.reached_100!;
      expect(s.known_n + s.unknown_n).toBe(30);
      expect(s.rate).toBe(s.known_n === 0 ? null : Math.round((s.positives / s.known_n) * 10_000) / 10_000);
    }
    expect((r20.labels.reached_100 as { bootstrap: unknown }).bootstrap).toMatchObject({ resamples: 1000 });
    expect(r20.did_well.length).toBe(20);
    expect(r20.did_well[0]).toMatchObject({ domain: expect.any(String), group: expect.stringMatching(/ours|random/), score: expect.any(Number), price_cents: expect.any(Number), bids: expect.any(Number) });
    expect(r20.did_well[0]!.score_parts).toHaveProperty('demand');
  });
});
