// v5.26.0 (CR-072): the datasave step `scorePool` (offline filter + score, stored with the rows) and GET /candidates/closeouts (read only).
// Names come from the engine test seed (two dictionary words each); every outside call is mocked or forbidden (MSW onUnhandledRequest 'error' plus a fetch spy).
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Scorer } from '../../../src/modules/engine/index.js';
import { scorePool } from '../../../src/modules/ops/closeouts/score-pool.js';
import { makeApp, runJobToEnd } from '../../helpers/app.js';
import { insertOwnedDomain, testDb as db } from '../../helpers/db.js';
import { FAST_TRAIN, seedEngineData, type EngineSeed } from '../../helpers/engine-data.js';
import { inventoryHandlers } from '../../helpers/datasave.js';
import { putList } from '../../helpers/screening.js';
import { issueToken } from '../../helpers/tokens.js';
import { mswServer } from '../../setup/network.js';

const NOW = Date.parse('2026-10-20T15:00:30Z');
const DAY = '2026-10-20';
const SHA_GD = 'a'.repeat(64);
const SHA_DY = 'b'.repeat(64);
let app: FastifyInstance | undefined;
let read: Record<string, string>;
afterEach(async () => { vi.restoreAllMocks(); await app?.close(); app = undefined; });

const offlineScorer = () => new Scorer({ db, now: () => NOW, screening: { rdapLookup: async () => { throw new Error('no outside call allowed'); } } as never });
const boot = async () => {
  app = await makeApp({ testRoutes: false, now: () => NOW, engineTrain: { ...FAST_TRAIN }, env: { JOB_TRIGGER_TOKEN: 'job_token_fake_0123456789abcdef0123456789' } });
  read = (await issueToken('read')).auth;
  return { get: (url: string) => app!.inject({ method: 'GET', url, headers: read }) };
};
const train = async (): Promise<EngineSeed> => {
  const seed = await seedEngineData(db);
  const w = (await issueToken('write', 'gavriel')).auth;
  const res = await app!.inject({ method: 'POST', url: '/engine/train', headers: { ...w, 'idempotency-key': randomUUID() }, payload: {} });
  expect(res.statusCode).toBe(202);
  await app!.jobQueue.idle();
  return seed;
};
const seal = (source: 'godaddy_inventory' | 'dynadot_closeouts', day = DAY, sha = source === 'godaddy_inventory' ? SHA_GD : SHA_DY) =>
  db.insertInto('snapshot_manifests').values({ source, data_date: day, file_name: source === 'godaddy_inventory' ? 'closeout_listings.json.zip' : 'bot_upload', status: 'complete', sha256: sha, sealed_at: new Date(NOW), rows: 1 }).execute();
const pool = (names: [string, number][], day = DAY) =>
  db.insertInto('datasave_pool').values(names.map(([domain, price_cents]) => ({ data_date: day, source: 'godaddy_closeouts', domain, price_cents, ends_at: new Date(NOW + 3 * 86_400_000) }))).execute();
const dyn = (names: [string, number][], day = DAY) =>
  db.insertInto('dynadot_rows').values(names.map(([domain, price_cents]) => ({ data_date: day, kind: 'closeouts' as const, domain, price_cents, ends_at: new Date(NOW + 86_400_000) }))).execute();
const poolRow = (domain: string) => db.selectFrom('datasave_pool').selectAll().where('domain', '=', domain).executeTakeFirstOrThrow();

