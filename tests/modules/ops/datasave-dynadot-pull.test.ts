// v5.62.0 (CR-080 item 3): the datasave job reads Dynadot itself (RESTful v2, read-only key, signed) and seals through the bot-upload code. Dynadot is mocked (MSW); fixtures are tiny and synthetic.
import { createHash, createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { DatasaveJob } from '../../../src/modules/ops/jobs/datasave/datasave.js';
import { dynadotSignature } from '../../../src/modules/ops/jobs/datasave/dynadot-pull.js';
import { uploadDynadot } from '../../../src/modules/ops/jobs/datasave/dynadot-upload.js';
import { dynadotMissing } from '../../../src/modules/reporting/datasave-state.js';
import { testDb as db } from '../../helpers/db.js';
import { mswServer } from '../../setup/network.js';

const KEY = 'dyn_fake_key_0123456789abcdef';
const SECRET = 'dyn_fake_secret_fedcba9876543210';
const BASE = 'https://api.dynadot.com';
const LISTINGS = `${BASE}/restful/v2/aftermarket/listings`;
const CO_PATH = '/restful/v2/aftermarket/fake_closeouts';
const CLOSEOUTS = `${BASE}${CO_PATH}`;
const DAY1 = Date.parse('2026-10-27T15:00:30Z');
const DAY = 86_400_000;

type Handler = (page: number) => { status?: number; body?: unknown } | undefined;
function dynadot(handler: Handler, url = LISTINGS) {
  const seen: Array<{ page: number; auth: string | null; sig: string | null; rid: string | null; accept: string | null; pathAndQuery: string; url: string }> = [];
  mswServer.use(http.get(url, ({ request }) => {
    const u = new URL(request.url);
    const page = Number(u.searchParams.get('page'));
    seen.push({ page, auth: request.headers.get('authorization'), sig: request.headers.get('x-signature'), rid: request.headers.get('x-request-id'), accept: request.headers.get('accept'), pathAndQuery: u.pathname + u.search, url: request.url });
    const r = handler(page) ?? { body: {} };
    return HttpResponse.json((r.body ?? {}) as never, { status: r.status ?? 200 });
  }));
  return seen;
}
// the real v2 shape (Gavriel's connector, DOM's live read 27 Oct 2026): domain_name, current_price in CENTS as a string, end_time_stamp in ms
const closeoutItem = (domain: string, priceCents: string, end = 1792000000000) => ({ domain_name: domain, current_price: priceCents, end_time_stamp: end, currency: priceCents });
const ok = (data: unknown) => ({ body: { code: 200, message: 'Success', data } });
const coPage = (...items: unknown[]) => ok({ closeout_item_list: items });
const listing = (domain: string, id: number | string, price: string) => ({ listing_id: id, domain, price, in_bound_links: 0, age: 3, is_pending_sale_locked: 'No', type: 'BIN', registration_date: 1, expiration_date: 2 });
const amPage = (total: number, ...items: unknown[]) => ok({ total, listing_item_list: items });

let clock = DAY1;
const delays: number[] = [];
const logs: unknown[] = [];
const mk = (extra: Record<string, unknown> = {}) => new DatasaveJob({
  db, now: () => clock, snapshotDir: '/nonexistent', dynadotKey: KEY, dynadotSecret: SECRET, dynadotCloseoutsPath: CO_PATH, sleep: async (ms) => { delays.push(ms); },
  log: { warn: (o) => { logs.push(o); }, info: (o) => { logs.push(o); } }, ...extra,
});
const reset = () => { clock = DAY1; delays.length = 0; logs.length = 0; };
afterEach(() => { vi.useRealTimers(); reset(); });
const manifest = (source: string, d: string) => db.selectFrom('snapshot_manifests').selectAll().where('source', '=', source as never).where('data_date', '=', d).where('file_name', '=', 'bot_upload').executeTakeFirst();
const rowsOf = (kind: 'aftermarket' | 'closeouts', d: string) => db.selectFrom('dynadot_rows').selectAll().where('kind', '=', kind).where('data_date', '=', d).orderBy('domain').execute();

describe('DYN Dynadot read by the server', () => {
  it('DYN-1 closeouts: two pages then the empty page; current_price is already cents; sealed with origin server; the same sha256 as a bot upload would give; one call at a time, spaced', async () => {
    reset();
    const seen = dynadot((page) => (page === 1 ? coPage(closeoutItem('Alpha.com', '991'), closeoutItem('beta.com', '125000')) : page === 2 ? coPage(closeoutItem('gamma.com', '1250'), closeoutItem('alpha.com', '991'), closeoutItem('bad_name.com', '300')) : coPage()), CLOSEOUTS);
    const s = await mk().dynadotCloseouts() as Record<string, unknown>;
    expect(s).toMatchObject({ status: 'sealed', origin: 'server', pages_n: 2, rows_n: 3, sealed: true, calls_n: 3, data_date: '2026-10-27', invalid_n: 1, duplicate_n: 0 });
    expect(typeof s.elapsed_ms).toBe('number');
    expect(seen.map((x) => x.page)).toEqual([1, 2, 3]);
    expect(delays).toEqual([5000, 5000]);
    const rows = await rowsOf('closeouts', '2026-10-27');
    expect(rows.map((r) => [r.domain, r.price_cents])).toEqual([['alpha.com', 991], ['beta.com', 125000], ['gamma.com', 1250]]);
    expect(rows[0]!.ends_at?.toISOString()).toBe('2026-10-14T17:46:40.000Z');
    const expected = createHash('sha256').update(JSON.stringify(rows.map((r) => ({ domain: r.domain, price_cents: r.price_cents, ends_at: r.ends_at!.toISOString() })))).digest('hex');
    const m = await manifest('dynadot_closeouts', '2026-10-27');
    expect(m).toMatchObject({ status: 'complete', origin: 'server', rows: 3, sha256: expected });
    expect(m!.sealed_at).not.toBeNull();
    expect(m!.coverage).toMatchObject({ partial: false, pages_ok: [1, 2, 3], pages_failed: [], server: true });
  });

  it('DYN-2 (AT-2) a day sealed by a bot upload is a no-op SNAPSHOT_SEALED: Dynadot is not called, nothing changes', async () => {
    reset();
    await uploadDynadot(db, { kind: 'closeouts', data_date: '2026-10-27', rows: [{ domain: 'bot.com', price_cents: 500 }], final: true }, clock);
    const seen = dynadot(() => coPage(closeoutItem('server.com', '500')), CLOSEOUTS);
    const s = await mk().dynadotCloseouts() as Record<string, unknown>;
    expect(s).toMatchObject({ status: 'SNAPSHOT_SEALED', origin: 'server', sealed: true, calls_n: 0, sealed_origin: 'bot_upload', rows_n: 1 });
    expect(seen).toHaveLength(0);
    expect((await rowsOf('closeouts', '2026-10-27')).map((r) => r.domain)).toEqual(['bot.com']);
    const a = await mk().dynadotAftermarket() as Record<string, unknown>;
    expect(a.status).not.toBe('SNAPSHOT_SEALED'); // another kind is independent
  });

  it('DYN-3 (AT-2) once the server sealed the day, a bot upload gets the existing 409 SNAPSHOT_SEALED and nothing changes; a second server run is a no-op', async () => {
    reset();
    dynadot((page) => (page === 1 ? coPage(closeoutItem('one.com', '700')) : coPage()), CLOSEOUTS);
    await mk().dynadotCloseouts();
    const before = await manifest('dynadot_closeouts', '2026-10-27');
    await expect(uploadDynadot(db, { kind: 'closeouts', data_date: '2026-10-27', rows: [{ domain: 'late.com', price_cents: 1 }], final: true }, clock)).rejects.toMatchObject({ status: 409, code: 'SNAPSHOT_SEALED' });
    const seen = dynadot(() => coPage(closeoutItem('two.com', '700')), CLOSEOUTS);
    expect(await mk().dynadotCloseouts()).toMatchObject({ status: 'SNAPSHOT_SEALED', sealed_origin: 'server', calls_n: 0 });
    expect(seen).toHaveLength(0);
    expect((await manifest('dynadot_closeouts', '2026-10-27'))!.sha256).toBe(before!.sha256);
    expect((await rowsOf('closeouts', '2026-10-27')).map((r) => r.domain)).toEqual(['one.com']);
  });

  it('DYN-4 aftermarket: the pages come from Total, rows under $500 are dropped and counted, the listing total is kept on the manifest for the next day\'s R-8 check', async () => {
    reset();
    const seen = dynadot((page) => (page === 1 ? amPage(4, listing('Aaa.com', 'L1', '799'), listing('low.com', 'L2', '120')) : amPage(4, listing('bbb.com', 'L3', '1,500'), listing('ccc.com', 'L4', '500'))));
    const s = await mk().dynadotAftermarket() as Record<string, unknown>;
    expect(s).toMatchObject({ status: 'sealed', origin: 'server', pages_n: 2, rows_n: 3, sealed: true, calls_n: 2, total_listings: 4, dropped_under_500_n: 1 });
    expect(seen.map((x) => x.page)).toEqual([1, 2]);
    expect((await rowsOf('aftermarket', '2026-10-27')).map((r) => [r.domain, r.listing_id, r.price_cents])).toEqual([['aaa.com', 'L1', 79900], ['bbb.com', 'L3', 150000], ['ccc.com', 'L4', 50000]]);
    expect((await manifest('dynadot_aftermarket', '2026-10-27'))!.coverage).toMatchObject({ total_listings: 4, partial: false, pages_planned: [1, 2], server: true });
  });

  it('DYN-5 (AT-4) the panel collapses (5.73M to 470k): a GAP, no rows, no seal, one call; the freeze needs 2 consecutive small-total days (R-8v2)', async () => {
    reset();
    await db.insertInto('snapshot_manifests').values({ source: 'dynadot_aftermarket', data_date: '2026-10-21', file_name: 'bot_upload', rows: 1, status: 'complete', sealed_at: new Date(clock), origin: 'server', coverage: JSON.stringify({ total_listings: 5_730_000 }) }).execute();
    const seen = dynadot(() => amPage(470_000, listing('x.com', 'L1', '900')));
    const d1 = await mk().dynadotAftermarket() as { status: string; gap: unknown; r8v2: unknown; sealed: boolean; calls_n: number; rows_n: number };
    expect(d1).toMatchObject({ status: 'gap', sealed: false, calls_n: 1, rows_n: 0, gap: { reason: 'total_collapsed', total_listings: 470_000, baseline_total: 5_730_000, small_total: true }, r8v2: { small_total_days: 1, frozen: false } });
    expect(seen).toHaveLength(1);
    expect(await rowsOf('aftermarket', '2026-10-27')).toHaveLength(0);
    expect(await manifest('dynadot_aftermarket', '2026-10-27')).toMatchObject({ status: 'gap', origin: 'server', sealed_at: null, rows: null, rows_total: 470_000, error: 'GAP: total_collapsed' });
    clock += DAY;
    const d2 = await mk().dynadotAftermarket() as { status: string; r8v2: unknown };
    expect(d2).toMatchObject({ status: 'gap', r8v2: { small_total_days: 2, frozen: true } });
    expect((await manifest('dynadot_aftermarket', '2026-10-28'))!.coverage).toMatchObject({ r8v2_frozen: true, small_total_days: 2 });
  });

  it('DYN-6 (AT-4) a normal day between two small days resets the count: one small day alone never freezes; a GAP day stays re-runnable and the same day can later be sealed', async () => {
    reset();
    await db.insertInto('snapshot_manifests').values({ source: 'dynadot_aftermarket', data_date: '2026-10-20', file_name: 'bot_upload', rows: 1, status: 'complete', sealed_at: new Date(clock), origin: 'server', coverage: JSON.stringify({ total_listings: 4 }) }).execute();
    dynadot(() => amPage(0));
    expect(await mk().dynadotAftermarket()).toMatchObject({ status: 'gap', gap: { reason: 'total_zero' }, r8v2: { small_total_days: 1, frozen: false } });
    clock += DAY; // 28th: normal
    dynadot(() => amPage(4, listing('a.com', 'L1', '600'), listing('b.com', 'L2', '700')));
    expect(await mk().dynadotAftermarket()).toMatchObject({ status: 'sealed' });
    clock += DAY; // 29th: small again, but the 28th was sealed
    dynadot(() => amPage(0));
    expect(await mk().dynadotAftermarket()).toMatchObject({ status: 'gap', r8v2: { small_total_days: 1, frozen: false } });
    // the GAP day 27th can still be sealed later (the gap row is open)
    clock = DAY1;
    dynadot((p) => (p === 1 ? amPage(4, listing('c.com', 'L1', '600'), listing('d.com', 'L2', '700')) : amPage(4, listing('e.com', 'L3', '800'), listing('f.com', 'L4', '900'))));
    expect(await mk().dynadotAftermarket()).toMatchObject({ status: 'sealed', rows_n: 4 });
  });

  it('DYN-7 (AT-4) empty deep pages: a GAP (not a small-total day), nothing stored', async () => {
    reset();
    dynadot((page) => (page === 1 ? amPage(6, listing('a.com', 'L1', '900'), listing('b.com', 'L2', '900')) : amPage(6)));
    const s = await mk().dynadotAftermarket() as Record<string, unknown>;
    expect(s).toMatchObject({ status: 'gap', sealed: false, gap: { reason: 'deep_pages_empty', small_total: false }, r8v2: { small_total_days: 0, frozen: false } });
    expect(await rowsOf('aftermarket', '2026-10-27')).toHaveLength(0);
    expect((await manifest('dynadot_aftermarket', '2026-10-27'))!.status).toBe('gap');
  });

  it('DYN-8 closeouts with a missing page: sealed with coverage partial and the failed page named; no invented rows', async () => {
    reset();
    dynadot((page) => (page === 1 ? coPage(closeoutItem('a.com', '500')) : page === 2 ? { status: 503, body: { error: 'busy' } } : page === 3 ? coPage(closeoutItem('c.com', '600')) : coPage()), CLOSEOUTS);
    const s = await mk().dynadotCloseouts() as Record<string, unknown>;
    expect(s).toMatchObject({ status: 'partial', sealed: true, rows_n: 2, pages_n: 2, error: 'ERROR: HTTP 503' });
    expect((await manifest('dynadot_closeouts', '2026-10-27'))!.coverage).toMatchObject({ partial: true, pages_failed: [2], pages_ok: [1, 3, 4] });
    expect((await rowsOf('closeouts', '2026-10-27')).map((r) => r.domain)).toEqual(['a.com', 'c.com']);
  });

  it('DYN-9 errors are ERROR / UNKNOWN with a status, never silent zero rows: HTTP 500, a Dynadot error body, a network failure, an empty list', async () => {
    reset();
    dynadot(() => ({ status: 500, body: {} }), CLOSEOUTS);
    expect(await mk().dynadotCloseouts()).toMatchObject({ status: 'error', code: 'ERROR', http_status: 500, sealed: false, rows_n: 0 });
    expect(await manifest('dynadot_closeouts', '2026-10-27')).toMatchObject({ status: 'error', sealed_at: null, rows: null });
    expect(await rowsOf('closeouts', '2026-10-27')).toHaveLength(0);
    mswServer.resetHandlers();
    dynadot(() => ({ body: { code: 400, message: `bad key=${KEY} secret=${SECRET}` } }));
    const a = await mk().dynadotAftermarket() as Record<string, unknown>;
    expect(a).toMatchObject({ status: 'error', code: 'ERROR', calls_n: 1 });
    expect(JSON.stringify(a)).not.toContain(KEY);
    expect(JSON.stringify(a)).not.toContain(SECRET);
    mswServer.resetHandlers();
    mswServer.use(http.get(LISTINGS, () => HttpResponse.error()));
    expect(await mk().dynadotAftermarket()).toMatchObject({ status: 'error', code: 'UNKNOWN', http_status: null });
    mswServer.resetHandlers();
    dynadot(() => coPage(), CLOSEOUTS);
    expect(await mk().dynadotCloseouts()).toMatchObject({ status: 'error', error: expect.stringContaining('EMPTY_RESULT') });
  });

  it('DYN-10 rate spacing: with the real sleep and fake timers the next call waits the full spacing', async () => {
    reset();
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'], now: DAY1 });
    const seen = dynadot((page) => (page === 1 ? coPage(closeoutItem('a.com', '500')) : coPage()), CLOSEOUTS);
    const job = new DatasaveJob({ db, now: () => Date.now(), snapshotDir: '/nonexistent', dynadotKey: KEY, dynadotSecret: SECRET, dynadotCloseoutsPath: CO_PATH, dynadotSpacingMs: 7000 });
    const p = job.dynadotCloseouts();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 40 && seen.length < 1; i++) await vi.advanceTimersByTimeAsync(1);
    expect(seen).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(6900);
    expect(seen).toHaveLength(1); // still waiting
    await vi.advanceTimersByTimeAsync(200);
    for (let i = 0; i < 40 && seen.length < 2; i++) await vi.advanceTimersByTimeAsync(1);
    expect(seen).toHaveLength(2);
    expect(await p).toMatchObject({ status: 'sealed', calls_n: 2 });
  });

  it('DYN-11 the key is sent only to Dynadot and never appears in logs, summaries or the manifest', async () => {
    reset();
    const seen = dynadot((page) => (page === 1 ? coPage(closeoutItem('a.com', '500')) : { status: 502, body: {} }), CLOSEOUTS);
    const s = await mk().dynadotCloseouts();
    expect(seen[0]!.auth).toBe(`Bearer ${KEY}`);
    expect(seen[0]!.url).not.toContain(KEY);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some((l) => (l as { ok?: boolean }).ok === true)).toBe(true);
    expect(logs.some((l) => (l as { ok?: boolean }).ok === false)).toBe(true);
    expect(JSON.stringify(logs)).not.toContain(KEY);
    expect(JSON.stringify(logs)).not.toContain(SECRET);
    expect(JSON.stringify(s)).not.toContain(KEY);
    expect(JSON.stringify(s)).not.toContain(SECRET);
    expect(JSON.stringify(await db.selectFrom('snapshot_manifests').selectAll().execute())).not.toContain(KEY);
  });

  it('DYN-12 a server-sealed day counts for the health "due" check like a bot upload; without a key the steps stay not_configured', async () => {
    reset();
    dynadot((page) => (page === 1 ? coPage(closeoutItem('a.com', '500')) : coPage()), CLOSEOUTS);
    await mk().dynadotCloseouts();
    expect((await dynadotMissing(db, DAY1 + 3_600_000)).missing).toEqual([]);
    expect((await dynadotMissing(db, DAY1 + DAY + 3_600_000)).missing).toEqual(['dynadot_closeouts']); // next day, 16:00 UTC passed, nothing sealed yet
    const none = new DatasaveJob({ db, now: () => clock, snapshotDir: '/nonexistent' });
    expect(await none.dynadotAftermarket()).toMatchObject({ status: 'not_configured', reason: 'DYNADOT_API_KEY is not set' });
    const noSecret = new DatasaveJob({ db, now: () => clock, snapshotDir: '/nonexistent', dynadotKey: KEY });
    expect(await noSecret.dynadotAftermarket()).toMatchObject({ status: 'not_configured', reason: 'DYNADOT_API_SECRET is not set' });
  });

  it('DYN-13 the signature is base64(HMAC-SHA256(secret, key\\npathAndQuery\\nrequestId\\n)) against a vector computed here; the request carries Bearer, X-Request-ID (uuid v4), Accept and the REST v2 query', async () => {
    reset();
    const key = 'k_fixed'; const secret = 's_fixed'; const rid = '11111111-2222-4333-8444-555555555555';
    const pq = '/restful/v2/aftermarket/listings?page=1&page_size=2&currency=USD';
    const expected = createHmac('sha256', secret).update('k_fixed\n' + pq + '\n' + rid + '\n').digest('base64');
    expect(dynadotSignature(secret, key, pq, rid)).toBe(expected);
    expect(dynadotSignature(secret, key, pq, rid, '{"a":1}')).toBe(createHmac('sha256', secret).update('k_fixed\n' + pq + '\n' + rid + '\n{"a":1}').digest('base64'));
    expect(dynadotSignature(secret, key, pq, rid)).not.toBe(dynadotSignature(secret, key, pq, '11111111-2222-4333-8444-555555555556'));
    const seen = dynadot(() => amPage(1, listing('a.com', 1, '900')));
    await mk().dynadotAftermarket();
    const c = seen[0]!;
    expect(c.pathAndQuery).toBe('/restful/v2/aftermarket/listings?page=1&page_size=1000&currency=USD');
    expect(c.accept).toBe('application/json');
    expect(c.rid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(c.sig).toBe(dynadotSignature(SECRET, KEY, c.pathAndQuery, c.rid!));
  });

  it('DYN-14 closeouts without DYNADOT_CLOSEOUTS_PATH: not_configured "closeouts REST path unknown", no call; the aftermarket step is unaffected', async () => {
    reset();
    const seen = dynadot(() => amPage(1, listing('a.com', 1, '900')));
    const job = new DatasaveJob({ db, now: () => clock, snapshotDir: '/nonexistent', dynadotKey: KEY, dynadotSecret: SECRET, sleep: async () => {} });
    expect(await job.dynadotCloseouts()).toMatchObject({ source: 'dynadot_closeouts', status: 'not_configured', reason: 'closeouts REST path unknown' });
    expect(seen).toHaveLength(0);
    expect(await job.dynadotAftermarket()).toMatchObject({ status: 'sealed' });
  });
});
