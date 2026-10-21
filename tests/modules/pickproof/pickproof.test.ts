// v5.28.0 (CR-073): pick-proof mechanics. The pool is the sealed CR-071 save of the evening before; picks (arm A), the seal, the drawn arms (B1, B2, C1),
// T30 labels (RDAP mocked with MSW) and the report. Every outside call is mocked; the only network the code could make is Verisign RDAP, answered by MSW.
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { http, HttpResponse } from 'msw';
import { pickproofLabels } from '../../../src/modules/pickproof/index.js';
import { makeApp, runJobToEnd } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { inventoryHandlers } from '../../helpers/datasave.js';
import { issueToken } from '../../helpers/tokens.js';
import { mswServer } from '../../setup/network.js';

const D = '2026-12-21'; // pick day
const DD = '2026-12-20'; // data date of the pool
const at = (iso: string) => Date.parse(iso);
let clock = at(`${D}T10:00:00Z`);
let app: FastifyInstance | undefined;
let n = 0;
afterEach(async () => { await app?.close(); app = undefined; });

const WORDS = ['sun', 'red', 'big', 'top', 'fun', 'hot', 'sea', 'box', 'pet', 'car', 'bus', 'map'];
const twoWord = WORDS.flatMap((a) => WORDS.filter((b) => b !== a).map((b) => `${a}${b}.com`)); // 132 names, 6 letters
const filler = (i: number) => `${'qxzv'[i % 4]}${'bcdfghjk'[Math.floor(i / 4) % 8]}${'lmnprstw'[Math.floor(i / 32) % 8]}${'xzqv'[Math.floor(i / 256) % 4]}kw.com`;
const fillers = Array.from({ length: 120 }, (_, i) => filler(i));

const boot = async (iso = `${D}T10:00:00Z`) => {
  clock = at(iso);
  app = await makeApp({ testRoutes: false, now: () => clock, env: { JOB_TRIGGER_TOKEN: 'job_token_fake_0123456789abcdef0123456789' } });
  const bots = await issueToken('bots');
  const read = await issueToken('read');
  const write = await issueToken('write');
  const data = await issueToken('data');
  const get = (url: string, auth = read.auth) => app!.inject({ method: 'GET', url, headers: auth });
  const picks = (names: string[], day = D, auth = bots.auth) => app!.inject({ method: 'POST', url: `/pickproof/${day}/picks`, headers: { ...auth, 'idempotency-key': `pp-${++n}` }, payload: { names } });
  return { bots, read, write, data, get, picks };
};