describe('CC526 closeout candidates', () => {
  let seed: EngineSeed;
  const unsold = (i: number) => seed.unsold[i]!;

  it('CC526-1 (AT-1) <= limit rows, score desc, ties by lower price then name, every row .com and <= 4000 cents; a .net row and a $41 row are not in the pool', async () => {
    const { get } = await boot();
    seed = await train();
    await pool([[unsold(0), 1000], [unsold(1), 500], [unsold(2), 900], [unsold(3), 4000], [unsold(4), 700], [unsold(5), 1200], ['septicdrone.net', 100]]);
    await db.insertInto('datasave_pool').values({ data_date: DAY, source: 'godaddy_closeouts', domain: unsold(6), price_cents: 4100, ends_at: new Date(NOW + 86_400_000) }).execute();
    await seal('godaddy_inventory');
    const s = await scorePool({ db, now: () => NOW, scorer: offlineScorer() });
    expect(s).toMatchObject({ status: 'ok', rows_processed_n: 8 });
    const res = await get(`/candidates/closeouts?date=${DAY}&limit=3`);
    expect(res.statusCode, res.body).toBe(200);
    const b = res.json();
    expect(b.rows).toHaveLength(3);
    expect(b.rows.map((r: { rank: number }) => r.rank)).toEqual([1, 2, 3]);
    for (const r of b.rows) {
      expect(r.domain.endsWith('.com')).toBe(true);
      expect(r.price_cents).toBeLessThanOrEqual(4000);
      expect(r.filters_passed).toBe(true);
      expect(r.source).toBe('godaddy');
      expect(Array.isArray(r.words)).toBe(true);
      expect(r.words.join('')).toBe(r.domain.slice(0, -4));
    }
    const scores = b.rows.map((r: { score: number }) => r.score);
    expect([...scores].sort((x: number, y: number) => y - x)).toEqual(scores);
    const all = (await get(`/candidates/closeouts?date=${DAY}&limit=200`)).json();
    expect(all.rows.map((r: { domain: string }) => r.domain)).not.toContain('septicdrone.net');
    expect(all.rows.map((r: { domain: string }) => r.domain)).not.toContain(unsold(6));
    // ties: equal score -> lower price, then name
    for (let i = 1; i < all.rows.length; i++) {
      const [p, q] = [all.rows[i - 1], all.rows[i]];
      expect(p.score).toBeGreaterThanOrEqual(q.score);
      if (p.score === q.score) expect(p.price_cents < q.price_cents || (p.price_cents === q.price_cents && p.domain < q.domain)).toBe(true);
    }
  });

  it('CC526-2 (AT-2) a name on bigco_names is absent and counted in filtered_by.BIGCO-1; brand list, tm_kills and forbidden terms get their own codes', async () => {
    const { get } = await boot();
    seed = await train();
    const [a, b, c, d, ok] = [unsold(0), unsold(1), unsold(2), unsold(3), unsold(4)];
    const sld = (x: string) => x.slice(0, -4);
    await db.insertInto('bigco_names').values({ name: sld(a), by: 'test' }).execute();
    await db.insertInto('tm_kills').values({ term: sld(b), by: 'test' }).execute();
    await db.insertInto('forbidden_terms').values({ term: sld(c), created_by: 'test' }).execute();
    await putList('brand', [sld(d)]);
    await pool([[a, 500], [b, 500], [c, 500], [d, 500], [ok, 500]]);
    await seal('godaddy_inventory');
    await scorePool({ db, now: () => NOW, scorer: offlineScorer() });
    const r = (await get(`/candidates/closeouts?date=${DAY}&source=godaddy`)).json();
    expect(r.rows.map((x: { domain: string }) => x.domain)).toEqual([ok]);
    expect(r.summary).toMatchObject({ pool_n: 5, ranked_n: 1, returned_n: 1 });
    expect(r.summary.filtered_by).toMatchObject({ 'BIGCO-1': 1, TM_KILL: 1, FORBIDDEN_TERM: 1, 'BRAND-1': 1 });
    expect((await poolRow(a)).filter_code).toBe('BIGCO-1');
  });

  it('CC526-3 (AT-3) no sealed snapshot for the day (or for that source) is 409 SNAPSHOT_MISSING, never an empty list', async () => {
    const { get } = await boot();
    seed = await train();
    let res = await get(`/candidates/closeouts?date=${DAY}`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SNAPSHOT_MISSING');
    res = await get('/candidates/closeouts');
    expect(res.statusCode).toBe(409);
    await pool([[unsold(0), 500]]);
    await seal('godaddy_inventory');
    expect((await get(`/candidates/closeouts?date=${DAY}&source=dynadot`)).json().error.code).toBe('SNAPSHOT_MISSING');
    expect((await get(`/candidates/closeouts?date=2026-10-19&source=godaddy`)).statusCode).toBe(409);
    expect((await get('/candidates/closeouts?source=drops')).json().error.code).toBe('SNAPSHOT_MISSING');
    // the default date is the newest sealed day
    expect((await get('/candidates/closeouts?source=godaddy')).json().date).toBe(DAY);
  });

  it('CC526-4 (AT-4) limit 500 is 400 VALIDATION_ERROR; limit 0, max_price over the pool cap and unknown keys too; 200 is the top', async () => {
    const { get } = await boot();
    for (const q of ['limit=500', 'limit=0', 'max_price=40.01', 'max_price=0', 'max_price=10.505', 'max_price=4000', 'source=bogus', 'foo=1', 'date=2026-02-30']) {
      const res = await get(`/candidates/closeouts?${q}`);
      expect(res.statusCode, q).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    }
    expect((await get('/candidates/closeouts?limit=200')).statusCode).toBe(409); // valid query, no snapshot
  });

  it('CC526-5 (AT-5) a Dynadot price of 1088 cents is shown as "$10.88"; a sealed upload is needed', async () => {
    const { get } = await boot();
    seed = await train();
    await dyn([[unsold(0), 1088]]);
    expect((await get(`/candidates/closeouts?date=${DAY}&source=dynadot`)).statusCode).toBe(409); // not sealed yet
    await seal('dynadot_closeouts');
    await scorePool({ db, now: () => NOW, scorer: offlineScorer() });
    const r = (await get(`/candidates/closeouts?date=${DAY}&source=dynadot`)).json();
    expect(r.rows[0]).toMatchObject({ domain: unsold(0), source: 'dynadot', price_cents: 1088, price: '$10.88' });
    expect(r.rows[0].score).toBeGreaterThan(0);
    expect(r.summary.snapshot_sha256).toBe(SHA_DY);
  });

  it('CC526-6 (AT-6) pool_n - sum(filtered_by) = ranked_n for godaddy, dynadot and all; snapshot_sha256 equals GET /snapshots (a map for all)', async () => {
    const { get } = await boot();
    seed = await train();
    await pool([[unsold(0), 500], [unsold(1), 600], ['ab12cd.com', 600], [unsold(2), 3000]]);
    await dyn([[unsold(3), 400], ['x-y.com', 400]]);
    await insertOwnedDomain(db, { domain: unsold(1) });
    await seal('godaddy_inventory');
    await seal('dynadot_closeouts');
    await scorePool({ db, now: () => NOW, scorer: offlineScorer() });
    const snaps = (await get(`/snapshots?date=${DAY}`)).json().snapshots as { source: string; sha256: string }[];
    const shaOf = (s: string) => snaps.find((x) => x.source === s)!.sha256;
    for (const source of ['godaddy', 'dynadot', 'all']) {
      const r = (await get(`/candidates/closeouts?date=${DAY}&source=${source}&limit=200`)).json();
      const sum = Object.values(r.summary.filtered_by as Record<string, number>).reduce((a, n) => a + n, 0);
      expect(r.summary.pool_n - sum, source).toBe(r.summary.ranked_n);
      expect(r.summary.returned_n).toBe(r.rows.length);
      if (source === 'godaddy') { expect(r.summary).toMatchObject({ pool_n: 4, ranked_n: 2 }); expect(r.summary.snapshot_sha256).toBe(shaOf('godaddy_inventory')); }
      if (source === 'dynadot') { expect(r.summary).toMatchObject({ pool_n: 2, ranked_n: 1 }); expect(r.summary.snapshot_sha256).toBe(shaOf('dynadot_closeouts')); }
      if (source === 'all') expect(r.summary).toMatchObject({ pool_n: 6, ranked_n: 3, snapshot_sha256: { godaddy: shaOf('godaddy_inventory'), dynadot: shaOf('dynadot_closeouts') } });
    }
    // max_price narrows the pool (the $30 row leaves it) and keeps the invariant
    const narrow = (await get(`/candidates/closeouts?date=${DAY}&source=godaddy&max_price=10`)).json();
    expect(narrow.summary.pool_n).toBe(3);
    expect(narrow.summary.pool_n - Object.values(narrow.summary.filtered_by as Record<string, number>).reduce((a, n) => a + n, 0)).toBe(narrow.summary.ranked_n);
  });

  it('CC526-7 (AT-7) there is no POST: a bots token gets 403 on POST /candidates/closeouts (no such route; unknown POSTs fail closed), a WRITE token 404, and GET is open to bots and READ tokens', async () => {
    const { get } = await boot();
    const bots = await issueToken('bots');
    const res = await app!.inject({ method: 'POST', url: '/candidates/closeouts', headers: { ...bots.auth, 'idempotency-key': randomUUID() }, payload: {} });
    expect(res.statusCode).toBe(403);
    const w = await issueToken('write');
    expect((await app!.inject({ method: 'POST', url: '/candidates/closeouts', headers: { ...w.auth, 'idempotency-key': randomUUID() }, payload: {} })).statusCode).toBe(404);
    expect((await app!.inject({ method: 'GET', url: '/candidates/closeouts', headers: bots.auth })).statusCode).toBe(409);
    expect((await get('/candidates/closeouts')).statusCode).toBe(409);
    expect((await app!.inject({ method: 'GET', url: '/candidates/closeouts' })).statusCode).toBe(401);
  });

  it('CC526-8 the step stores the first failed filter and the score; the order is SPELL-1, BRAND-1, BIGCO-1, TM_KILL, FORBIDDEN_TERM, DIGITS_OR_HYPHEN, OWNED, SALES_GRADED', async () => {
    await boot();
    seed = await train();
    const sld = (x: string) => x.slice(0, -4);
    const [owned, graded, both, ok] = [unsold(0), seed.sold[0]!.domain, unsold(1), unsold(2)];
    await insertOwnedDomain(db, { domain: owned });
    await insertOwnedDomain(db, { domain: both });
    await db.insertInto('engine_sales').values({ domain: both, price_cents: 100000, sale_date: '2026-01-01', venue: 'v', source: 's', source_url: null, upload_id: (await db.selectFrom('engine_uploads').select('id').executeTakeFirstOrThrow()).id }).execute();
    await db.insertInto('forbidden_terms').values({ term: sld(both), created_by: 'test' }).execute();
    await pool([[owned, 500], [graded, 500], [both, 500], [ok, 500], ['abc-def.com', 500], ['abc123.com', 500]]);
    await scorePool({ db, now: () => NOW, scorer: offlineScorer() });
    expect((await poolRow(owned)).filter_code).toBe('OWNED');
    expect((await poolRow(graded)).filter_code).toBe('SALES_GRADED');
    expect((await poolRow(both)).filter_code).toBe('FORBIDDEN_TERM'); // owned AND graded AND forbidden: the earlier code wins
    expect((await poolRow('abc-def.com')).filter_code).toBe('SPELL-1');
    expect((await poolRow('abc123.com')).filter_code).toBe('SPELL-1');
    const row = await poolRow(ok);
    expect(row.filter_code).toBeNull();
    expect(Number(row.score)).toBeGreaterThan(0);
    expect(row.score_reason).toBeNull();
    expect(row.scored_at).not.toBeNull();
    expect(row.model_version).not.toBeNull();
    const again = await scorePool({ db, now: () => NOW, scorer: offlineScorer() });
    expect(again.rows_processed_n).toBe(0); // processed rows are not touched twice
  });

  it('CC526-9 scoring makes NO outside call: no fetch, no registry ask, engine_endings unchanged (MSW would fail the test on any request)', async () => {
    await boot();
    seed = await train();
    await pool(seed.unsold.slice(0, 30).map((d) => [d, 500] as [string, number]));
    const before = (await db.selectFrom('engine_endings').select('id').execute()).length;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const rdap = vi.fn(async () => { throw new Error('registry ask'); });
    const scorer = new Scorer({ db, now: () => NOW, screening: { rdapLookup: rdap, fetch: fetchSpy as never } as never });
    const s = await scorePool({ db, now: () => NOW, scorer });
    expect(s.rows_scored_n).toBe(30);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(rdap).not.toHaveBeenCalled();
    expect((await db.selectFrom('engine_endings').select('id').execute()).length).toBe(before);
    // the same input gives the same scores
    const first = (await db.selectFrom('datasave_pool').select(['domain', 'score']).orderBy('domain').execute());
    await db.updateTable('datasave_pool').set({ scored_at: null, score: null }).execute();
    await scorePool({ db, now: () => NOW, scorer });
    expect(await db.selectFrom('datasave_pool').select(['domain', 'score']).orderBy('domain').execute()).toEqual(first);
  });

  it('CC526-10 no active model: filtered rows keep their code, the others score null with reason NO_ACTIVE_MODEL and are still listed, after the scored ones; a later model scores them', async () => {
    const { get } = await boot();
    await pool([['ab12cd.com', 500], ['septicdrone.com', 500], ['plumbingpros.com', 700]]);
    await seal('godaddy_inventory');
    const s = await scorePool({ db, now: () => NOW, scorer: offlineScorer() });
    expect(s).toMatchObject({ status: 'no_model', model_version: null, rows_scored_n: 0 });
    let r = (await get(`/candidates/closeouts?date=${DAY}`)).json();
    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows) expect(row).toMatchObject({ score: null, score_reason: 'NO_ACTIVE_MODEL' });
    expect(r.summary.filtered_by['SPELL-1']).toBe(1);
    // an unprocessed row (the step has not run for it) is listed after every scored row, with NOT_SCORED_YET
    seed = await train();
    await scorePool({ db, now: () => NOW, scorer: offlineScorer() });
    await db.insertInto('datasave_pool').values({ data_date: DAY, source: 'godaddy_closeouts', domain: unsold(0), price_cents: 100, ends_at: new Date(NOW + 86_400_000) }).execute();
    await db.insertInto('datasave_pool').values({ data_date: DAY, source: 'godaddy_closeouts', domain: unsold(1), price_cents: 1500, ends_at: new Date(NOW + 86_400_000) }).execute();
    await scorePool({ db, now: () => NOW, scorer: offlineScorer() });
    await db.updateTable('datasave_pool').set({ scored_at: null, score: null, score_reason: null, filter_code: null }).where('domain', '=', unsold(0)).execute();
    r = (await get(`/candidates/closeouts?date=${DAY}&limit=200`)).json();
    const flags = r.rows.map((x: { score: number | null }) => x.score === null);
    expect(flags).toContain(false);
    expect(flags.lastIndexOf(false)).toBeLessThan(flags.indexOf(true));
    expect(r.rows.find((x: { domain: string }) => x.domain === unsold(0)).score_reason).toBe('NOT_SCORED_YET');
    // the rows that were NO_ACTIVE_MODEL are scored now
    expect(await db.selectFrom('datasave_pool').select('domain').where('score_reason', '=', 'NO_ACTIVE_MODEL').execute()).toHaveLength(0);
  });

  it('CC526-11 Dynadot closeouts are scored on a later run, once the upload is sealed', async () => {
    await boot();
    seed = await train();
    await dyn([[unsold(0), 400], [unsold(1), 500]]);
    let s = await scorePool({ db, now: () => NOW, scorer: offlineScorer() });
    expect(s.by_source.dynadot).toEqual({ days: [], rows_processed_n: 0 });
    expect((await db.selectFrom('dynadot_rows').select('scored_at').execute()).every((r) => r.scored_at === null)).toBe(true);
    await seal('dynadot_closeouts');
    s = await scorePool({ db, now: () => NOW + 3_600_000, scorer: offlineScorer() });
    expect(s.by_source.dynadot).toEqual({ days: [DAY], rows_processed_n: 2 });
    const rows = await db.selectFrom('dynadot_rows').select(['score', 'filter_code', 'scored_at', 'model_version']).execute();
    expect(rows).toHaveLength(2);
    for (const r of rows) { expect(Number(r.score)).toBeGreaterThan(0); expect(r.filter_code).toBeNull(); expect(r.scored_at).not.toBeNull(); expect(r.model_version).not.toBeNull(); }
  });

  it('CC526-12 source=drops: the kept drop-list names of the date, filtered and scored at read time; no price; the invariant holds', async () => {
    const { get } = await boot();
    seed = await train();
    await db.insertInto('drop_lists').values({ name: 'dl1', list_date: DAY, created_by: 'test', received_n: 4, kept_n: 3 }).execute();
    await db.insertInto('drop_list_rows').values([
      { list_name: 'dl1', domain: unsold(0), kept: true }, { list_name: 'dl1', domain: unsold(1), kept: true }, { list_name: 'dl1', domain: 'ab12cd.com', kept: true }, { list_name: 'dl1', domain: unsold(2), kept: false },
    ]).execute();
    const r = (await get(`/candidates/closeouts?date=${DAY}&source=drops`)).json();
    expect(r.rows).toHaveLength(2);
    expect(r.rows.map((x: { domain: string }) => x.domain).sort()).toEqual([unsold(0), unsold(1)].sort());
    for (const row of r.rows) expect(row).toMatchObject({ source: 'drops', price_cents: null, price: null, ends_at: null, filters_passed: true });
    expect(r.rows[0].score).toBeGreaterThanOrEqual(r.rows[1].score);
    expect(r.summary).toMatchObject({ pool_n: 3, ranked_n: 2, returned_n: 2, snapshot_sha256: null });
    expect(r.summary.filtered_by['SPELL-1']).toBe(1);
    expect((await get('/candidates/closeouts?source=drops')).json().date).toBe(DAY); // default: the newest list with kept names
    expect((await get('/candidates/closeouts?source=drops&date=2026-10-01')).statusCode).toBe(409);
  });

  it('CC526-14 a scoring failure is score null with SCORE_FAILED (never 0), the filter code is kept, and the next run tries again', async () => {
    const { get } = await boot();
    seed = await train();
    await pool([[unsold(0), 500], [unsold(1), 600], ['ab12cd.com', 600]]);
    await seal('godaddy_inventory');
    const real = offlineScorer();
    const broken = { activeModel: () => real.activeModel(), scoreOffline: async () => { throw new Error('boom'); } };
    const s = await scorePool({ db, now: () => NOW, scorer: broken, log: { warn: () => {} } });
    expect(s).toMatchObject({ status: 'ok', rows_scored_n: 0, rows_filtered_n: 1 });
    expect((await poolRow('ab12cd.com')).filter_code).toBe('SPELL-1');
    expect(await poolRow(unsold(0))).toMatchObject({ score: null, score_reason: 'SCORE_FAILED', scored_at: null });
    const r = (await get(`/candidates/closeouts?date=${DAY}`)).json();
    expect(r.rows).toHaveLength(2);
    for (const row of r.rows) expect(row).toMatchObject({ score: null, score_reason: 'SCORE_FAILED' });
    // a model name the scorer returns no number for is processed with the same reason
    const silent = { activeModel: () => real.activeModel(), scoreOffline: async () => ({ model_version: 'x', scores: new Map<string, number>() }) };
    await scorePool({ db, now: () => NOW, scorer: silent });
    expect(await poolRow(unsold(1))).toMatchObject({ score: null, score_reason: 'SCORE_FAILED' });
    expect((await poolRow(unsold(1))).scored_at).not.toBeNull();
  });

  it('CC526-13 the datasave job has the scorePool step right after godaddyInventory (the Dynadot steps run last since 5.65.0) and it reports', async () => {
    await boot();
    seed = await train();
    mswServer.use(...inventoryHandlers());
    await pool([[unsold(0), 500]], '2026-10-19');
    const run = await runJobToEnd(app!, 'datasave');
    const steps = run.json().steps as Record<string, { status?: string; result?: Record<string, unknown> }>;
    const names = Object.keys(steps);
    expect(names.indexOf('scorePool')).toBe(names.indexOf('godaddyInventory') + 1);
    expect(names.slice(-2)).toEqual(['dynadotCloseouts', 'dynadotAftermarket']);
    expect(steps.scorePool).toBeDefined();
    expect((await poolRow(unsold(0))).scored_at).not.toBeNull();
  });
});
