// v5.21.0 (CR-071): the `datasave` job, GET /snapshots, GET /snapshots/missing, /health.datasave, /report DATASAVE_MISSED. Every outside call is mocked (MSW).
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../../../src/config.js';
import { DatasaveJob } from '../../../src/modules/ops/jobs/datasave/datasave.js';
import { makeApp, runJobToEnd } from '../../helpers/app.js';
import { auctionsJson, closeoutsJson, FILES, inventoryHandlers, makeZip, sha256 } from '../../helpers/datasave.js';
import { testDb as db } from '../../helpers/db.js';
import { testEnv } from '../../helpers/env.js';
import { issueToken } from '../../helpers/tokens.js';
import { mswServer } from '../../setup/network.js';

const NOW = Date.parse('2026-10-20T15:00:30Z');
const DAY = 86_400_000;
const SNAP = loadConfig(testEnv()).snapshotDir;
let app: FastifyInstance | undefined;
let clock = NOW;

beforeEach(async () => { clock = NOW; await rm(SNAP, { recursive: true, force: true }); });
afterEach(async () => { await app?.close(); app = undefined; });

const boot = async () => {
  app = await makeApp({ testRoutes: false, now: () => clock, env: { JOB_TRIGGER_TOKEN: 'job_token_fake_0123456789abcdef0123456789' } });
  const { auth } = await issueToken('read');
  const get = async (url: string) => app!.inject({ method: 'GET', url, headers: auth });
  return { get };
};
const job = (now = () => clock) => new DatasaveJob({ db, now, snapshotDir: SNAP, rdap: async (d) => ({ outcome: 'unknown', reasonCode: 'SOURCE_ERROR', httpStatus: null, url: d, retrievedAt: new Date(now()), body: null, facts: null }), sleep: async () => {} });
const closeouts = closeoutsJson([
  { domainName: 'Alpha-Deal.COM', price: '$5', auctionEndTime: '2026-10-21T10:00:00Z' },
  { domainName: 'dear.com', price: '$1,250', auctionEndTime: '2026-10-21T11:00:00Z' },
  { domainName: 'rey-v.info', price: '$5', auctionEndTime: '2026-10-21T11:00:00Z' },
  { domainName: 'spicy.com', price: '$8', auctionEndTime: '2026-10-21T11:00:00Z', isAdult: true },
  { domainName: 'cap.com', price: '$40', auctionEndTime: '2026-10-21T12:00:00Z' },
]);
const closeoutsZip = makeZip('closeout_listings.json', closeouts);