/** A sealed GoDaddy snapshot of the data date with these rows: [domain, price_cents, passesK1]. */
const snapshot = async (rows: Array<[string, number, boolean?]>, dataDate = DD) => {
  await db.insertInto('snapshot_manifests').values({ source: 'godaddy_inventory', data_date: dataDate, file_name: 'closeout_listings.json.zip', status: 'complete', sha256: 'a'.repeat(64), sealed_at: new Date(), rows: rows.length }).execute();
  await db.insertInto('datasave_pool').values(rows.map(([domain, price_cents, k1]) => ({
    data_date: dataDate, source: 'godaddy_closeouts', domain, price_cents, ends_at: new Date(at(`${dataDate}T20:00:00Z`)),
    filter_code: k1 === false ? 'SPELL-1' : null, scored_at: new Date(),
  }))).execute();
};
const standardPool = () => snapshot([...twoWord.map((d) => [d, 500 + (d.length % 7) * 400, true] as [string, number, boolean]), ...fillers.map((d) => [d, 900, false] as [string, number, boolean])]);
const afterDeadline = () => { clock = at(`${D}T16:30:00Z`); };
const names = (r: { json: () => any }, arm: string) => (r.json().arms ? r.json().arms[arm] : r.json()).names.map((x: { domain: string }) => x.domain) as string[]; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('PP528 pick-proof: pool, picks, seal, arms', () => {
  it('PP528-10 (AT-1) the manifest is the same on a second call: seed, arm hashes, draws; before the deadline A is open and nothing is sealed', async () => {
    const { get, picks } = await boot();
    await standardPool();
    const early = await get(`/pickproof/${D}/manifest`);
    expect(early.statusCode, early.body).toBe(200);
    expect(early.json()).toMatchObject({ date: D, data_date: DD, sealed: false, sealed_at: null, k: 100, arms: { A: { status: 'open', n: 0, sealed: false }, B1: { status: 'pending_seal' }, C2: { status: 'not_built' } } });
    expect((await picks(twoWord.slice(0, 40))).statusCode).toBe(200);
    afterDeadline();
    const one = await get(`/pickproof/${D}/manifest`);
    const two = await get(`/pickproof/${D}/manifest`);
    expect(one.statusCode, one.body).toBe(200);
    expect(two.json()).toEqual(one.json());
    const m = one.json();
    expect(m).toMatchObject({ sealed: true, pool_n: twoWord.length + fillers.length, k: 100, arms: { A: { n: 40, sealed: true }, B1: { n: 100, short: false }, B2: { n: 100 }, C1: { n: 100 }, C2: { status: 'not_built' } } });
    expect(m.pool_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.seed).toBe(parseInt(m.pool_sha256.slice(0, 8), 16));
    expect(m.recipe.draw).toMatch(/^[0-9a-f]{64}$/);
    expect(m.recipe.pool_rule).toMatch(/^[0-9a-f]{64}$/);
    expect(m.recipe.labels_rule).toMatch(/^[0-9a-f]{64}$/);
    const a1 = await get(`/pickproof/${D}/arms`);
    const a2 = await get(`/pickproof/${D}/arms`);
    expect(a1.statusCode, a1.body).toBe(200);
    expect(a2.json()).toEqual(a1.json());
    expect(a1.json().arms.C2).toEqual({ status: 'not_built' });
    // the stored hash is the hash of the shown names
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(JSON.stringify(names(a1, 'B1'))).digest('hex')).toBe(m.arms.B1.sha256);
  });

  it('PP528-11 (AT-2) B1 is 100 distinct names, all from the pool; B2 only K1-passing names; C1 only two-word names of at most 10 letters', async () => {
    const { get } = await boot();
    await standardPool();
    afterDeadline();
    await get(`/pickproof/${D}/manifest`);
    const pool = await db.selectFrom('pickproof_pool').selectAll().where('day', '=', D).execute();
    const byName = new Map(pool.map((r) => [r.domain, r]));
    const one = async (arm: string) => names(await get(`/pickproof/${D}/arms?arm=${arm}`), arm);
    const b1 = await one('B1'), b2 = await one('B2'), c1 = await one('C1');
    expect(b1).toHaveLength(100);
    expect(new Set(b1).size).toBe(100);
    expect(b1.every((x) => byName.has(x))).toBe(true);
    expect(b2).toHaveLength(100);
    expect(b2.every((x) => byName.get(x)!.passes_k1)).toBe(true);
    expect(c1).toHaveLength(100);
    expect(c1.every((x) => byName.get(x)!.is_two_word && /^[a-z]{2,10}\.com$/.test(x))).toBe(true);
    expect(b1.some((x) => fillers.includes(x))).toBe(true); // the random arm is not just the good names
    expect(fillers.every((f) => !byName.get(f)!.passes_k1 && !byName.get(f)!.is_two_word)).toBe(true);
    // the arms differ from one another (own derived seeds)
    expect(b1.join()).not.toBe(b2.join());
  });

  it('PP528-12 (AT-3) a sealed day refuses picks (409 PICKPROOF_SEALED); so does a day past its deadline that nobody sealed yet', async () => {
    const { get, picks } = await boot();
    await standardPool();
    expect((await picks(twoWord.slice(0, 5))).statusCode).toBe(200);
    afterDeadline();
    const late = await picks(twoWord.slice(0, 5));
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('PICKPROOF_SEALED');
    expect((await get(`/pickproof/${D}/manifest`)).json().sealed).toBe(true);
    const r = await picks(twoWord.slice(0, 5));
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('PICKPROOF_SEALED');
    expect((await db.selectFrom('pickproof_arms').select('domain').where('arm', '=', 'A').where('day', '=', D).execute())).toHaveLength(5);
  });

  it('PP528-13 (AT-4) a name outside the pool is 422 NOT_IN_POOL listing it and stores nothing; a replace before the deadline works', async () => {
    const { picks } = await boot();
    await standardPool();
    const r = await picks([twoWord[0]!, 'notinthepool.com', 'sunnet.net']);
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toMatchObject({ code: 'NOT_IN_POOL', details: { names: ['notinthepool.com', 'sunnet.net'] } });
    expect(await db.selectFrom('pickproof_arms').select('domain').execute()).toHaveLength(0);
    expect((await picks([twoWord[0]!, twoWord[1]!])).json()).toMatchObject({ n: 2, arm: 'A' });
    const again = await picks([twoWord[2]!.toUpperCase()]);
    expect(again.json().n).toBe(1);
    expect((await db.selectFrom('pickproof_arms').select('domain').where('arm', '=', 'A').execute()).map((x) => x.domain)).toEqual([twoWord[2]]);
    const hist = await db.selectFrom('pickproof_picks_history').select(['n', 'by']).orderBy('id').execute();
    expect(hist.map((h) => h.n)).toEqual([2, 1]);
    // too many names, a duplicate, an empty list
    expect((await picks([twoWord[0]!, twoWord[0]!])).statusCode).toBe(422);
    expect((await picks(twoWord.slice(0, 101))).statusCode).toBe(422);
    expect((await picks([])).statusCode).toBe(422);
  });

  it('PP528-14 no sealed snapshot of the evening before: 409 SNAPSHOT_MISSING on picks and manifest, nothing stored', async () => {
    const { get, picks } = await boot();
    const r = await picks([twoWord[0]!]);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatchObject({ code: 'SNAPSHOT_MISSING', details: { date: D, data_date: DD } });
    expect((await get(`/pickproof/${D}/manifest`)).json().error.code).toBe('SNAPSHOT_MISSING');
    // a snapshot that is not sealed does not count
    await db.insertInto('snapshot_manifests').values({ source: 'godaddy_inventory', data_date: DD, file_name: 'closeout_listings.json.zip', status: 'partial', sha256: null, sealed_at: null, rows: null }).execute();
    expect((await get(`/pickproof/${D}/manifest`)).json().error.code).toBe('SNAPSHOT_MISSING');
    expect(await db.selectFrom('pickproof_days').select('day').execute()).toHaveLength(0);
  });

  it('PP528-15 the pool is frozen: later changes or pruning of the datasave rows change neither the sha, the pool nor the draws', async () => {
    const { get, picks } = await boot();
    await standardPool();
    expect((await picks([twoWord[0]!])).statusCode).toBe(200);
    const sha = (await db.selectFrom('pickproof_days').select('pool_sha256').executeTakeFirstOrThrow()).pool_sha256;
    await db.deleteFrom('datasave_pool').execute(); // pruned
    await db.insertInto('datasave_pool').values({ data_date: DD, source: 'godaddy_closeouts', domain: 'laterarrival.com', price_cents: 100, ends_at: new Date() }).execute();
    afterDeadline();
    const m = (await get(`/pickproof/${D}/manifest`)).json();
    expect(m.pool_sha256).toBe(sha);
    expect(m.pool_n).toBe(twoWord.length + fillers.length);
    expect(m.arms.B1.n).toBe(100);
    expect((await picks(['laterarrival.com'])).json().error.code).toBe('PICKPROOF_SEALED');
  });

  it('PP528-16 the arms are not shown before the seal, not even after the deadline until the manifest was called', async () => {
    const { get } = await boot();
    await standardPool();
    const early = await get(`/pickproof/${D}/arms?arm=B1`);
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe('PICKPROOF_NOT_SEALED');
    afterDeadline();
    expect((await get(`/pickproof/${D}/arms`)).json().error.code).toBe('PICKPROOF_NOT_SEALED');
    await get(`/pickproof/${D}/manifest`);
    expect((await get(`/pickproof/${D}/arms?arm=B1`)).statusCode).toBe(200);
    expect((await get(`/pickproof/${D}/arms?arm=C2`)).json()).toMatchObject({ arm: 'C2', status: 'not_built' });
    expect((await get(`/pickproof/${D}/arms?arm=Z9`)).statusCode).toBe(400);
  });

  it('PP528-17 pool rules: over $40, non-.com, sales-graded and Dynadot rows of an unsealed upload are out; duplicates keep the lowest price; K1 and two-word flags are stored', async () => {
    const { get } = await boot();
    const gradedName = 'sunbox.com';
    await snapshot([['sunmap.com', 1000, true], ['sunbus.com', 4000, true], ['redcar.com', 4001, true], ['redbox.net', 100, true], [gradedName, 500, true], ['qzxvkw.com', 700, false], ['bigtopfunhot.com', 800, true]]);
    const upId = (await db.insertInto('engine_uploads').values({ kind: 'sales', received_n: 1, accepted_n: 1, duplicate_n: 0, rejected_n: 0, rejects: '[]', by: 'test', audit_id: null }).returning('id').executeTakeFirstOrThrow()).id;
    await db.insertInto('engine_sales').values({ domain: gradedName, price_cents: 100000, sale_date: '2026-01-01', venue: 'v', source: 's', source_url: null, upload_id: upId }).execute();
    // Dynadot: sealed upload with one cheaper duplicate and one new name
    await db.insertInto('snapshot_manifests').values({ source: 'dynadot_closeouts', data_date: DD, file_name: 'bot_upload', status: 'complete', sha256: 'd'.repeat(64), sealed_at: new Date(), rows: 2, origin: 'bot_upload' }).execute();
    await db.insertInto('dynadot_rows').values([
      { data_date: DD, kind: 'closeouts', domain: 'sunmap.com', price_cents: 600, filter_code: null, scored_at: new Date() },
      { data_date: DD, kind: 'closeouts', domain: 'seabox.com', price_cents: 300, filter_code: null, scored_at: new Date() },
    ]).execute();
    afterDeadline();
    const m = (await get(`/pickproof/${D}/manifest`)).json();
    const pool = await db.selectFrom('pickproof_pool').selectAll().where('day', '=', D).orderBy('domain').execute();
    expect(pool.map((r) => r.domain)).toEqual(['bigtopfunhot.com', 'qzxvkw.com', 'seabox.com', 'sunbus.com', 'sunmap.com']);
    expect(pool.find((r) => r.domain === 'sunmap.com')).toMatchObject({ price_cents: 600, source: 'dynadot', passes_k1: true, is_two_word: true });
    expect(pool.find((r) => r.domain === 'qzxvkw.com')).toMatchObject({ passes_k1: false, is_two_word: false });
    expect(pool.find((r) => r.domain === 'bigtopfunhot.com')).toMatchObject({ passes_k1: true, is_two_word: false }); // 12 letters, 4 words
    expect(m.sources).toMatchObject({ godaddy: { rows: 3 }, dynadot: { status: 'sealed', rows: 2 } });
    expect(m.arms.B1).toMatchObject({ n: 5, short: true }); // fewer than k: all of them, short
    expect(m.arms.C1.short).toBe(true);
  });

  it('PP528-18 k is raise-only (a lower value is refused by the database, never above 300) and a raised k applies to the next day', async () => {
    await expect(sql`update settings set pickproof_k = 50`.execute(db)).rejects.toThrow(/can only be raised/);
    await expect(sql`update settings set pickproof_k = 301`.execute(db)).rejects.toThrow();
    await sql`update settings set pickproof_k = 150`.execute(db);
    await expect(sql`update settings set pickproof_k = 149`.execute(db)).rejects.toThrow(/can only be raised/);
    const { get } = await boot();
    await standardPool();
    afterDeadline();
    const m = (await get(`/pickproof/${D}/manifest`)).json();
    const two = (await db.selectFrom('pickproof_pool').select('domain').where('is_two_word', '=', true).execute()).length;
    expect(two).toBeGreaterThan(100);
    expect(m).toMatchObject({ k: 150, arms: { B1: { n: 150, short: false }, B2: { n: 132, short: true }, C1: { n: two, short: true } } });
  });

  it('PP528-19 the picks route: a READ token cannot POST (403), a bots and a WRITE token can, the Idempotency-Key is required and replays; GET is open to READ and bots', async () => {
    const { read, write, bots, picks, get } = await boot();
    await standardPool();
    expect((await picks([twoWord[0]!], D, read.auth)).statusCode).toBe(403);
    expect((await picks([twoWord[0]!], D, write.auth)).statusCode).toBe(200);
    expect((await picks([twoWord[1]!], D, bots.auth)).statusCode).toBe(200);
    const noKey = await app!.inject({ method: 'POST', url: `/pickproof/${D}/picks`, headers: bots.auth, payload: { names: [twoWord[0]!] } });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const h = { ...bots.auth, 'idempotency-key': 'same-key-1' };
    const r1 = await app!.inject({ method: 'POST', url: `/pickproof/${D}/picks`, headers: h, payload: { names: [twoWord[3]!] } });
    const r2 = await app!.inject({ method: 'POST', url: `/pickproof/${D}/picks`, headers: h, payload: { names: [twoWord[3]!] } });
    expect(r2.body).toBe(r1.body);
    expect((await get(`/pickproof/${D}/manifest`, bots.auth)).statusCode).toBe(200);
    expect((await get('/pickproof/2026-13-40/manifest')).statusCode).toBe(400);
    expect((await db.selectFrom('audit_log').select('id').where('path', 'like', '/pickproof/%').execute()).length).toBeGreaterThan(0);
  });

  it('PP528-20 a sealed day and its arms cannot be changed in the database', async () => {
    const { get } = await boot();
    await standardPool();
    afterDeadline();
    await get(`/pickproof/${D}/manifest`);
    await expect(db.updateTable('pickproof_days').set({ k: 5 }).where('day', '=', D).execute()).rejects.toThrow(/sealed/);
    await expect(db.deleteFrom('pickproof_arms').where('day', '=', D).execute()).rejects.toThrow(/sealed/);
    await expect(db.insertInto('pickproof_arms').values({ day: D, arm: 'A', domain: twoWord[0]!, rank: 1, price_cents: 1 }).execute()).rejects.toThrow(/sealed/);
    await expect(db.deleteFrom('pickproof_picks_history').execute()).resolves.toBeDefined(); // empty table: no row to refuse
  });
});

