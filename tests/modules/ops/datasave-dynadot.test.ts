// v5.22.0 (CR-071 R-8, R-9, R-10): POST /snapshots/dynadot (bot uploads, sealed like the GoDaddy files) and the GoDaddy auction endings (godaddy_auctions).
// Every outside call is mocked (MSW); the fixtures are tiny and synthetic.
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../../../src/config.js';
import { DatasaveJob } from '../../../src/modules/ops/jobs/datasave/datasave.js';
import { makeApp, runJobToEnd } from '../../helpers/app.js';
import { auctionsJson, closeoutsJson, FILES, inventoryHandlers, makeZip } from '../../helpers/datasave.js';
import { testDb as db } from '../../helpers/db.js';
import { testEnv } from '../../helpers/env.js';
import { issueToken } from '../../helpers/tokens.js';
import { mswServer } from '../../setup/network.js';

const NOW = Date.parse('2026-10-20T15:00:30Z');
const SNAP = loadConfig(testEnv()).snapshotDir;
let app: FastifyInstance | undefined;
let clock = NOW;
let n = 0;

beforeEach(async () => { clock = NOW; await rm(SNAP, { recursive: true, force: true }); });
afterEach(async () => { await app?.close(); app = undefined; });

const boot = async () => {
  app = await makeApp({ testRoutes: false, now: () => clock, env: { JOB_TRIGGER_TOKEN: 'job_token_fake_0123456789abcdef0123456789' } });
  const bots = await issueToken('bots');
  const read = await issueToken('read');
  const write = await issueToken('write');
  const post = (payload: object, auth = bots.auth, key = `dyn-${++n}`) => app!.inject({ method: 'POST', url: '/snapshots/dynadot', headers: { ...auth, 'idempotency-key': key }, payload });
  const get = (url: string) => app!.inject({ method: 'GET', url, headers: read.auth });
  return { post, get, bots, read, write };
};
const AM = (domain: string, listing_id: string, price_cents: number) => ({ domain, listing_id, price_cents });
const CA = (domain: string, bid_count: number, final_price_cents: number) => ({ domain, end_time: '2026-10-19T20:00:00Z', bid_count, final_price_cents });