describe('DS521 datasave job', () => {
  it('DS521-4 (AT-1) the job saves the 5 files: sha256, bytes, Last-Modified, complete; only the closeouts are parsed (cents, .com, cap, not adult)', async () => {
    mswServer.use(...inventoryHandlers({ bodies: { 'closeout_listings.json.zip': closeoutsZip } }));
    const { get } = await boot();
    const run = await runJobToEnd(app!, 'datasave');
    expect(run.json().ok).toBe(true);
    const steps = run.json().steps;
    expect(Object.keys(steps)).toEqual(['godaddyInventory', 'scorePool', 'buildPanel', 'engineFeed', 'auctionShortlist', 'pickproofSeal', 'snapshotRetention', 'episodes', 'dqMarket', 'pickproofLabels', 'dynadotCloseouts', 'dynadotAftermarket']);
    expect(steps.godaddyInventory.summary).toMatchObject({ data_date: '2026-10-20', complete_n: 5 });
    const res = (await get('/snapshots?date=2026-10-20&source=godaddy_inventory')).json();
    expect(res.snapshots).toHaveLength(5);
    for (const s of res.snapshots) expect(Date.parse(s.last_modified)).toBe(Date.parse('2026-10-20T14:41:59Z'));
    for (const s of res.snapshots) expect(s).toMatchObject({ status: 'complete', data_date: '2026-10-20', sealed: true, raw_available: true, http_status: 200 });
    const c = res.snapshots.find((s: { file_name: string }) => s.file_name === 'closeout_listings.json.zip');
    expect(c).toMatchObject({ bytes: closeoutsZip.length, sha256: sha256(closeoutsZip), rows: 2, rows_total: 5, price_unit: 'cents' });
    expect(res.snapshots.filter((s: { rows: number | null }) => s.rows === 0)).toHaveLength(4); // the four auction files (v5.22.0): parsed, nothing followed in the empty fixtures
    expect(JSON.stringify(res)).not.toContain(SNAP); // no server path in the answer
    expect(res.pool).toEqual([{ data_date: '2026-10-20', source: 'godaddy_closeouts', rows: 2 }]);
    // the pool: cents, lowercase, .com only, <= $40, no adult
    const pool = await db.selectFrom('datasave_pool').select(['domain', 'price_cents']).orderBy('domain').execute();
    expect(pool).toEqual([{ domain: 'alpha-deal.com', price_cents: 500 }, { domain: 'cap.com', price_cents: 4000 }]);
    // the raw zip is on disk under <data_date>/<file>, byte for byte
    expect(sha256(readFileSync(join(SNAP, 'godaddy_inventory', '2026-10-20', 'closeout_listings.json.zip')))).toBe(sha256(closeoutsZip));
    expect(await app!.inject({ method: 'GET', url: '/health', headers: (await issueToken('read')).auth }).then((r) => r.json().datasave)).toBe('ok');
  });

  it('DS521-5 a price over the cap is dropped, and a "$1,250" name is kept at 125000 cents when the cap is raised', async () => {
    const dir = join(SNAP, 'x'); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'c.zip'), closeoutsZip);
    const r = await job().parseCloseouts(join(dir, 'c.zip'), '2026-10-20', 200_000);
    expect(r).toEqual({ kept: 3, total: 5 });
    expect((await db.selectFrom('datasave_pool').select('price_cents').where('domain', '=', 'dear.com').executeTakeFirstOrThrow()).price_cents).toBe(125000);
  });

  it('DS521-6 (AT-3) GoDaddy answers 503: the file is status error with http_status 503 and rows null; /health.datasave is error; a retry run is queued 60 minutes on', async () => {
    mswServer.use(...inventoryHandlers({ status: { 'closeout_listings.json.zip': 503, 'all_expiring_auctions.json.zip': 503, 'all_biddable_auctions.json.zip': 503, 'all_listings_ending_today.json.zip': 503, 'auctions_ending_today.json.zip': 503 } }));
    const { get } = await boot();
    const run = await runJobToEnd(app!, 'datasave');
    expect(run.json().ok).toBe(false);
    expect(run.json().steps.godaddyInventory.ok).toBe(false);
    const snaps = (await get('/snapshots?date=2026-10-20')).json().snapshots;
    expect(snaps).toHaveLength(5);
    for (const s of snaps) expect(s).toMatchObject({ status: 'error', http_status: 503, rows: null, sealed: false, sha256: null });
    expect((await get('/health')).json().datasave).toBe('error');
    // the retry: one more run, waiting for not_before = finish + 60 min, and params {retry:true}
    const retries = await db.selectFrom('job_queue_runs').select(['not_before', 'params', 'trigger', 'triggered_by']).where('job', '=', 'datasave').orderBy('created_at').execute();
    expect(retries).toHaveLength(2);
    expect(retries[1]).toMatchObject({ params: { retry: true }, trigger: 'scheduled', triggered_by: 'datasave-retry' });
    expect(retries[1]!.not_before!.getTime()).toBe(NOW + 3_600_000);
    // not run before its time, and a retry never retries again
    expect((await db.selectFrom('job_steps').select('status').where('job', '=', 'datasave').execute()).filter((s) => s.status === 'queued')).toHaveLength(12);
  });

  it('DS521-7 the retry runs once the hour is up (asking for the job again starts the waiting run), saves the day and does not queue a third run', async () => {
    mswServer.use(...inventoryHandlers({ status: { metadata: 503 } }));
    await boot();
    await runJobToEnd(app!, 'datasave');
    expect((await db.selectFrom('snapshot_manifests').select('http_status').execute()).map((r) => r.http_status)).toEqual([503, 503, 503, 503, 503]);
    mswServer.resetHandlers();
    mswServer.use(...inventoryHandlers());
    const again = await runJobToEnd(app!, 'datasave');
    expect(again.accepted.skipped).toBe(true); // the waiting retry run is returned and released
    await app!.jobQueue.idle();
    expect((await db.selectFrom('job_runs').select('ok').where('job', '=', 'datasave').orderBy('id').execute()).map((r) => r.ok)).toEqual([false, true]);
    expect(await db.selectFrom('job_queue_runs').select('id').where('job', '=', 'datasave').execute()).toHaveLength(2);
    expect((await db.selectFrom('snapshot_manifests').select('status').execute()).every((r) => r.status === 'complete')).toBe(true);
  });

  it('DS521-8 (AT-4) nothing complete for 26 h: /health.datasave is overdue and /report carries DATASAVE_MISSED; a fresh database raises nothing in /report', async () => {
    const { get } = await boot();
    expect((await get('/health')).json().datasave).toBe('overdue'); // never ran
    expect(((await get('/report')).json().warnings as { code: string }[]).map((w) => w.code)).not.toContain('DATASAVE_MISSED');
    for (const f of FILES) {
      await db.insertInto('snapshot_manifests').values({ source: 'godaddy_inventory', data_date: '2026-10-17', file_name: f, bytes: 10, sha256: 'a'.repeat(64), last_modified: new Date(NOW - 30 * 3_600_000), rows: null, status: 'complete', http_status: 200, sealed_at: new Date(NOW - 30 * 3_600_000), updated_at: new Date(NOW - 30 * 3_600_000) }).execute();
    }
    expect((await get('/health')).json().datasave).toBe('overdue');
    const w = ((await get('/report')).json().warnings as { code: string; level: string; details: { missing_days: string[]; sources: string[] } }[]).find((x) => x.code === 'DATASAVE_MISSED')!;
    expect(w).toBeDefined();
    expect(w.level).toBe('error');
    expect(w.details.sources).toEqual(['godaddy_inventory']);
    expect(w.details.missing_days).toEqual(['2026-10-18', '2026-10-19']);
  });

  it('DS521-9 (AT-5) a second run for a sealed day changes nothing: SNAPSHOT_SEALED in the step summary and the sha256 is unchanged (the source file is not fetched again)', async () => {
    const hits: string[] = [];
    mswServer.use(...inventoryHandlers({ bodies: { 'closeout_listings.json.zip': closeoutsZip }, hits }));
    const { get } = await boot();
    await runJobToEnd(app!, 'datasave');
    const before = (await get('/snapshots?date=2026-10-20')).json().snapshots;
    hits.length = 0;
    // GoDaddy now serves a different body under the same data date
    mswServer.use(...inventoryHandlers({ bodies: { 'closeout_listings.json.zip': makeZip('closeout_listings.json', closeoutsJson([])) }, hits }));
    const run = await runJobToEnd(app!, 'datasave');
    const files = run.json().steps.godaddyInventory.summary.files as { file: string; code?: string; sha256: string }[];
    expect(files.every((f) => f.code === 'SNAPSHOT_SEALED')).toBe(true);
    expect(run.json().steps.godaddyInventory.ok).toBe(true);
    expect(hits).toEqual(['metadata.json']);
    expect((await get('/snapshots?date=2026-10-20')).json().snapshots).toEqual(before);
    // and the database itself refuses to change a sealed manifest
    await expect(db.updateTable('snapshot_manifests').set({ sha256: 'f'.repeat(64) }).execute()).rejects.toThrow(/sealed snapshot manifest/);
    await expect(db.deleteFrom('snapshot_manifests').execute()).rejects.toThrow(/sealed snapshot manifest/);
  });

  it('DS521-20 a configured file missing from metadata.json is error FILE_NOT_LISTED; a file over the 200 MB cap is error SIZE_CAP (nothing kept, never zero rows)', async () => {
    mswServer.use(...inventoryHandlers({ files: FILES.slice(0, 4) }));
    await job().godaddyInventory().catch(() => {});
    const missing = await db.selectFrom('snapshot_manifests').selectAll().where('file_name', '=', FILES[4]!).executeTakeFirstOrThrow();
    expect(missing).toMatchObject({ status: 'error', rows: null });
    expect(missing.error).toMatch(/^FILE_NOT_LISTED/);
    // the size cap: the server declares a body over 200 MB
    const real = globalThis.fetch;
    const big: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/metadata.json')) return real(input, init);
      return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(8)); c.close(); } }), { headers: { 'content-length': String(201 * 1024 * 1024) } });
    };
    mswServer.use(...inventoryHandlers({ lastModified: Object.fromEntries(FILES.map((f) => [f, '2026-10-21T14:41:59Z'])) }));
    await new DatasaveJob({ db, now: () => clock, snapshotDir: SNAP, fetch: big }).godaddyInventory().catch(() => {});
    const capped = await db.selectFrom('snapshot_manifests').selectAll().where('data_date', '=', '2026-10-21').where('file_name', '=', FILES[0]!).executeTakeFirstOrThrow();
    expect(capped).toMatchObject({ status: 'error', rows: null });
    expect(capped.error).toMatch(/^SIZE_CAP/);
  });

  it('DS521-10 (AT-6) GET /jobs/runs?job=datasave lists the run with each step and the data_date', async () => {
    mswServer.use(...inventoryHandlers());
    const { get } = await boot();
    await runJobToEnd(app!, 'datasave');
    const runs = (await get('/jobs/runs?job=datasave')).json().runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ job: 'datasave', status: 'finished', ok: true });
    expect(Object.fromEntries(Object.entries(runs[0].steps as Record<string, { status: string }>).map(([k, v]) => [k, v.status]))).toEqual({ godaddyInventory: 'done', scorePool: 'done', buildPanel: 'done', engineFeed: 'done', auctionShortlist: 'done', pickproofSeal: 'done', snapshotRetention: 'done', episodes: 'done', dqMarket: 'done', pickproofLabels: 'done', dynadotCloseouts: 'done', dynadotAftermarket: 'done' });
    expect(runs[0].steps.godaddyInventory.summary.data_date).toBe('2026-10-20');
  });

  it('DS521-11 (AT-7) buildPanel: gone_before_end_n counts names of the previous day, still due to end after the new day began, that are absent today', async () => {
    const rows = (d: string, names: Array<[string, string]>) => names.map(([domain, ends]) => ({ data_date: d, source: 'godaddy_closeouts', domain, price_cents: 100, ends_at: new Date(ends) }));
    await db.insertInto('datasave_pool').values([
      ...rows('2026-10-19', [['stays.com', '2026-10-20T10:00:00Z'], ['gone1.com', '2026-10-20T10:00:00Z'], ['gone2.com', '2026-10-21T10:00:00Z'], ['ended.com', '2026-10-19T20:00:00Z']]),
      ...rows('2026-10-20', [['stays.com', '2026-10-20T10:00:00Z'], ['fresh.com', '2026-10-21T10:00:00Z']]),
    ]).execute();
    expect(await job().buildPanel()).toMatchObject({ status: 'ok', data_date: '2026-10-20', previous_date: '2026-10-19', rows: 2, previous_rows: 4, gone_before_end_n: 2, new_n: 1, gone_bought_n: 0, gone_deleted_n: 0, gone_unknown_n: 2, dynadot: null });
    await db.deleteFrom('datasave_pool').where('data_date', '=', '2026-10-19').execute();
    expect(await job().buildPanel()).toMatchObject({ status: 'no_previous_day', gone_before_end_n: null });
  });

  it('DS521-12 (AT-8) a raw zip saved 8 days ago is deleted, its manifest stays (sha256), raw_available false and raw_deleted_at set; a 7-day-old one stays', async () => {
    const old = join(SNAP, 'godaddy_inventory', '2026-10-12'); const keep = join(SNAP, 'godaddy_inventory', '2026-10-13');
    await mkdir(old, { recursive: true }); await mkdir(keep, { recursive: true });
    await writeFile(join(old, 'a.zip'), 'x'); await writeFile(join(keep, 'b.zip'), 'y');
    const m = (d: string, f: string, p: string) => db.insertInto('snapshot_manifests').values({ source: 'godaddy_inventory', data_date: d, file_name: f, bytes: 1, sha256: sha256(f), rows: null, status: 'complete', http_status: 200, sealed_at: new Date(NOW), raw_path: p, raw_available: true }).execute();
    await m('2026-10-12', 'a.zip', join(old, 'a.zip')); await m('2026-10-13', 'b.zip', join(keep, 'b.zip'));
    await db.insertInto('datasave_pool').values([{ data_date: '2026-10-12', source: 'godaddy_closeouts', domain: 'old.com', price_cents: 1, ends_at: new Date(NOW) }]).execute();
    const s = await job().snapshotRetention();
    expect(s).toMatchObject({ raw_deleted: 1, raw_cutoff_date: '2026-10-13' });
    expect(existsSync(join(old, 'a.zip'))).toBe(false);
    expect(existsSync(join(keep, 'b.zip'))).toBe(true);
    const { get } = await boot();
    const snaps = (await get('/snapshots?date=2026-10-12')).json().snapshots;
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({ file_name: 'a.zip', sha256: sha256('a.zip'), status: 'complete', raw_available: false });
    expect(Date.parse(snaps[0].raw_deleted_at)).toBe(NOW);
    expect((await get('/snapshots?date=2026-10-13')).json().snapshots[0].raw_available).toBe(true);
  });

  it('DS521-13 (AT-9) the job never fetches a past data date: it takes only what is published now; no route re-parses or re-downloads (410 RAW_EXPIRED is reserved)', async () => {
    const hits: string[] = [];
    mswServer.use(...inventoryHandlers({ hits }));
    const { get } = await boot();
    await runJobToEnd(app!, 'datasave');
    expect(hits.every((h) => h === 'metadata.json' || FILES.includes(h))).toBe(true);
    expect((await get('/snapshots/2026-10-12/raw')).statusCode).toBe(404);
  });

  it('DS521-14 the Dynadot steps report not_configured (not error, not zero rows) and do not fail the run or /health', async () => {
    mswServer.use(...inventoryHandlers());
    const { get } = await boot();
    const run = await runJobToEnd(app!, 'datasave');
    for (const s of ['dynadotCloseouts', 'dynadotAftermarket']) {
      expect(run.json().steps[s]).toMatchObject({ ok: true, summary: { status: 'not_configured' } });
      expect(run.json().steps[s].summary.rows).toBeUndefined();
    }
    expect(run.json().ok).toBe(true);
    expect((await get('/health')).json().datasave).toBe('ok');
  });

  it('DS521-15 pool rows older than the keep days (2 since 5.49.0) are pruned; the manifest rows stay for good', async () => {
    const at = (d: string, domain: string) => ({ data_date: d, source: 'godaddy_closeouts', domain, price_cents: 1, ends_at: new Date(NOW) });
    await db.insertInto('datasave_pool').values([at('2026-10-17', 'd17.com'), at('2026-10-18', 'd18.com'), at('2026-10-20', 'd20.com')]).execute();
    await db.insertInto('snapshot_manifests').values({ source: 'godaddy_inventory', data_date: '2026-10-17', file_name: 'z.zip', rows: null, status: 'complete', sealed_at: new Date(NOW) }).execute();
    expect(await job().snapshotRetention()).toMatchObject({ pool_cutoff_date: '2026-10-19', pool_rows_deleted: 2 });
    expect((await db.selectFrom('datasave_pool').select('domain').orderBy('domain').execute()).map((r) => r.domain)).toEqual(['d20.com']);
    expect(await db.selectFrom('snapshot_manifests').select('id').execute()).toHaveLength(1);
  });

  it('DS521-16 the folder can not be written: the job goes on without raw files (raw_available false with a reason); a parse failure is partial, never complete', async () => {
    await mkdir(SNAP, { recursive: true });
    await writeFile(join(SNAP, 'godaddy_inventory'), 'a file where the folder should go'); // mkdir fails
    mswServer.use(...inventoryHandlers({ bodies: { 'closeout_listings.json.zip': closeoutsZip } })); // v5.22.0: the auction files are parsed too, so they must be valid zips
    const { get } = await boot();
    await runJobToEnd(app!, 'datasave');
    const snaps = (await get('/snapshots?date=2026-10-20')).json().snapshots as Array<{ file_name: string; status: string; raw_available: boolean; raw_note: string | null; rows: number | null }>;
    expect(snaps.every((s) => s.status === 'complete' && !s.raw_available && /not writable/.test(s.raw_note ?? ''))).toBe(true);
    expect(snaps.find((s) => s.file_name === 'closeout_listings.json.zip')!.rows).toBe(2);
    // a closeouts file that is not a zip: partial (kept raw, no rows), not complete
    await rm(SNAP, { recursive: true, force: true });
    mswServer.resetHandlers(); mswServer.use(...inventoryHandlers({ lastModified: Object.fromEntries(FILES.map((f) => [f, '2026-10-21T01:00:00Z'])), bodies: { 'closeout_listings.json.zip': Buffer.from('not a zip') } }));
    const run = await runJobToEnd(app!, 'datasave');
    expect(run.json().steps.godaddyInventory.ok).toBe(false);
    const c = (await get('/snapshots?date=2026-10-21')).json().snapshots.find((s: { file_name: string }) => s.file_name === 'closeout_listings.json.zip');
    expect(c).toMatchObject({ status: 'partial', rows: null, sealed: false, raw_available: true });
    expect((await get('/health')).json().datasave).toBe('partial');
  });

  it('DS521-17 GET /snapshots/missing lists the days without a complete save of every file (partial days say which files); validation errors are 400', async () => {
    for (const f of FILES) await db.insertInto('snapshot_manifests').values({ source: 'godaddy_inventory', data_date: '2026-10-19', file_name: f, rows: null, status: 'complete', sealed_at: new Date(NOW) }).execute();
    await db.insertInto('snapshot_manifests').values({ source: 'godaddy_inventory', data_date: '2026-10-18', file_name: FILES[0]!, rows: null, status: 'complete', sealed_at: new Date(NOW) }).execute();
    const { get } = await boot();
    const r = (await get('/snapshots/missing?from=2026-10-17&to=2026-10-20')).json();
    expect(r).toMatchObject({ source: 'godaddy_inventory', from: '2026-10-17', to: '2026-10-20', expected_files: FILES });
    expect(r.missing).toEqual([
      { date: '2026-10-17', missing_files: FILES, status: 'missing' },
      { date: '2026-10-18', missing_files: FILES.slice(1), status: 'partial' },
      { date: '2026-10-20', missing_files: FILES, status: 'missing' },
    ]);
    expect((await get('/snapshots/missing')).json()).toMatchObject({ to: '2026-10-19' }); // 15:00 UTC: today's data date is not due yet
    expect((await get('/snapshots?date=2026-13-45')).statusCode).toBe(400);
    expect((await get('/snapshots?source=nope')).statusCode).toBe(400);
    expect((await get('/snapshots/missing?from=2026-10-20&to=2026-10-01')).statusCode).toBe(400);
  });

  it('DS521-18 /health.datasave is partial when only some files are saved, and a failed later run is an error even though yesterday is within 26 h', async () => {
    mswServer.use(...inventoryHandlers({ status: { 'all_biddable_auctions.json.zip': 500 } }));
    const { get } = await boot();
    await runJobToEnd(app!, 'datasave');
    expect((await get('/health')).json().datasave).toBe('partial');
    const snaps = (await get('/snapshots?date=2026-10-20')).json().snapshots as Array<{ file_name: string; status: string; http_status: number | null }>;
    expect(snaps.find((s) => s.file_name === 'all_biddable_auctions.json.zip')).toMatchObject({ status: 'error', http_status: 500 });
  });

  it('DS521-19 the datasave settings come from the settings row (default file list and caps)', async () => {
    const s = await db.selectFrom('settings').select(['datasave_godaddy_files', 'datasave_pool_max_price_cents', 'datasave_pool_keep_days', 'datasave_raw_keep_days']).executeTakeFirstOrThrow();
    expect(s).toEqual({ datasave_godaddy_files: FILES, datasave_pool_max_price_cents: 4000, datasave_pool_keep_days: 2, datasave_raw_keep_days: 7 });
    await sql`select 1`.execute(db);
  });
});