// ---------- labels and the report ----------

const RDAP = 'https://rdap.verisign.com/com/v1/domain/:name';
type Answer = { registered: string; status?: string[] } | { registeredNoDate: true } | 'free' | 'error' | 'ratelimit';
const rdap = (answers: Record<string, Answer>, hits: string[] = []) => mswServer.use(http.get(RDAP, ({ params }) => {
  const name = String(params.name);
  hits.push(name);
  const a = answers[name] ?? 'free';
  if (a === 'error') return HttpResponse.error();
  if (a === 'ratelimit') return new HttpResponse(null, { status: 429, headers: { 'retry-after': '60' } });
  if (a === 'free') return HttpResponse.json({ errorCode: 404 }, { status: 404, headers: { 'content-type': 'application/rdap+json' } });
  const events = 'registered' in a ? [{ eventAction: 'registration', eventDate: a.registered }] : [];
  return HttpResponse.json({ objectClassName: 'domain', ldhName: name, events, status: 'registered' in a ? (a.status ?? ['active']) : ['active'] }, { headers: { 'content-type': 'application/rdap+json' } });
}));

/** A sealed pick day built straight in the tables: arms = {A: [...], B1: [...]}, prices by index. */
const fixtureDay = async (day: string, arms: Partial<Record<'A' | 'B1' | 'B2' | 'C1', string[]>>, price = (i: number) => 500 + (i % 3) * 1500) => {
  const sha = (day + 'x').padEnd(64, 'f').replace(/[^0-9a-f]/g, 'e');
  await db.insertInto('pickproof_days').values({ day, data_date: new Date(at(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10), pool_sha256: sha, seed: 1, k: 100, pool_n: 1, sources: '{}', deadline: new Date(at(`${day}T16:00:00Z`)) }).execute();
  const summary: Record<string, unknown> = {};
  for (const [arm, list] of Object.entries(arms)) {
    if (list!.length > 0) await db.insertInto('pickproof_arms').values(list!.map((domain, i) => ({ day, arm: arm as 'A', domain, rank: i + 1, price_cents: price(i) }))).execute();
    summary[arm] = { n: list!.length, sha256: `${arm}-${day}`.padEnd(64, '0'), short: false };
  }
  await db.updateTable('pickproof_days').set({ arms: JSON.stringify(summary), sealed_at: new Date(at(`${day}T16:05:00Z`)) }).where('day', '=', day).execute();
};
const labelRow = (domain: string, day: string) => db.selectFrom('pickproof_labels').selectAll().where('domain', '=', domain).where('day', '=', day).executeTakeFirst();
const noSleep = async () => undefined;
const L = '2026-11-01'; // an old pick day for the label tests

describe('PP528 pick-proof: T30 labels', () => {
  it('PP528-30 labels only the names of the sealed arms of days 30 or more days old, once per name, no arm attached; taken = registered and not in redemption period / pending delete', async () => {
    await fixtureDay(L, { A: ['alpha.com', 'beta.com', 'both.com'], B1: ['both.com', 'gamma.com'], C1: ['delta.com', 'eps.com', 'zeta.com'] });
    await fixtureDay('2026-11-20', { A: ['young.com'] }); // 20 days old on the run day
    const hits: string[] = [];
    rdap({
      'alpha.com': { registered: '2026-11-10T08:00:00Z' }, // (e) created after D: taken, created_after_d
      'beta.com': { registered: '2019-05-01T00:00:00Z', status: ['active'] }, // (a) old creation date, active: taken
      'both.com': { registeredNoDate: true }, // registered, no date: taken, created_unknown
      'gamma.com': { registered: '2019-05-01T00:00:00Z', status: ['client delete prohibited', 'redemption period'] }, // (b)
      'delta.com': { registered: '2019-05-01T00:00:00Z', status: ['pendingDelete'] }, // (c) camelCase
      'eps.com': 'free', // (d) 404
      'zeta.com': { registered: '2026-11-10T00:00:00Z', status: ['Redemption  Period'] }, // created after D but redeeming: not taken
    }, hits);
    const s = await pickproofLabels({ db, now: () => at('2026-12-10T15:00:00Z'), sleep: noSleep });
    expect(s).toMatchObject({ status: 'ok', eligible_n: 7, lookups_n: 7, taken_n: 3, not_taken_n: 4, unknown_n: 0, created_unknown_n: 1 });
    expect(hits.sort()).toEqual(['alpha.com', 'beta.com', 'both.com', 'delta.com', 'eps.com', 'gamma.com', 'zeta.com']); // the younger day and non-arm names are never looked up
    expect(await labelRow('alpha.com', L)).toMatchObject({ label: 'taken', created_unknown: false, created_after_d: true });
    expect((await labelRow('alpha.com', L))!.created_at_rdap!.toISOString()).toBe('2026-11-10T08:00:00.000Z');
    expect(await labelRow('beta.com', L)).toMatchObject({ label: 'taken', created_after_d: false });
    expect(await labelRow('both.com', L)).toMatchObject({ label: 'taken', created_unknown: true, created_after_d: null, created_at_rdap: null });
    expect(await labelRow('gamma.com', L)).toMatchObject({ label: 'not_taken', created_after_d: false });
    expect(await labelRow('delta.com', L)).toMatchObject({ label: 'not_taken' });
    expect(await labelRow('eps.com', L)).toMatchObject({ label: 'not_taken', created_after_d: null });
    expect(await labelRow('zeta.com', L)).toMatchObject({ label: 'not_taken', created_after_d: true });
    expect(await labelRow('young.com', '2026-11-20')).toBeUndefined();
    // a second run has nothing to do
    hits.length = 0;
    expect(await pickproofLabels({ db, now: () => at('2026-12-10T16:00:00Z'), sleep: noSleep })).toMatchObject({ status: 'nothing_due', eligible_n: 0, lookups_n: 0 });
    expect(hits).toEqual([]);
    // the label table has no arm column
    expect(Object.keys((await labelRow('both.com', L))!)).not.toContain('arm');
  });

  it('PP528-31 (AT-7) an RDAP error or timeout is label unknown, excluded from the rates and counted in unknown_n; it is tried again until D+40, then stays unknown', async () => {
    await boot();
    await fixtureDay(L, { A: ['flaky.com', 'steady.com'], C1: ['stuck.com'] });
    rdap({ 'flaky.com': 'error', 'stuck.com': 'error', 'steady.com': 'free' });
    const first = await pickproofLabels({ db, now: () => at('2026-12-02T15:00:00Z'), sleep: noSleep }); // D+31
    expect(first).toMatchObject({ unknown_n: 2, not_taken_n: 1 });
    expect(await labelRow('flaky.com', L)).toMatchObject({ label: 'unknown', attempts: 1 });
    const read = (await issueToken('read')).auth;
    const rep = (await app!.inject({ method: 'GET', url: '/pickproof/report', headers: read })).json();
    expect(rep.arms.A).toMatchObject({ names_n: 2, n: 1, events: 0, unknown_n: 1 });
    expect(rep.arms.C1).toMatchObject({ n: 0, rate: null, unknown_n: 1 });
    // D+35: flaky.com answers now, stuck.com still fails (a second try)
    rdap({ 'flaky.com': { registered: '2026-11-15T00:00:00Z' }, 'stuck.com': 'error' });
    const second = await pickproofLabels({ db, now: () => at('2026-12-06T15:00:00Z'), sleep: noSleep });
    expect(second).toMatchObject({ eligible_n: 2, lookups_n: 2, taken_n: 1, unknown_n: 1 });
    expect(await labelRow('flaky.com', L)).toMatchObject({ label: 'taken', attempts: 2 });
    expect(await labelRow('stuck.com', L)).toMatchObject({ label: 'unknown', attempts: 2 });
    // D+41: no more tries
    const hits: string[] = [];
    rdap({ 'stuck.com': { registered: '2026-11-20T00:00:00Z' } }, hits);
    const third = await pickproofLabels({ db, now: () => at('2026-12-12T15:00:00Z'), sleep: noSleep });
    expect(third).toMatchObject({ status: 'nothing_due', lookups_n: 0 });
    expect(hits).toEqual([]);
    expect(await labelRow('stuck.com', L)).toMatchObject({ label: 'unknown', attempts: 2 });
  });

  it('PP528-32 at most settings.pickproof_labels_max_per_run lookups a run (oldest first), a 429 stops the run, old pool rows are pruned', async () => {
    await sql`update settings set pickproof_labels_max_per_run = 2`.execute(db);
    await fixtureDay(L, { A: ['n1.com', 'n2.com', 'n3.com', 'n4.com'] });
    const hits: string[] = [];
    rdap({ 'n1.com': 'free', 'n2.com': 'free' }, hits);
    const s = await pickproofLabels({ db, now: () => at('2026-12-10T15:00:00Z'), sleep: noSleep });
    expect(s).toMatchObject({ status: 'stopped', stopped_reason: 'CAP', eligible_n: 4, lookups_n: 2 });
    expect(hits).toEqual(['n1.com', 'n2.com']);
    // a 429 stops the run at once and the name stays unknown (the pickproof_labels_max_per_run cap is raised for this part)
    await sql`update settings set pickproof_labels_max_per_run = 300`.execute(db);
    const hits2: string[] = [];
    rdap({ 'n3.com': 'ratelimit' }, hits2);
    const t = await pickproofLabels({ db, now: () => at('2026-12-10T16:00:00Z'), sleep: noSleep });
    expect(t).toMatchObject({ status: 'stopped', stopped_reason: 'RATE_LIMITED', eligible_n: 2, lookups_n: 1, unknown_n: 1 });
    expect(hits2).toEqual(['n3.com']);
    expect(await labelRow('n3.com', L)).toMatchObject({ label: 'unknown', reason: 'RATE_LIMITED' });
    // pool rows older than the keep days are deleted
    await db.insertInto('pickproof_pool').values({ day: L, domain: 'oldpool.com', source: 'godaddy', price_cents: 1, passes_k1: false, is_two_word: false }).execute();
    const pr = await pickproofLabels({ db, now: () => at('2026-12-20T15:00:00Z'), sleep: noSleep });
    expect(pr.pool_rows_deleted_n).toBe(1);
  });

  it('PP528-33 the datasave job has the pickproofLabels step last and it reports', async () => {
    await boot();
    mswServer.use(...inventoryHandlers());
    const run = await runJobToEnd(app!, 'datasave');
    const steps = Object.keys(run.json().steps as Record<string, unknown>);
    expect(steps[steps.length - 1]).toBe('pickproofLabels');
    expect(steps).toHaveLength(9);
  });
});

describe('PP528 pick-proof: report', () => {
  /** One day with A and an arm X sharing `shared` names; events: the first eA names of A and the first eX names of X are taken. */
  const build = async (day: string, shared: number, eA: number, eX: number, arm: 'C1' | 'B1' | 'B2' = 'C1', k = 100) => {
    const A = Array.from({ length: k }, (_, i) => `a${day.slice(-2)}${i}.com`);
    const X = [...A.slice(0, shared), ...Array.from({ length: k - shared }, (_, i) => `x${arm.toLowerCase()}${day.slice(-2)}${i}.com`)];
    await fixtureDay(day, { A, [arm]: X } as never);
    const rows = [...A.slice(0, eA).map((d) => [d, 'taken']), ...A.slice(eA).map((d) => [d, 'not_taken']), ...X.slice(shared).map((d, i) => [d, i < eX ? 'taken' : 'not_taken'])];
    await db.insertInto('pickproof_labels').values(rows.map(([domain, label]) => ({ domain: domain!, day, label: label as 'taken', checked_at: new Date(), attempts: 1, created_unknown: false }))).execute();
    return { A, X };
  };
  const rep = async (q = '') => {
    const { read } = await boot();
    const r = await app!.inject({ method: 'GET', url: `/pickproof/report${q}`, headers: read.auth });
    expect(r.statusCode, r.body).toBe(200);
    return r.json();
  };

  it('PP528-40 (AT-5) four events in total: UNPOWERED, no p-value and no pass or fail; every output carries "proxy, not profit"', async () => {
    await build('2026-11-02', 0, 3, 1);
    const r = await rep();
    expect(r.label).toBe('proxy, not profit');
    expect(r.primary).toMatchObject({ vs: 'C1', status: 'UNPOWERED', p_value: null, result: null, events_total: 4, label: 'proxy, not profit' });
    expect(r.secondary.map((s: { vs: string; status: string }) => `${s.vs}:${s.status}`)).toEqual(['B1:UNPOWERED', 'B2:UNPOWERED']);
    expect(r.arms.A).toMatchObject({ names_n: 100, n: 100, events: 3, rate: 0.03, unknown_n: 0, label: 'proxy, not profit' });
    expect(r.arms.C2).toEqual({ status: 'not_built' });
  });

  it('PP528-41 (AT-6) overlap 12% switches the primary to the permutation test (reproducible p, 10,000 shuffles); overlap 2% uses Fisher', async () => {
    await build('2026-11-02', 12, 40, 0);
    const hi = await rep();
    expect(hi.primary).toMatchObject({ status: 'OK', method: 'permutation', overlap_pct: 12, overlap_n: 12, events_a: 40, events_b: 12 });
    expect(hi.primary.permutation).toMatchObject({ shuffles: 10000 });
    expect(hi.primary.p_value).toBe(hi.primary.permutation.p_value);
    expect(hi.primary.p_value).toBeLessThan(0.01);
    expect(hi.primary.result).toBe('pass');
    expect(typeof hi.primary.fisher_p).toBe('number');
    const again = await app!.inject({ method: 'GET', url: '/pickproof/report', headers: (await issueToken('read')).auth });
    expect(again.json().primary.permutation).toEqual(hi.primary.permutation);
  });

  it('PP528-42 overlap 2% uses Fisher exact, with CMH by price band and the secondaries Holm-adjusted', async () => {
    await build('2026-11-02', 2, 30, 10);
    await build('2026-11-03', 2, 25, 12);
    const r = await rep();
    expect(r.primary).toMatchObject({ status: 'OK', method: 'fisher', overlap_pct: 2, permutation: null, events_a: 55, events_b: 26, n_a: 200, n_b: 200 });
    expect(r.primary.p_value).toBe(r.primary.fisher_p);
    expect(r.primary.p_value).toBeLessThan(0.001);
    expect(r.primary.cmh.strata.map((s: { band: string }) => s.band)).toEqual(['$0-9.99', '$10-19.99', '$20-40']);
    expect(r.primary.cmh.p_value).toBeLessThan(0.01);
    // no B1 / B2 arms stored: unpowered, not failed
    expect(r.secondary.every((s: { status: string }) => s.status === 'UNPOWERED')).toBe(true);
    expect(r.days).toMatchObject({ sealed_n: 2, list: ['2026-11-02', '2026-11-03'] });
    // the date filter
    const one = await app!.inject({ method: 'GET', url: '/pickproof/report?from=2026-11-03&to=2026-11-03', headers: (await issueToken('read')).auth });
    expect(one.json().days.list).toEqual(['2026-11-03']);
    expect((await app!.inject({ method: 'GET', url: '/pickproof/report?from=2026-11-04&to=2026-11-03', headers: (await issueToken('read')).auth })).statusCode).toBe(400);
  });

  it('PP528-43 secondaries A vs B1 and A vs B2 are Holm-adjusted together; a name with an unknown label counts in unknown_n only', async () => {
    const day = '2026-11-02';
    const A = Array.from({ length: 100 }, (_, i) => `a${i}.com`);
    const B1 = Array.from({ length: 100 }, (_, i) => `b${i}.com`);
    const B2 = Array.from({ length: 100 }, (_, i) => `c${i}.com`);
    await fixtureDay(day, { A, B1, B2 });
    const lab = (list: string[], taken: number) => list.map((domain, i) => ({ domain, day, label: (i < taken ? 'taken' : 'not_taken') as 'taken', checked_at: new Date(), attempts: 1, created_unknown: false }));
    await db.insertInto('pickproof_labels').values([...lab(A, 30), ...lab(B1, 12), ...lab(B2, 20)]).execute();
    await db.updateTable('pickproof_labels').set({ label: 'unknown' }).where('domain', '=', 'b99.com').execute();
    const r = await rep();
    const [s1, s2] = r.secondary;
    expect(s1).toMatchObject({ vs: 'B1', status: 'OK', n_b: 99, events_b: 12 });
    expect(s2).toMatchObject({ vs: 'B2', status: 'OK' });
    expect(r.arms.B1.unknown_n).toBe(1);
    const small = s1.p_value <= s2.p_value ? s1 : s2, large = small === s1 ? s2 : s1;
    expect(small.p_adjusted).toBeCloseTo(Math.min(1, 2 * small.p_value), 12);
    expect(large.p_adjusted).toBeCloseTo(Math.max(small.p_adjusted, large.p_value), 12);
    // C1 has no stored arm: primary unpowered
    expect(r.primary.status).toBe('UNPOWERED');
  });
});