describe('DS522 Dynadot bot uploads', () => {
  it('DS522-1 (AT-10) aftermarket in two parts then final: the day seals with the sha256 of the canonical rows; no duplicate listing_id, every price >= $500, origin bot_upload', async () => {
    const { post, get } = await boot();
    const a = await post({ kind: 'aftermarket', data_date: '2026-10-20', rows: [AM('Beta.com', 'L2', 60000), AM('alpha.com', 'L1', 50000), AM('alpha.com', 'L1', 50000)] });
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ received_n: 3, accepted_n: 2, duplicate_n: 1, rows_stored_n: 2, sealed: false, status: 'partial', sha256: null });
    let m = (await get('/snapshots?date=2026-10-20&source=dynadot_aftermarket')).json().snapshots[0];
    expect(m).toMatchObject({ status: 'partial', sealed: false, origin: 'bot_upload', rows: 2, file_name: 'bot_upload' });
    const b = await post({ kind: 'aftermarket', data_date: '2026-10-20', rows: [AM('gamma.com', 'L3', 99900), AM('beta.com', 'L2', 60000)], final: true });
    expect(b.json()).toMatchObject({ accepted_n: 1, duplicate_n: 1, rows_stored_n: 3, sealed: true, status: 'complete' });
    const expected = createHash('sha256').update(JSON.stringify([
      { domain: 'alpha.com', listing_id: 'L1', price_cents: 50000 }, { domain: 'beta.com', listing_id: 'L2', price_cents: 60000 }, { domain: 'gamma.com', listing_id: 'L3', price_cents: 99900 },
    ])).digest('hex');
    expect(b.json().sha256).toBe(expected);
    const res = (await get('/snapshots?date=2026-10-20&source=dynadot_aftermarket&rows=100')).json();
    m = res.snapshots[0];
    expect(m).toMatchObject({ status: 'complete', sealed: true, sha256: expected, origin: 'bot_upload', rows: 3, price_unit: 'cents' });
    expect(res.rows).toHaveLength(3);
    expect(res.rows.every((r: { price_cents: number }) => r.price_cents >= 50000)).toBe(true);
    expect(new Set(res.rows.map((r: { listing_id: string }) => r.listing_id)).size).toBe(3);
  });

  it('DS532-1 (BUG-051) 50,000 rows pass; 50,001 is 422 ROWS_LIMIT; a price over the cap is 422 PRICE_CAP with the row indexes; the cap is inclusive; nothing stored; other errors stay VALIDATION_ERROR', async () => {
    const { post, get } = await boot();
    const many = (n: number) => Array.from({ length: n }, (_, i) => AM(`n${i}.com`, `L${i}`, 60000));
    const ok = await post({ kind: 'aftermarket', data_date: '2026-10-20', dry_run: true, rows: many(50_000) });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().received_n).toBe(50_000);
    const big = await post({ kind: 'aftermarket', data_date: '2026-10-20', rows: many(50_001) });
    expect(big.statusCode).toBe(422);
    expect(big.json().error).toMatchObject({ code: 'ROWS_LIMIT', details: { max_rows: 50_000, received_n: 50_001 } });
    const cap = await post({ kind: 'aftermarket', data_date: '2026-10-20', rows: [AM('a.com', 'L1', 60000), AM('naonu.com', 'L2', 5_680_000_000), AM('b.com', 'L3', 2_000_000_000)] });
    expect(cap.statusCode).toBe(422);
    expect(cap.json().error).toMatchObject({ code: 'PRICE_CAP', details: { max_cents: 2_000_000_000, rows: [1], over_n: 1 } });
    const ca = await post({ kind: 'closed_auctions', data_date: '2026-10-20', rows: [CA('c.com', 3, 2_000_000_001)] });
    expect(ca.json().error).toMatchObject({ code: 'PRICE_CAP', details: { rows: [0] } });
    const edge = await post({ kind: 'aftermarket', data_date: '2026-10-20', dry_run: true, rows: [AM('b.com', 'L3', 2_000_000_000)] });
    expect(edge.statusCode).toBe(201);
    expect((await post({ kind: 'aftermarket', data_date: '2026-10-20', rows: [{ domain: 'a.com', listing_id: 'L1', price_cents: 1.5 }] })).json().error.code).toBe('VALIDATION_ERROR');
    expect((await get('/snapshots?date=2026-10-20&source=dynadot_aftermarket')).json().snapshots).toHaveLength(0);
    const spec = (await get('/openapi.json')).json();
    const body = JSON.stringify(spec.paths['/snapshots/dynadot'].post.requestBody);
    expect(body).toContain('"maxItems":50000');
    expect(body).toContain('"maximum":2000000000');
  });

  it('DS524-1 (AT-14) a final upload with coverage seals the day as complete and GET /snapshots shows the same coverage object', async () => {
    const { post, get } = await boot();
    const planned = [40, 78, 116, 154, 192, 230, 268, 306, 344, 382, 420, 458, 496, 534, 572];
    const coverage = { partial: true, calls_n: 18, pages_planned: planned, pages_ok: planned.filter((p) => p !== 534), pages_failed: [534], rows_received_n: 92000 };
    const r = await post({ kind: 'aftermarket', data_date: '2026-10-20', rows: [AM('alpha.com', 'L1', 50000)], final: true, coverage });
    expect(r.statusCode, r.body).toBe(201);
    const m = (await get('/snapshots?date=2026-10-20&source=dynadot_aftermarket')).json().snapshots[0];
    expect(m).toMatchObject({ status: 'complete', sealed: true, coverage });
    // the seal guard freezes coverage too
    await expect(db.updateTable('snapshot_manifests').set({ coverage: JSON.stringify({ partial: false }) }).where('source', '=', 'dynadot_aftermarket').execute()).rejects.toThrow(/sealed snapshot manifest/);
  });

  it('DS524-2 (AT-15) coverage with an unknown key, a non-integer page, or pages_ok outside pages_planned is 422 and stores nothing; without coverage the manifest shows coverage null', async () => {
    const { post, get } = await boot();
    const base = { partial: false, calls_n: 2, pages_planned: [40, 78], pages_ok: [40, 78], pages_failed: [], rows_received_n: 10 };
    for (const coverage of [{ ...base, extra: 1 }, { ...base, pages_ok: [40.5] }, { ...base, pages_ok: [40, 99] }, { ...base, pages_failed: [99] }]) {
      const r = await post({ kind: 'aftermarket', data_date: '2026-10-20', rows: [AM('alpha.com', 'L1', 50000)], final: true, coverage });
      expect(r.statusCode, JSON.stringify(coverage)).toBe(422);
      expect(r.json().error.code).toBe('VALIDATION_ERROR');
    }
    expect((await get('/snapshots?date=2026-10-20&source=dynadot_aftermarket')).json().snapshots).toEqual([]);
    expect((await post({ kind: 'aftermarket', data_date: '2026-10-20', rows: [AM('alpha.com', 'L1', 50000)], final: true })).statusCode).toBe(201);
    expect((await get('/snapshots?date=2026-10-20&source=dynadot_aftermarket')).json().snapshots[0]).toMatchObject({ sealed: true, coverage: null });
  });

  it('DS522-2 (AT-11) closed auctions: each row keeps bid_count and final_price_cents (cents) and the manifest is sealed; a final-only call seals what was stored', async () => {
    const { post, get } = await boot();
    expect((await post({ kind: 'closed_auctions', data_date: '2026-10-20', rows: [CA('Sold.com', 7, 123400), CA('none.com', 0, 0)] })).statusCode).toBe(201);
    const fin = await post({ kind: 'closed_auctions', data_date: '2026-10-20', rows: [], final: true });
    expect(fin.json()).toMatchObject({ sealed: true, rows_stored_n: 2, status: 'complete' });
    const res = (await get('/snapshots?date=2026-10-20&source=dynadot_closed_auctions&rows=10')).json();
    expect(res.snapshots[0]).toMatchObject({ status: 'complete', sealed: true, origin: 'bot_upload', rows: 2 });
    expect(res.rows.map((r: { domain: string; bid_count: number; final_price_cents: number }) => [r.domain, r.bid_count, r.final_price_cents])).toEqual([['none.com', 0, 0], ['sold.com', 7, 123400]]);
    expect(res.rows.map((r: { end_time: string }) => Date.parse(r.end_time))).toEqual([Date.parse('2026-10-19T20:00:00Z'), Date.parse('2026-10-19T20:00:00Z')]);
  });

  it('DS522-3 (AT-13) an upload for a sealed kind and day is 409 SNAPSHOT_SEALED and changes nothing; an aftermarket row under $500 is dropped and counted', async () => {
    const { post, get } = await boot();
    const first = await post({ kind: 'aftermarket', data_date: '2026-10-20', final: true, rows: [AM('keep.com', 'K1', 50000), AM('cheap.com', 'K2', 49999), AM('cheap2.com', 'K3', 1000)] });
    expect(first.json()).toMatchObject({ received_n: 3, accepted_n: 1, dropped_under_500_n: 2, dropped_below_floor_n: 2, sealed: true });
    const sha = first.json().sha256;
    const again = await post({ kind: 'aftermarket', data_date: '2026-10-20', rows: [AM('late.com', 'K9', 90000)] });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatchObject({ code: 'SNAPSHOT_SEALED', details: { sha256: sha } });
    expect(await db.selectFrom('dynadot_rows').select('domain').execute()).toEqual([{ domain: 'keep.com' }]);
    expect((await get('/snapshots?date=2026-10-20&source=dynadot_aftermarket')).json().snapshots[0].sha256).toBe(sha);
    // another kind or another day is not sealed
    expect((await post({ kind: 'closeouts', data_date: '2026-10-20', rows: [{ domain: 'x.com', price_cents: 100 }] })).statusCode).toBe(201);
    expect((await post({ kind: 'aftermarket', data_date: '2026-10-19', rows: [AM('late.com', 'K9', 90000)] })).statusCode).toBe(201);
  });

  it('DS522-4 strict validation: a non-integer price is 422 VALIDATION_ERROR and nothing is stored; so are unknown keys, a future date, an empty non-final upload and an empty seal', async () => {
    const { post } = await boot();
    const bad = [
      { kind: 'aftermarket', data_date: '2026-10-20', rows: [AM('a.com', 'L1', 500.5)] },
      { kind: 'aftermarket', data_date: '2026-10-20', rows: [{ ...AM('a.com', 'L1', 50000), extra: 1 }] },
      { kind: 'closed_auctions', data_date: '2026-10-20', rows: [CA('a.com', 1.5, 100)] },
      { kind: 'closeouts', data_date: '2026-10-20', rows: [{ domain: 'a.com', price_cents: '12' }] },
      { kind: 'closeouts', data_date: '2026-13-40', rows: [{ domain: 'a.com', price_cents: 12 }] },
      { kind: 'closeouts', data_date: '2026-10-21', rows: [{ domain: 'a.com', price_cents: 12 }] },
      { kind: 'closeouts', data_date: '2026-10-20', rows: [] },
      { kind: 'closeouts', data_date: '2026-10-20', rows: [], final: true },
      { kind: 'other', data_date: '2026-10-20', rows: [] },
    ];
    for (const b of bad) {
      const r = await post(b);
      expect(r.statusCode, JSON.stringify(b)).toBe(422);
      expect(r.json().error.code).toBe('VALIDATION_ERROR');
    }
    expect(await db.selectFrom('dynadot_rows').select('id').execute()).toHaveLength(0);
    expect(await db.selectFrom('snapshot_manifests').select('id').execute()).toHaveLength(0);
  });

  it('DS522-5 dry_run validates and stores nothing (not even a manifest) but still answers the counts and the 409 of a sealed day', async () => {
    const { post } = await boot();
    const dry = await post({ kind: 'aftermarket', data_date: '2026-10-20', dry_run: true, final: true, rows: [AM('a.com', 'L1', 50000), AM('b.com', 'L2', 100)] });
    expect(dry.statusCode).toBe(201);
    expect(dry.json()).toMatchObject({ dry_run: true, accepted_n: 1, dropped_under_500_n: 1, sealed: false, status: 'complete' });
    expect(await db.selectFrom('dynadot_rows').select('id').execute()).toHaveLength(0);
    expect(await db.selectFrom('snapshot_manifests').select('id').execute()).toHaveLength(0);
    expect((await post({ kind: 'aftermarket', data_date: '2026-10-20', dry_run: true, rows: [{ domain: 'a.com', listing_id: 'L', price_cents: 1.5 }] })).statusCode).toBe(422);
    await post({ kind: 'closeouts', data_date: '2026-10-20', final: true, rows: [{ domain: 'a.com', price_cents: 5 }] });
    expect((await post({ kind: 'closeouts', data_date: '2026-10-20', dry_run: true, rows: [{ domain: 'b.com', price_cents: 5 }] })).statusCode).toBe(409);
  });

  it('DS522-6 a bots token and a WRITE token may upload; a READ token is 403; the route needs an Idempotency-Key and replays the same answer', async () => {
    const { post, bots, read, write } = await boot();
    const body = { kind: 'closeouts', data_date: '2026-10-20', rows: [{ domain: 'a.com', price_cents: 5, ends_at: '2026-10-21T10:00:00Z' }] };
    const one = await post(body, bots.auth, 'same-key');
    expect(one.statusCode).toBe(201);
    const replay = await post(body, bots.auth, 'same-key');
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json().audit_id).toBe(one.json().audit_id);
    expect((await post({ ...body, data_date: '2026-10-19' }, write.auth)).statusCode).toBe(201);
    const denied = await post(body, read.auth);
    expect(denied.statusCode).toBe(403);
    const noKey = await app!.inject({ method: 'POST', url: '/snapshots/dynadot', headers: bots.auth, payload: body });
    expect(noKey.statusCode).toBe(400);
  });

  it('DS522-7 the audit row keeps only the row count, never the rows', async () => {
    const { post } = await boot();
    const r = await post({ kind: 'aftermarket', data_date: '2026-10-20', rows: [AM('secretname.com', 'L1', 50000), AM('b.com', 'L2', 60000)] });
    const a = await db.selectFrom('audit_log').select(['request', 'result_summary', 'id']).where('path', '=', '/snapshots/dynadot').executeTakeFirstOrThrow();
    expect(a.id).toBe(r.json().audit_id);
    expect(JSON.stringify(a.request)).toContain('[2 rows]');
    expect(JSON.stringify(a.request)).not.toContain('secretname');
    expect(a.result_summary).toContain('2 received');
  });

  it('DS522-8 retention: bot-uploaded closeouts follow the pool days (2 since 5.49.0), aftermarket and closed-auction rows are kept 120 days, manifests stay', async () => {
    const row = (kind: 'aftermarket' | 'closed_auctions' | 'closeouts', d: string, domain: string) => ({ data_date: d, kind, domain, listing_id: kind === 'aftermarket' ? domain : null, price_cents: 1 });
    await db.insertInto('dynadot_rows').values([
      row('closeouts', '2026-10-17', 'c17.com'), row('closeouts', '2026-10-18', 'c18.com'),
      row('aftermarket', '2026-06-22', 'a-old.com'), row('aftermarket', '2026-06-23', 'a-keep.com'), row('closed_auctions', '2026-06-20', 'x-old.com'), row('closed_auctions', '2026-10-01', 'x-keep.com'),
    ]).execute();
    await db.insertInto('snapshot_manifests').values({ source: 'dynadot_aftermarket', data_date: '2026-06-22', file_name: 'bot_upload', rows: 1, status: 'complete', sealed_at: new Date(NOW), origin: 'bot_upload' }).execute();
    const r = await new DatasaveJob({ db, now: () => clock, snapshotDir: SNAP }).snapshotRetention() as Record<string, unknown>;
    expect(r).toMatchObject({ dynadot_closeouts_deleted: 2, dynadot_rows_deleted: 2, dynadot_cutoff_date: '2026-06-23' });
    expect((await db.selectFrom('dynadot_rows').select('domain').orderBy('domain').execute()).map((x) => x.domain)).toEqual(['a-keep.com', 'x-keep.com']);
    expect(await db.selectFrom('snapshot_manifests').select('id').execute()).toHaveLength(1);
  });

  it('DS522-9 /health.datasave and DATASAVE_MISSED stay quiet until a Dynadot kind has had an upload, then flag the due day only after 16:00 UTC', async () => {
    mswServer.use(...inventoryHandlers());
    const { post, get } = await boot();
    clock = Date.parse('2026-10-20T15:10:00Z');
    await runJobToEnd(app!, 'datasave');
    expect((await get('/health')).json().datasave).toBe('ok');
    const codes = async () => ((await get('/report')).json().warnings as { code: string }[]).map((w) => w.code);
    expect(await codes()).not.toContain('DATASAVE_MISSED');
    // the first upload (for the 19th) starts the watch; 20 Oct 16:30 UTC the 20th is due and missing
    await post({ kind: 'aftermarket', data_date: '2026-10-19', final: true, rows: [AM('a.com', 'L1', 50000)] });
    clock = Date.parse('2026-10-20T15:50:00Z'); // still inside the retry window: the 19th is the due day and is sealed
    expect((await get('/health')).json().datasave).toBe('ok');
    expect(await codes()).not.toContain('DATASAVE_MISSED');
    clock = Date.parse('2026-10-20T16:30:00Z');
    expect((await get('/health')).json().datasave).toBe('partial');
    const w = ((await get('/report')).json().warnings as { code: string; level: string; details: { sources: string[]; dynadot_missing: { source: string; data_date: string }[] } }[]).find((x) => x.code === 'DATASAVE_MISSED')!;
    expect(w.level).toBe('warn');
    expect(w.details.sources).toEqual(['godaddy_inventory', 'dynadot_aftermarket']);
    expect(w.details.dynadot_missing).toEqual([{ source: 'dynadot_aftermarket', data_date: '2026-10-20' }]);
    // the upload for the 20th clears it; a kind that never uploaded is never flagged
    await post({ kind: 'aftermarket', data_date: '2026-10-20', final: true, rows: [AM('a.com', 'L1', 50000)] });
    expect((await get('/health')).json().datasave).toBe('ok');
    expect(await codes()).not.toContain('DATASAVE_MISSED');
  });

  it('v5.50.0 (P8) DS550-1 a Dynadot kind with no sealed upload for 3 days counts as paused: nothing is missing and the state stays ok; an upload within 3 days is still expected', async () => {
    mswServer.use(...inventoryHandlers());
    const { post, get } = await boot();
    clock = Date.parse('2026-10-20T15:10:00Z');
    await runJobToEnd(app!, 'datasave');
    await post({ kind: 'aftermarket', data_date: '2026-10-17', final: true, rows: [AM('a.com', 'L1', 50000)] });
    clock = Date.parse('2026-10-20T16:30:00Z'); // the 17th is 3 days back: still expected, the 20th is missing
    expect((await get('/health')).json().datasave).toBe('partial');
    clock = Date.parse('2026-10-21T16:30:00Z'); // 4 days since the last sealed upload: paused
    mswServer.use(...inventoryHandlers({ lastModified: Object.fromEntries(FILES.map((f) => [f, '2026-10-21T14:41:59Z'])) })); // BUG-060: GoDaddy has published the 21st
    await runJobToEnd(app!, 'datasave');
    expect((await get('/health')).json().datasave).toBe('ok');
    expect(((await get('/report')).json().warnings as { code: string }[]).map((w) => w.code)).not.toContain('DATASAVE_MISSED');
  });

  it('DS522-10 the dynadotCloseouts / dynadotAftermarket steps stay not_configured and report whether a bot upload for today is sealed', async () => {
    mswServer.use(...inventoryHandlers());
    const { post } = await boot();
    await post({ kind: 'aftermarket', data_date: '2026-10-20', final: true, rows: [AM('a.com', 'L1', 50000)] });
    const run = await runJobToEnd(app!, 'datasave');
    expect(run.json().ok).toBe(true);
    expect(run.json().steps.dynadotAftermarket.summary).toMatchObject({ status: 'not_configured', bot_upload: { data_date: '2026-10-20', sealed: true, rows: 1 } });
    expect(run.json().steps.dynadotCloseouts.summary).toMatchObject({ status: 'not_configured', bot_upload: { sealed: false, status: 'none', rows: null } });
  });
});