describe('DS537 in-range GoDaddy auctions with bids (godaddy_auctions_live)', () => {
  const AUCTION_FILES = ['all_expiring_auctions.json.zip', 'all_biddable_auctions.json.zip', 'all_listings_ending_today.json.zip', 'auctions_ending_today.json.zip'];
  const END = '2026-10-21T09:00:00Z';
  const day = (perFile: Record<string, Parameters<typeof auctionsJson>[0]>, lm?: string) => {
    const bodies: Record<string, Buffer> = {};
    for (const f of AUCTION_FILES) bodies[f] = makeZip(f.replace(/\.zip$/, ''), auctionsJson(perFile[f] ?? []));
    mswServer.resetHandlers();
    mswServer.use(...inventoryHandlers({ bodies, ...(lm ? { lastModified: Object.fromEntries(['closeout_listings.json.zip', ...AUCTION_FILES].map((f) => [f, lm])) } : {}) }));
  };
  const live = () => db.selectFrom('godaddy_auctions_live').select(['data_date', 'domain', 'price_cents', 'bid_count', 'domain_age', 'valuation_cents', 'pageviews', 'auction_type', 'end_time']).orderBy('domain').execute();

  it('DS537-1 a $40 auction with 3 bids and a $250 one with 1 bid are kept with age, valuation and pageviews; 0 bids, $250.01, .net and adult are not; godaddy_auctions follows the $100 floor of settings.datasave_auction_min_cents (5.41.0: the $250 and $250.01 rows are followed too)', async () => {
    await boot();
    day({ 'all_biddable_auctions.json.zip': [
      { domainName: 'Forty.com', price: '$40', auctionEndTime: END, numberOfBids: 3, domainAge: 7, valuation: '$1,234', pageviews: 55 },
      { domainName: 'edge.com', price: '$250', auctionEndTime: END, numberOfBids: 1 },
      { domainName: 'nobids.com', price: '$40', auctionEndTime: END, numberOfBids: 0 },
      { domainName: 'over.com', price: '$250.01', auctionEndTime: END, numberOfBids: 5 },
      { domainName: 'x.net', price: '$40', auctionEndTime: END, numberOfBids: 5 },
      { domainName: 'adult.com', price: '$40', auctionEndTime: END, numberOfBids: 5, isAdult: true },
      { domainName: 'big.com', price: '$900', auctionEndTime: END, numberOfBids: 2 },
    ] });
    const r = await runJobToEnd(app!, 'datasave');
    expect(r.json().ok).toBe(true);
    expect(r.json().steps.godaddyInventory.summary).toMatchObject({ live_kept_n: 2, live_band_max_cents: 25000, tracked_n: 3 });
    expect(await live()).toEqual([
      { data_date: '2026-10-20', domain: 'edge.com', price_cents: 25000, bid_count: 1, domain_age: 1, valuation_cents: 0, pageviews: 0, auction_type: 'Bid', end_time: new Date(END) },
      { data_date: '2026-10-20', domain: 'forty.com', price_cents: 4000, bid_count: 3, domain_age: 7, valuation_cents: 123400, pageviews: 55, auction_type: 'Bid', end_time: new Date(END) },
    ]);
    expect((await db.selectFrom('godaddy_auctions').select('domain').orderBy('domain').execute()).map((x) => x.domain)).toEqual(['big.com', 'edge.com', 'over.com']);
  });

  it('DS537-2 the same domain in two auction files merges (max bids and price); running the day again does not duplicate', async () => {
    await boot();
    day({
      'all_expiring_auctions.json.zip': [{ domainName: 'dup.com', price: '$40', auctionEndTime: END, numberOfBids: 2 }],
      'all_biddable_auctions.json.zip': [{ domainName: 'dup.com', price: '$60', auctionEndTime: '2026-10-21T09:05:00Z', numberOfBids: 4, domainAge: 3 }, { domainName: 'dup.com', price: '$50', auctionEndTime: END, numberOfBids: 1 }],
    });
    await runJobToEnd(app!, 'datasave');
    const once = await live();
    expect(once).toHaveLength(1);
    expect(once[0]).toMatchObject({ domain: 'dup.com', price_cents: 6000, bid_count: 4, domain_age: 1, end_time: new Date('2026-10-21T09:05:00Z') });
    await runJobToEnd(app!, 'datasave');
    expect(await live()).toEqual(once);
  });

  it('AS549-6 (P3) the free demand fields of the inventory rows (exact-match and developed endings, keyword registrations, search volume, CPC in cents) are stored in godaddy_auctions_live; missing or non-numeric is null; a later file fills a null, never overwrites a value', async () => {
    await boot();
    const fx = JSON.parse(readFileSync('tests/fixtures/datasave/godaddy-demand-fields.sample.json', 'utf8')) as { data: Array<Record<string, unknown>>; expected: Record<string, Record<string, number | null>> };
    const one = fx.data.map((r) => ({ price: '$40', auctionEndTime: END, numberOfBids: 2, ...r })) as Parameters<typeof auctionsJson>[0];
    day({ 'all_biddable_auctions.json.zip': one, 'all_expiring_auctions.json.zip': [{ domainName: 'charlie.com', price: '$40', auctionEndTime: END, numberOfBids: 2, exactMatchTlds: 4 }, { domainName: 'alpha.com', price: '$40', auctionEndTime: END, numberOfBids: 2, exactMatchTlds: 1 }] });
    await runJobToEnd(app!, 'datasave');
    const got = await db.selectFrom('godaddy_auctions_live').select(['domain', 'exact_match_tlds', 'developed_tlds', 'keyword_registrations', 'search_volume', 'cpc_cents']).orderBy('domain').execute();
    // the files are parsed one after the other and merged by coalesce: the first known value stays, a null is filled by a later file. The expiring file (first) carries only exactMatchTlds for
    // charlie.com (4: the fixture's own value is a string, so null) and alpha.com (1, kept against the later 8); the other alpha.com fields come from the biddable file.
    const want = { ...fx.expected, 'alpha.com': { ...fx.expected['alpha.com']!, exact_match_tlds: 1 }, 'charlie.com': { ...fx.expected['charlie.com']!, exact_match_tlds: 4 } };
    expect(Object.fromEntries(got.map(({ domain, ...rest }) => [domain, rest]))).toEqual(want);
  });

  it('DS554-1 a sealed auction day whose live rows have no demand fields (parsed before v5.49.0) is parsed again from the kept raw file on the next run; a day that has them is not', async () => {
    await boot();
    day({ 'all_biddable_auctions.json.zip': [{ domainName: 'alpha.com', price: '$40', auctionEndTime: END, numberOfBids: 2, exactMatchTlds: 7, developedTlds: 3 }] });
    await runJobToEnd(app!, 'datasave');
    await sql`update godaddy_auctions_live set exact_match_tlds = null, developed_tlds = null`.execute(db); // as a day saved by v5.48.0 looks
    const second = (await runJobToEnd(app!, 'datasave')).json().steps.godaddyInventory.summary;
    expect(second.files.find((f: { file: string }) => f.file === 'all_biddable_auctions.json.zip')).toMatchObject({ code: 'SNAPSHOT_SEALED_REPARSED' });
    expect(second.reparsed_n).toBeGreaterThanOrEqual(1);
    expect(await db.selectFrom('godaddy_auctions_live').select(['exact_match_tlds', 'developed_tlds']).where('domain', '=', 'alpha.com').executeTakeFirst()).toEqual({ exact_match_tlds: 7, developed_tlds: 3 });
    const third = (await runJobToEnd(app!, 'datasave')).json().steps.godaddyInventory.summary;
    expect(third.reparsed_n).toBe(0);
  });

  it('DS537-3 raising s8_max_price_cents widens the band on the next run (the band follows the cap)', async () => {
    await boot();
    const rows = [{ domainName: 'mid.com', price: '$300', auctionEndTime: END, numberOfBids: 2 }];
    day({ 'all_biddable_auctions.json.zip': rows });
    await runJobToEnd(app!, 'datasave');
    expect(await live()).toEqual([]);
    await sql`update settings set s8_max_price_cents = 40000`.execute(db);
    try {
      clock = NOW + DAY;
      day({ 'all_biddable_auctions.json.zip': rows }, '2026-10-21T14:41:59Z');
      const r = await runJobToEnd(app!, 'datasave');
      expect(r.json().steps.godaddyInventory.summary).toMatchObject({ live_kept_n: 1, live_band_max_cents: 40000 });
      expect((await live()).map((x) => x.domain)).toEqual(['mid.com']);
    } finally { await sql`update settings set s8_max_price_cents = 25000`.execute(db); }
  });

  it('DS537-4 retention removes live rows older than datasave_auction_live_keep_days (7)', async () => {
    const v = (data_date: string, domain: string) => ({ data_date, domain, end_time: new Date(END), price_cents: 1000, bid_count: 1 });
    await db.insertInto('godaddy_auctions_live').values([v('2026-10-12', 'old.com'), v('2026-10-13', 'edge.com'), v('2026-10-20', 'today.com')]).execute();
    const r = await job().snapshotRetention() as Record<string, unknown>;
    expect(r).toMatchObject({ auctions_live_cutoff_date: '2026-10-13', auctions_live_deleted: 1 });
    expect((await live()).map((x) => x.domain)).toEqual(['edge.com', 'today.com']);
  });
});