describe('DS522 GoDaddy auction endings', () => {
  const AUCTION_FILES = ['all_expiring_auctions.json.zip', 'all_biddable_auctions.json.zip', 'all_listings_ending_today.json.zip', 'auctions_ending_today.json.zip'];
  const LM2 = '2026-10-21T14:41:59Z';
  /** One data day: the same rows go to the file(s) given; the other auction files are empty. */
  const day = (lm: string | undefined, perFile: Record<string, Parameters<typeof auctionsJson>[0]>) => {
    const bodies: Record<string, Buffer> = {};
    for (const f of AUCTION_FILES) bodies[f] = makeZip(f.replace(/\.zip$/, ''), auctionsJson(perFile[f] ?? []));
    mswServer.resetHandlers();
    mswServer.use(...inventoryHandlers({ bodies, ...(lm ? { lastModified: Object.fromEntries(['closeout_listings.json.zip', ...AUCTION_FILES].map((f) => [f, lm])) } : {}) }));
  };
  const END1 = '2026-10-21T09:00:00Z'; // an auction ending on the 21st, before the 21st's files are built
  const rowsDay1 = [
    { domainName: 'Big-Bid.com', price: '$1,250', auctionEndTime: END1, numberOfBids: 4 },
    { domainName: 'small.com', price: '$40', auctionEndTime: END1, numberOfBids: 1 },
    { domainName: 'big.net', price: '$900', auctionEndTime: END1, numberOfBids: 2 },
    { domainName: 'adult-big.com', price: '$900', auctionEndTime: END1, numberOfBids: 2, isAdult: true },
  ];

  it('DS522-11 (AT-12) a $500+ .com auction is followed, a $40 one and a .net are not; the next day it is absent after its end time: ended with its last bid count and price, listed by GET /snapshots?source=godaddy_auction_end', async () => {
    const { get } = await boot();
    day(undefined, { 'all_expiring_auctions.json.zip': rowsDay1 });
    const r1 = await runJobToEnd(app!, 'datasave');
    expect(r1.json().ok).toBe(true);
    expect(r1.json().steps.godaddyInventory.summary).toMatchObject({ auctions_seen_n: 4, tracked_n: 1, ended_today_n: 0 });
    expect(await db.selectFrom('godaddy_auctions').select(['domain', 'last_price_cents', 'max_price_cents', 'last_bid_count', 'ended', 'first_seen', 'last_seen', 'auction_type']).execute())
      .toEqual([{ domain: 'big-bid.com', last_price_cents: 125000, max_price_cents: 125000, last_bid_count: 4, ended: false, first_seen: '2026-10-20', last_seen: '2026-10-20', auction_type: 'Bid' }]);
    // the 21st: the auction left the files
    clock = Date.parse('2026-10-21T15:00:30Z');
    day(LM2, {});
    const r2 = await runJobToEnd(app!, 'datasave');
    expect(r2.json().steps.godaddyInventory.summary).toMatchObject({ auctions_seen_n: 0, tracked_n: 0, ended_today_n: 1, ended_now_n: 1, auction_end_detection: 'ran' });
    const res = (await get('/snapshots?date=2026-10-21&source=godaddy_auction_end')).json();
    expect(res.snapshots).toEqual([]);
    expect(res.auctions).toEqual([{
      domain: 'big-bid.com', end_time: expect.any(String) as unknown, auction_type: 'Bid', first_seen: '2026-10-20', last_seen: '2026-10-20', final_state_at: '2026-10-21',
      bid_count: 4, final_price_cents: 125000, max_price_cents: 125000, price_unit: 'cents',
    }]);
    expect(Date.parse(res.auctions[0].end_time)).toBe(Date.parse(END1));
    expect((await get('/snapshots?date=2026-10-20&source=godaddy_auction_end')).json().auctions).toEqual([]);
  });

  it('DS522-12 a 0-bid ending keeps bid_count 0; a tracked auction whose price fell below $500 stays tracked; a domain in several files merges (max bids and price, latest end time)', async () => {
    await boot();
    day(undefined, {
      'all_expiring_auctions.json.zip': [{ domainName: 'zero.com', price: '$600', auctionEndTime: END1 }, { domainName: 'drop.com', price: '$800', auctionEndTime: '2026-10-25T09:00:00Z', numberOfBids: 3 }],
      'all_biddable_auctions.json.zip': [{ domainName: 'drop.com', price: '$850', auctionEndTime: '2026-10-25T09:05:00Z', numberOfBids: 5 }, { domainName: 'drop.com', price: '$100', auctionEndTime: '2026-10-25T09:00:00Z', numberOfBids: 1 }],
    });
    await runJobToEnd(app!, 'datasave');
    let rows = await db.selectFrom('godaddy_auctions').select(['domain', 'last_price_cents', 'last_bid_count', 'end_time']).orderBy('domain').execute();
    expect(rows).toEqual([
      { domain: 'drop.com', last_price_cents: 85000, last_bid_count: 5, end_time: new Date('2026-10-25T09:05:00Z') },
      { domain: 'zero.com', last_price_cents: 60000, last_bid_count: 0, end_time: new Date(END1) },
    ]);
    clock = Date.parse('2026-10-21T15:00:30Z');
    day(LM2, { 'auctions_ending_today.json.zip': [{ domainName: 'drop.com', price: '$90', auctionEndTime: '2026-10-25T09:05:00Z', numberOfBids: 6 }] });
    const r = await runJobToEnd(app!, 'datasave');
    expect(r.json().steps.godaddyInventory.summary).toMatchObject({ tracked_n: 1, ended_today_n: 1 });
    rows = await db.selectFrom('godaddy_auctions').select(['domain', 'last_price_cents', 'last_bid_count', 'end_time']).orderBy('domain').execute();
    expect(rows).toEqual([
      { domain: 'drop.com', last_price_cents: 9000, last_bid_count: 6, end_time: new Date('2026-10-25T09:05:00Z') },
      { domain: 'zero.com', last_price_cents: 60000, last_bid_count: 0, end_time: new Date(END1) },
    ]);
    const all = await db.selectFrom('godaddy_auctions').select(['domain', 'ended', 'max_price_cents']).orderBy('domain').execute();
    expect(all).toEqual([{ domain: 'drop.com', ended: false, max_price_cents: 85000 }, { domain: 'zero.com', ended: true, max_price_cents: 60000 }]);
  });

  it('DS522-13 an auction that is absent but whose end time has not come stays open (it was not pulled by an end)', async () => {
    await boot();
    day(undefined, { 'all_expiring_auctions.json.zip': [{ domainName: 'later.com', price: '$700', auctionEndTime: '2026-10-30T09:00:00Z', numberOfBids: 2 }] });
    await runJobToEnd(app!, 'datasave');
    clock = Date.parse('2026-10-21T15:00:30Z');
    day(LM2, {});
    const r = await runJobToEnd(app!, 'datasave');
    expect(r.json().steps.godaddyInventory.summary).toMatchObject({ tracked_n: 1, ended_today_n: 0 });
  });

  it('DS522-14 a parse failure of an auction file makes that file partial (with the error, rows null), never complete; the closeouts still parse and seal; nothing ends that day', async () => {
    const { get } = await boot();
    day(undefined, { 'all_expiring_auctions.json.zip': [{ domainName: 'track.com', price: '$700', auctionEndTime: END1, numberOfBids: 2 }] });
    await runJobToEnd(app!, 'datasave');
    clock = Date.parse('2026-10-21T15:00:30Z');
    const bodies: Record<string, Buffer> = { 'closeout_listings.json.zip': makeZip('closeout_listings.json', closeoutsJson([{ domainName: 'a.com', price: '$5', auctionEndTime: '2026-10-22T10:00:00Z' }])), 'all_biddable_auctions.json.zip': makeZip('x.json', '{"meta":{},"data":[{"domainName":"a.com"') };
    mswServer.resetHandlers();
    mswServer.use(...inventoryHandlers({ bodies, lastModified: Object.fromEntries(['closeout_listings.json.zip', ...AUCTION_FILES].map((f) => [f, LM2])) }));
    const run = await runJobToEnd(app!, 'datasave');
    expect(run.json().steps.godaddyInventory.summary).toMatchObject({ auction_end_detection: expect.stringContaining('skipped') as unknown, ended_today_n: 0 });
    const snaps = (await get('/snapshots?date=2026-10-21&source=godaddy_inventory')).json().snapshots as { file_name: string; status: string; rows: number | null; error: string | null; sealed: boolean }[];
    const by = (f: string) => snaps.find((s) => s.file_name === f)!;
    expect(by('all_biddable_auctions.json.zip')).toMatchObject({ status: 'partial', rows: null, sealed: false });
    expect(by('all_biddable_auctions.json.zip').error).toContain('parse failed');
    expect(by('closeout_listings.json.zip')).toMatchObject({ status: 'complete', rows: 1, sealed: true });
    expect(by('all_expiring_auctions.json.zip')).toMatchObject({ status: 'complete', rows: 0 });
    expect((await db.selectFrom('godaddy_auctions').select('ended').executeTakeFirstOrThrow()).ended).toBe(false);
  });

  it('DS522-15 retention: ended auctions are kept 120 days (final_state_at), an open one not seen for 120 days goes too', async () => {
    const a = (domain: string, over: object) => ({ domain, end_time: new Date('2026-01-01T00:00:00Z'), first_seen: '2026-01-01', last_seen: '2026-01-01', last_price_cents: 60000, max_price_cents: 60000, last_bid_count: 1, ...over });
    await db.insertInto('godaddy_auctions').values([
      a('old-ended.com', { ended: true, final_state_at: '2026-06-21' }), a('new-ended.com', { ended: true, final_state_at: '2026-06-22' }),
      a('old-open.com', { last_seen: '2026-06-20' }), a('new-open.com', { last_seen: '2026-10-19' }),
    ]).execute();
    const r = await new DatasaveJob({ db, now: () => clock, snapshotDir: SNAP }).snapshotRetention() as Record<string, unknown>;
    expect(r).toMatchObject({ auctions_cutoff_date: '2026-06-22', auctions_deleted: 2 });
    expect((await db.selectFrom('godaddy_auctions').select('domain').orderBy('domain').execute()).map((x) => x.domain)).toEqual(['new-ended.com', 'new-open.com']);
  });
});
