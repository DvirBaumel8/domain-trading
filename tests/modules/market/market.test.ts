// v5.23.0 (CR-075, data program v1): market_names episodes and labels, POST /data/sales (add-only), GET /market/{episodes,matched,dq,coverage}, the dqMarket checks.
// Fixtures are written straight into the sealed-snapshot tables (dynadot_rows, snapshot_manifests, godaddy_auctions); nothing calls the network.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, runJobToEnd } from '../../helpers/app.js';
import { inventoryHandlers } from '../../helpers/datasave.js';
import { testDb as db } from '../../helpers/db.js';
import { issueToken } from '../../helpers/tokens.js';
import { mswServer } from '../../setup/network.js';
import { runDqMarket, runEpisodes } from '../../../src/modules/market/index.js';

const at = (iso: string) => Date.parse(`${iso}T16:00:00Z`);
let app: FastifyInstance | undefined;
let clock = at('2026-12-20');
let n = 0;
afterEach(async () => { await app?.close(); app = undefined; });

const boot = async (day = '2026-12-20') => {
  clock = at(day);
  app = await makeApp({ testRoutes: false, now: () => clock, env: { JOB_TRIGGER_TOKEN: 'job_token_fake_0123456789abcdef0123456789' } });
  const bots = await issueToken('bots');
  const read = await issueToken('read');
  const write = await issueToken('write');
  const data = await issueToken('data');
  const post = (rows: object[], auth = bots.auth, extra: object = {}) => app!.inject({ method: 'POST', url: '/data/sales', headers: { ...auth, 'idempotency-key': `mk-${++n}` }, payload: { rows, ...extra } });
  const get = (url: string, auth = read.auth) => app!.inject({ method: 'GET', url, headers: auth });
  const run = () => runEpisodes(db, clock);
  return { bots, read, write, data, post, get, run };
};

const sealed = async (source: 'dynadot_aftermarket' | 'dynadot_closed_auctions', days: string[]) => {
  for (const d of days) {
    await db.insertInto('snapshot_manifests').values({ source, data_date: d, file_name: 'bot_upload', status: 'complete', sha256: `${source.length}${d}`.padEnd(64, 'a').replace(/-/g, 'b'), rows: 1, sealed_at: new Date(`${d}T16:00:00Z`), origin: 'bot_upload', updated_at: new Date(`${d}T16:00:00Z`) }).onConflict((oc) => oc.doNothing()).execute();
  }
};
/** Name listings on sealed Dynadot days: [name, price in cents]. */
const am = async (day: string, rows: Array<[string, number]>) => {
  await sealed('dynadot_aftermarket', [day]);
  await db.insertInto('dynadot_rows').values(rows.map(([domain, price_cents], i) => ({ data_date: day, kind: 'aftermarket' as const, domain, listing_id: `${domain}-${day}-${i}`, price_cents }))).execute();
};
const sale = (name: string, price: number, date: string, extra: object = {}) => ({ name, venue: 'dnjournal', sale_price_cents: price, sale_date: date, source: 'dnjournal_weekly', tier: 'B', ...extra });
const eps = async (get: (u: string) => Promise<{ json: () => any }>, q = '') => (await get(`/market/episodes?limit=1000${q}`)).json(); // eslint-disable-line @typescript-eslint/no-explicit-any

describe('MK523 market episodes, labels, sales, matched sets, data quality', () => {
  it('MK523-1 (AT-1) a name seen on D and D+61 with no sale report is unsold UNSOLD_60D, days_listed 61', async () => {
    const { run, get } = await boot('2026-12-01');
    await am('2026-10-01', [['alpha.com', 150000]]);
    await am('2026-12-01', [['alpha.com', 150000]]);
    await run();
    const r = await eps(get, '&outcome=unsold');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ name: 'alpha.com', venue: 'dynadot', outcome: 'unsold', outcome_rule: 'UNSOLD_60D', days_listed: 61, price_band: '1k-2.5k', tier: 'B', first_seen: '2026-10-01', last_seen: '2026-12-01', list_price_first_cents: 150000, list_price_last_cents: 150000, list_price_last: '$1,500.00' });
    expect(r.summary).toMatchObject({ total: 1, by_outcome: { unsold: 1 }, by_rule: { UNSOLD_60D: 1 }, by_band: { '1k-2.5k': 1 } });
    expect(r.rows[0].episode_id).toMatch(/^[0-9a-f]{40}$/);
  });

  it('MK523-2 (AT-2) seen on D and D+31 only: UNSOLD_30D (provisional), not counted as UNSOLD_60D', async () => {
    const { run, get } = await boot('2026-11-01');
    await am('2026-10-01', [['beta.com', 80000]]);
    await am('2026-11-01', [['beta.com', 80000]]);
    await run();
    const r = await eps(get, '&outcome=unsold');
    expect(r.rows[0]).toMatchObject({ outcome_rule: 'UNSOLD_30D', days_listed: 31 });
    expect((await eps(get, '&rule=UNSOLD_60D')).rows).toHaveLength(0);
    const cov = (await get('/market/coverage')).json();
    expect(cov).toMatchObject({ unsold_30d_n: 1, unsold_60d_n: 0 });
  });

  it('MK523-3 (AT-3) a name listed on D and a POST /data/sales row on D+20: sold, SOLD_REPORTED, with the sale price and date', async () => {
    const { run, get, post } = await boot('2026-10-30');
    await am('2026-10-01', [['gamma.com', 120000]]);
    await am('2026-10-05', [['gamma.com', 120000]]);
    expect((await post([sale('Gamma.com', 135000, '2026-10-21')])).statusCode).toBe(201);
    await run();
    const r = await eps(get, '&outcome=sold');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ name: 'gamma.com', venue: 'dynadot', outcome: 'sold', outcome_rule: 'SOLD_REPORTED', sale_price_cents: 135000, sale_price: '$1,350.00', sale_date: '2026-10-21', price_band: '1k-2.5k', sale_only: false, tier: 'B' });
  });

  it('MK523-4 (AT-4) a name seen once, or gone with no sale report, is unknown and appears in neither matched class', async () => {
    const { run, get } = await boot('2026-12-20');
    await am('2026-10-01', [['once.com', 60000], ['gone.com', 60000]]);
    await am('2026-10-02', [['gone.com', 60000]]);
    await am('2026-12-19', [['other.com', 60000], ['short.com', 60000]]);
    await am('2026-12-20', [['short.com', 60000]]);
    await run();
    const r = await eps(get, '&outcome=unknown');
    const byName = Object.fromEntries(r.rows.map((x: { name: string; outcome_rule: string }) => [x.name, x.outcome_rule]));
    expect(byName).toMatchObject({ 'once.com': 'SEEN_ONCE', 'gone.com': 'DISAPPEARED', 'other.com': 'SEEN_ONCE', 'short.com': 'TOO_SHORT' });
    const m = (await get('/market/matched?asof=2026-12-20&ratio=4&seed=1')).json();
    expect(JSON.stringify(m.pairs)).not.toContain('once.com');
    expect(m.summary).toMatchObject({ positives_n: 0, negatives_n: 0 });
  });

  it('MK523-5 (AT-5) PUT, PATCH and DELETE on /data/sales are 405 APPEND_ONLY; a changed price for a stored row is 409 APPEND_ONLY and the row is unchanged; the identical repost is a duplicate', async () => {
    const { post, bots, write } = await boot();
    const first = await post([sale('delta.com', 90000, '2026-11-02')]);
    expect(first.json()).toMatchObject({ accepted_n: 1, duplicate_n: 0, rejected_n: 0 });
    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      for (const url of ['/data/sales', '/data/sales/1']) {
        for (const auth of [bots.auth, write.auth]) {
          const res = await app!.inject({ method, url, headers: auth, payload: method === 'DELETE' ? undefined : {} });
          expect(res.statusCode, `${method} ${url}`).toBe(405);
          expect(res.json().error.code).toBe('APPEND_ONLY');
        }
      }
    }
    const changed = await post([sale('delta.com', 95000, '2026-11-02')]);
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error).toMatchObject({ code: 'APPEND_ONLY', details: { conflict_n: 1 } });
    expect(changed.json().error.details.conflicts[0]).toMatchObject({ stored_price_cents: 90000, sent_price_cents: 95000 });
    const same = await post([sale('delta.com', 90000, '2026-11-02')]);
    expect(same.json()).toMatchObject({ accepted_n: 0, duplicate_n: 1 });
    expect(await db.selectFrom('market_sales').select(['sale_price_cents', 'name']).execute()).toEqual([{ name: 'delta.com', sale_price_cents: 90000 }]);
    // the table itself refuses an update or a delete
    await expect(db.updateTable('market_sales').set({ source_url: 'x' }).execute()).rejects.toThrow();
    await expect(db.deleteFrom('market_sales').execute()).rejects.toThrow();
  });

  // positives: sold-only episodes in the 1k-2.5k band; negatives: UNSOLD_60D listings of several bands
  const matchedFixture = async (post: (rows: object[]) => Promise<unknown>, run: () => Promise<unknown>) => {
    await am('2026-10-01', [['nega.com', 150000], ['negb.com', 160000], ['negc.com', 170000], ['negd.com', 180000], ['nege.com', 190000], ['negf.com', 140000], ['negg.com', 130000], ['dig1.com', 150000], ['big.com', 700000], ['wd-1.com', 150000]]);
    await am('2026-12-01', [['nega.com', 150000], ['negb.com', 160000], ['negc.com', 170000], ['negd.com', 180000], ['nege.com', 190000], ['negf.com', 140000], ['negg.com', 130000], ['dig1.com', 150000], ['big.com', 700000], ['wd-1.com', 150000]]);
    await post([sale('posa.com', 200000, '2026-11-01'), sale('posb.com', 120000, '2026-11-10'), sale('posc.net', 120000, '2026-11-10')]);
    await run();
  };

  it('MK523-6 (AT-6) GET /market/matched twice returns the same rows and sha256; every negative shares its positive band, letters flag and window; the set is frozen after new data arrives', async () => {
    const { run, get, post } = await boot('2026-12-20');
    await matchedFixture(post, run);
    const a = (await get('/market/matched?asof=2026-12-01&ratio=4&seed=1')).json();
    const b = (await get('/market/matched?asof=2026-12-01&ratio=4&seed=1')).json();
    expect(b).toEqual(a);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.summary).toMatchObject({ positives_n: 2 }); // posc.net is not .com
    expect(a.pairs).toHaveLength(2);
    for (const p of a.pairs) {
      expect(p.negatives.length).toBeGreaterThan(0);
      expect(p.negatives.length).toBeLessThanOrEqual(4);
      for (const neg of p.negatives) {
        expect(neg.price_band).toBe(p.positive.price_band);
        expect(neg.tld).toBe('com');
        expect(neg.letters_only).toBe(p.positive.letters_only);
        expect(neg.outcome_rule).toBe('UNSOLD_60D');
        expect(neg.last_seen >= p.window.from && neg.first_seen <= p.window.to).toBe(true);
      }
    }
    const used = a.pairs.flatMap((p: { negatives: { name: string }[] }) => p.negatives.map((x) => x.name));
    expect(new Set(used).size).toBe(used.length); // each negative is used once
    expect(used).not.toContain('wd-1.com'); // not letters-only
    expect(used).not.toContain('dig1.com');
    expect(used).not.toContain('big.com'); // another band
    // new data after the first call: a new sale and a new unsold name; the stored set is returned unchanged
    await post([sale('posd.com', 210000, '2026-11-05')]);
    await am('2026-12-02', [['negh.com', 150000]]);
    await run();
    const c = (await get('/market/matched?asof=2026-12-01&ratio=4&seed=1')).json();
    expect(c.sha256).toBe(a.sha256);
    expect(c.pairs).toEqual(a.pairs);
    // another (asof, ratio, seed) is another frozen set built from the data as it is now
    const d = (await get('/market/matched?asof=2026-12-01&ratio=4&seed=2')).json();
    expect(d.summary.positives_n).toBe(3);
    expect(d.sha256).not.toBe(a.sha256);
    expect((await db.selectFrom('market_matched_sets').selectAll().execute())).toHaveLength(2);
    await expect(db.deleteFrom('market_matched_sets').execute()).rejects.toThrow();
  });

  it('MK523-7 (AT-7) a row whose feature as-of date is after first_seen fails the leakage check, /health.dq_market is alert, /report has DQ_MARKET_FAIL, and the row is left out of /market/matched', async () => {
    const { run, get, post } = await boot('2026-12-20');
    await matchedFixture(post, run);
    expect((await get('/health')).json().dq_market).toBe('unknown');
    const clean = await runDqMarket(db, clock);
    expect(clean.status).toBe('ok');
    expect((await get('/health')).json().dq_market).toBe('ok');
    const before = (await get('/market/matched?asof=2026-12-01&ratio=4&seed=1')).json();
    const victim = before.pairs[0].negatives[0].episode_id as string;
    await db.updateTable('market_names').set({ feat_asof: '2026-12-10' }).where('episode_id', '=', victim).execute();
    const bad = await runDqMarket(db, clock);
    expect(bad.status).toBe('alert');
    expect(bad.failed_checks).toEqual(['leakage']);
    expect((await get('/health')).json()).toMatchObject({ dq_market: 'alert', status: 'ok' });
    const warn = ((await get('/report')).json().warnings as { code: string; level: string; details: { checks: string[] } }[]).find((w) => w.code === 'DQ_MARKET_FAIL');
    expect(warn).toBeDefined();
    expect(warn!.details.checks).toEqual(['leakage']);
    const dq = (await get('/market/dq')).json();
    expect(dq).toMatchObject({ status: 'alert', failed_checks: ['leakage'] });
    expect(dq.results.find((r: { check: string }) => r.check === 'leakage')).toMatchObject({ status: 'fail', detail: { rows_n: 1 } });
    const after = (await get('/market/matched?asof=2026-11-30&ratio=4&seed=1')).json();
    expect(JSON.stringify(after.pairs)).not.toContain(victim);
    expect(after.summary.excluded_leakage_n).toBe(1);
  });

  it('MK523-8 (AT-8) a Dynadot day at 10% of the 7-day median fails the coverage check for that source and day', async () => {
    const { get } = await boot('2026-12-10');
    const names = (k: number) => Array.from({ length: k }, (_, i) => [`n${i}.com`, 60000] as [string, number]);
    for (let d = 1; d <= 7; d++) await am(`2026-12-0${d}`, names(20));
    await am('2026-12-08', names(2));
    clock = at('2026-12-08');
    const r = await runDqMarket(db, clock);
    expect(r.status).toBe('alert');
    const dq = (await get('/market/dq')).json();
    const f = dq.results.filter((x: { check: string; status: string }) => x.check === 'coverage' && x.status === 'fail');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ source: 'dynadot_aftermarket', day: '2026-12-08', detail: { rows: 2, median_7d: 20 } });
    expect(dq.failed_checks).toEqual(['coverage']);
    // closed auctions had no rows: nothing to judge, passes
    expect(dq.results.find((x: { source?: string }) => x.source === 'dynadot_closed_auctions')).toMatchObject({ status: 'pass' });
  });

  it('MK523-9 (AT-9) GET /market/coverage: rows per source per day, counts per label and band, unsold_30d_n and unsold_60d_matched_n against the targets, db_rows', async () => {
    const { run, get, post } = await boot('2026-11-20');
    await am('2026-09-20', [['caa.com', 90000], ['cbb.com', 90000]]);
    await am('2026-11-20', [['caa.com', 90000], ['cbb.com', 90000]]);
    await post([sale('winner.com', 95000, '2026-11-10')]);
    await run();
    const cov = (await get('/market/coverage?days=70')).json();
    expect(cov.per_source_daily).toEqual(expect.arrayContaining([{ source: 'dynadot_aftermarket', day: '2026-09-20', rows: 2, sealed: true }, { source: 'dynadot_aftermarket', day: '2026-11-20', rows: 2, sealed: true }]));
    expect(cov.per_source_daily.find((r: { source: string }) => r.source === 'sales_reported')).toMatchObject({ rows: 1 });
    expect(cov.labels).toMatchObject({ UNSOLD_60D: 2, SOLD_REPORTED: 1 });
    expect(cov.bands['500-999']).toMatchObject({ sold: 1, unsold_60d: 2 });
    expect(cov).toMatchObject({ unsold_30d_n: 2, unsold_60d_matched_n: 2, sold_n: 1 });
    expect(cov.targets).toEqual([
      expect.objectContaining({ name: 'unsold_30d', target: 1000, by: '2026-11-25', current: 2, progress_pct: 0.2, days_left: 5, met: false }),
      expect.objectContaining({ name: 'unsold_60d_matched', target: 2000, by: '2026-12-20', current: 2, days_left: 30, met: false }),
    ]);
    expect(cov.db_rows).toMatchObject({ market_names: 3, market_sales: 1 });
    expect(cov.db_rows.market_names_bytes).toBeGreaterThan(0);
  });

  it('MK523-10 (AT-10) a sale row whose source contains namebio, or with no tier, is rejected 422 and nothing is stored', async () => {
    const { post } = await boot();
    const nb = await post([sale('x1.com', 90000, '2026-11-02', { source: 'NameBio-export' })]);
    expect(nb.statusCode).toBe(422);
    expect(nb.json().error.details.rejects[0]).toMatchObject({ row: 0, reason: 'SOURCE_NAMEBIO_FORBIDDEN' });
    const url = await post([sale('x2.com', 90000, '2026-11-02', { source_url: 'https://namebio.com/x' })]);
    expect(url.statusCode).toBe(422);
    const { tier: _t, ...noTier } = sale('x3.com', 90000, '2026-11-02');
    const nt = await post([noTier]);
    expect(nt.statusCode).toBe(422);
    expect(nt.json().error.details.rejects[0].reason).toBe('TIER_REQUIRED');
    expect((await post([sale('x4.com', 90000, '2026-11-02', { tier: 'E' })])).statusCode).toBe(422);
    expect((await post([sale('x5.com', 900.5, '2026-11-02')])).statusCode).toBe(422);
    expect((await post([sale('x6.com', 90000, '2027-01-01')])).statusCode).toBe(422);
    // one bad row rejects the whole call
    expect((await post([sale('ok.com', 90000, '2026-11-02'), sale('x7.com', 90000, '2026-11-02', { source: 'namebio' })])).statusCode).toBe(422);
    expect(await db.selectFrom('market_sales').select('id').execute()).toEqual([]);
  });

  it('MK523-11 episodes run twice for the same day writes nothing the second time and the rows are identical', async () => {
    const { run, get, post } = await boot('2026-12-01');
    await am('2026-10-01', [['idem.com', 150000]]);
    await am('2026-12-01', [['idem.com', 150000]]);
    await post([sale('solo.com', 300000, '2026-11-15')]);
    const a = await run();
    expect(a).toMatchObject({ episodes_n: 2, inserted_n: 2, updated_n: 0, deleted_n: 0 });
    const first = (await eps(get)).rows;
    const stamp = await db.selectFrom('market_names').select(['episode_id', 'derived_at']).orderBy('episode_id').execute();
    const b = await run();
    expect(b).toMatchObject({ episodes_n: 2, inserted_n: 0, updated_n: 0, deleted_n: 0 });
    expect((await eps(get)).rows).toEqual(first);
    expect(await db.selectFrom('market_names').select(['episode_id', 'derived_at']).orderBy('episode_id').execute()).toEqual(stamp);
  });

  it('MK523-12 a gap longer than 7 days with the name absent from a sealed day splits the episode; a gap of 7 days or less does not; two sealed days with no day between never split', async () => {
    const { run, get } = await boot('2026-12-31');
    for (const d of ['2026-10-01', '2026-10-05', '2026-10-12', '2026-10-30']) await sealed('dynadot_aftermarket', [d]);
    await am('2026-10-01', [['split.com', 60000], ['keep.com', 60000]]);
    await am('2026-10-05', [['other.com', 60000]]);            // split.com and keep.com absent on day 5
    await am('2026-10-12', [['split.com', 60000], ['keep.com', 60000]]);
    await am('2026-10-30', [['split.com', 60000]]);
    await run();
    const rows = (await eps(get)).rows as { name: string; first_seen: string; last_seen: string; seen_days: number }[];
    const split = rows.filter((r) => r.name === 'split.com').sort((a, b) => (a.first_seen < b.first_seen ? -1 : 1));
    // 10-01 -> 10-12 is 11 days with an absent sealed day (10-05): two episodes; 10-12 -> 10-30 has no sealed day between with the name absent? 10-30 follows 10-12 directly: one episode
    expect(split.map((r) => [r.first_seen, r.last_seen])).toEqual([['2026-10-01', '2026-10-01'], ['2026-10-12', '2026-10-30']]);
    // keep.com: 10-01 -> 10-12 (11 days, absent on 10-05) also splits; check a <= 7 day gap on another name
    await am('2026-11-01', [['near.com', 60000]]);
    await am('2026-11-04', [['other.com', 60000]]);
    await am('2026-11-08', [['near.com', 60000]]);
    await run();
    const near = ((await eps(get)).rows as { name: string }[]).filter((r) => r.name === 'near.com');
    expect(near).toHaveLength(1); // 11-01 -> 11-08 is 7 days, 11-04 absent: not a break
    expect(near[0]).toMatchObject({ first_seen: '2026-11-01', last_seen: '2026-11-08', seen_days: 2 });
  });

  it('MK523-13 a sale with no episode creates a sold-only episode (first_seen = sale_date, SOLD_REPORTED); a sale under $500 stores the report but no episode', async () => {
    const { run, get, post } = await boot();
    const r = await post([sale('nolist.com', 250000, '2026-11-11', { source_url: 'https://example.test/x' }), sale('cheap.com', 40000, '2026-11-11')]);
    expect(r.json()).toMatchObject({ accepted_n: 2, below_floor_n: 1 });
    const s = await run();
    expect(s).toMatchObject({ episodes_n: 1, sale_only_n: 1, sales_unmatched_n: 1, sales_below_floor_n: 1 });
    const rows = (await eps(get)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'nolist.com', venue: 'dnjournal', outcome: 'sold', outcome_rule: 'SOLD_REPORTED', first_seen: '2026-11-11', last_seen: '2026-11-11', days_listed: 0, sale_only: true, source: 'dnjournal_weekly', source_url: 'https://example.test/x', price_band: '2.5k-5k', tier: 'B' });
    expect(await db.selectFrom('market_names').select('name').where('name', '=', 'cheap.com').execute()).toEqual([]);
  });

  it('MK523-14 the same sale from two sources keeps all rows, the episode takes the highest tier and records dup_sources', async () => {
    const { run, get, post } = await boot();
    await post([sale('dupe.com', 500000, '2026-11-11', { source: 'weekly_blog', tier: 'C' })]);
    await post([sale('dupe.com', 500000, '2026-11-11', { source: 'registrar_report', tier: 'A' })]);
    await post([sale('dupe.com', 500000, '2026-11-11', { source: 'forum_post', tier: 'D' })]);
    expect(await db.selectFrom('market_sales').select('id').execute()).toHaveLength(3);
    await run();
    const rows = (await eps(get)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tier: 'A', source: 'registrar_report', dup_sources: ['forum_post', 'weekly_blog'], price_band: '5k-10k' });
    expect(rows[0].dup_group).toMatch(/^[0-9a-f]{40}$/);
  });

  it('MK523-15 GoDaddy auction endings and Dynadot closed auctions: bids make SOLD_BIDS at the final price, no bids are not a sale, nothing under $500 is stored', async () => {
    const { run, get } = await boot('2026-11-20');
    const end = new Date('2026-11-12T20:00:00Z');
    await db.insertInto('godaddy_auctions').values([
      { domain: 'gdbid.com', end_time: end, first_seen: '2026-11-05', last_seen: '2026-11-12', last_price_cents: 123400, max_price_cents: 123400, last_bid_count: 6, final_state_at: '2026-11-13', ended: true },
      { domain: 'gdnone.com', end_time: end, first_seen: '2026-11-05', last_seen: '2026-11-12', last_price_cents: 60000, max_price_cents: 60000, last_bid_count: 0, final_state_at: '2026-11-13', ended: true },
      { domain: 'gdlow.com', end_time: end, first_seen: '2026-11-05', last_seen: '2026-11-12', last_price_cents: 20000, max_price_cents: 60000, last_bid_count: 3, final_state_at: '2026-11-13', ended: true },
      { domain: 'gdopen.com', end_time: new Date('2026-11-25T20:00:00Z'), first_seen: '2026-11-05', last_seen: '2026-11-19', last_price_cents: 60000, max_price_cents: 60000, last_bid_count: 2, final_state_at: null, ended: false },
    ]).execute();
    await sealed('dynadot_closed_auctions', ['2026-11-13']);
    await db.insertInto('dynadot_rows').values([
      { data_date: '2026-11-13', kind: 'closed_auctions', domain: 'dyn-sold.com', end_time: end, bid_count: 4, final_price_cents: 88000 },
      { data_date: '2026-11-13', kind: 'closed_auctions', domain: 'dyn-nobid.com', end_time: end, bid_count: 0, final_price_cents: 55000 },
      { data_date: '2026-11-13', kind: 'closed_auctions', domain: 'dyn-low.com', end_time: end, bid_count: 5, final_price_cents: 3000 },
    ]).execute();
    await run();
    const rows = (await eps(get)).rows as { name: string; venue: string; outcome: string; outcome_rule: string; sale_price_cents: number | null; sale_date: string | null; tier: string; listing_type: string; source: string }[];
    expect(rows.map((r) => r.name).sort()).toEqual(['dyn-nobid.com', 'dyn-sold.com', 'gdbid.com', 'gdnone.com']);
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(by['gdbid.com']).toMatchObject({ venue: 'godaddy', listing_type: 'auction', outcome: 'sold', outcome_rule: 'SOLD_BIDS', sale_price_cents: 123400, sale_date: '2026-11-12', tier: 'A', source: 'godaddy_auction_end' });
    expect(by['dyn-sold.com']).toMatchObject({ venue: 'dynadot', outcome: 'sold', outcome_rule: 'SOLD_BIDS', sale_price_cents: 88000, tier: 'B' });
    expect(by['gdnone.com']).toMatchObject({ outcome: 'unknown' });
    expect(by['dyn-nobid.com']).toMatchObject({ outcome: 'unknown' });
    const cov = (await get('/market/coverage')).json();
    expect(cov.labels).toMatchObject({ SOLD_BIDS: 2 });
    expect((await eps(get, '&rule=SOLD_BIDS')).summary.total).toBe(2);
  });

  it('MK523-16 a stored episode continues when its oldest source rows have been pruned; the first_seen and first price stay', async () => {
    const { run, get } = await boot('2026-12-01');
    await am('2026-10-01', [['old.com', 100000]]);
    await am('2026-10-03', [['old.com', 100000]]);
    await run();
    const before = (await eps(get)).rows[0];
    await db.deleteFrom('dynadot_rows').where('data_date', '=', '2026-10-01').execute();
    await am('2026-10-08', [['old.com', 120000]]);
    clock = at('2026-12-01');
    await run();
    const after = (await eps(get)).rows;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ episode_id: before.episode_id, first_seen: '2026-10-01', last_seen: '2026-10-08', list_price_first_cents: 100000, list_price_last_cents: 120000 });
  });

  it('MK574-1 (v5.74.0) episodes fold each sealed day into the stored episodes: with every older day pruned, seen_days and price_changes keep counting; a second run writes nothing; a gap over 7 days with a sealed day between starts a new episode', async () => {
    const { run, get } = await boot('2026-12-01');
    await am('2026-10-01', [['fold.com', 100000]]);
    await run();
    await db.deleteFrom('dynadot_rows').execute();
    await am('2026-10-02', [['fold.com', 100000]]);
    await run();
    await db.deleteFrom('dynadot_rows').execute();
    await am('2026-10-03', [['fold.com', 120000]]);
    await run();
    await run();
    const rows = (await eps(get)).rows as { first_seen: string; last_seen: string; seen_days: number; price_changes: number; list_price_first_cents: number; list_price_last_cents: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ first_seen: '2026-10-01', last_seen: '2026-10-03', seen_days: 3, price_changes: 1, list_price_first_cents: 100000, list_price_last_cents: 120000 });
    await db.deleteFrom('dynadot_rows').execute();
    await am('2026-10-08', [['other.com', 90000]]);
    await am('2026-10-20', [['fold.com', 120000]]);
    await run();
    expect(((await eps(get)).rows as { name: string }[]).filter((r) => r.name === 'fold.com')).toHaveLength(2);
  });

  it('MK523-17 POST /data/sales: bots, WRITE and data tokens can post, a READ token is 403; dry_run stores nothing; the audit row keeps only the row count', async () => {
    const { post, bots, write, data, read } = await boot();
    expect((await post([sale('a1.com', 90000, '2026-11-02')], bots.auth)).statusCode).toBe(201);
    expect((await post([sale('a2.com', 90000, '2026-11-02')], write.auth)).statusCode).toBe(201);
    expect((await post([sale('a3.com', 90000, '2026-11-02')], data.auth)).statusCode).toBe(201);
    const ro = await post([sale('a4.com', 90000, '2026-11-02')], read.auth);
    expect(ro.statusCode).toBe(403);
    const dry = await post([sale('a5.com', 90000, '2026-11-02')], bots.auth, { dry_run: true });
    expect(dry.json()).toMatchObject({ dry_run: true, accepted_n: 1 });
    expect((await db.selectFrom('market_sales').select('name').orderBy('name').execute()).map((r) => r.name)).toEqual(['a1.com', 'a2.com', 'a3.com']);
    const audit = await db.selectFrom('audit_log').select(['request', 'result_summary']).where('id', '=', dry.json().audit_id).executeTakeFirstOrThrow();
    expect(JSON.stringify(audit.request)).toContain('[1 rows]');
    expect(JSON.stringify(audit.request)).not.toContain('a5.com');
  });

  it('MK523-18 GET /market/* validate their query and need a token; a data token is 403', async () => {
    const { get, data } = await boot();
    expect((await get('/market/matched')).statusCode).toBe(400);
    expect((await get('/market/matched?asof=2026-13-40')).statusCode).toBe(400);
    expect((await get('/market/matched?asof=2026-12-20&ratio=0')).statusCode).toBe(400);
    expect((await get('/market/episodes?outcome=maybe')).statusCode).toBe(400);
    expect((await get('/market/episodes?limit=1001')).statusCode).toBe(400);
    expect((await get('/market/episodes?from=2026-12-02&to=2026-12-01')).statusCode).toBe(400);
    expect((await get('/market/dq')).json()).toMatchObject({ status: 'unknown', results: [] });
    expect((await get('/market/episodes', data.auth)).statusCode).toBe(403);
    expect((await app!.inject({ method: 'GET', url: '/market/dq' })).statusCode).toBe(401);
  });

  it('MK523-19 the datasave job ends with the steps episodes and dqMarket; a failed dq check is data, not a failed step; health.dq_market goes from unknown to ok', async () => {
    mswServer.use(...inventoryHandlers());
    const { get } = await boot('2026-10-20');
    expect((await get('/health')).json().dq_market).toBe('unknown');
    const run = await runJobToEnd(app!, 'datasave');
    const steps = run.json().steps as Record<string, { status: string; summary?: Record<string, unknown> }>;
    expect(Object.keys(steps)).toEqual(['godaddyInventory', 'scorePool', 'buildPanel', 'engineFeed', 'auctionShortlist', 'pickproofSeal', 'snapshotRetention', 'episodes', 'dqMarket', 'pickproofLabels', 'dynadotCloseouts', 'dynadotAftermarket']);
    expect(steps.episodes).toMatchObject({ status: 'done' });
    expect(steps.dqMarket).toMatchObject({ status: 'done', summary: { status: 'ok', failed_checks: [] } });
    expect((await get('/health')).json().dq_market).toBe('ok');
    // a second run the same day derives the same rows
    const again = await runJobToEnd(app!, 'datasave');
    expect((again.json().steps as Record<string, { status: string }>).episodes!.status).toBe('done');
  });

  it('MK523-20 price sanity flags a more than 10x jump between consecutive snapshot days, a sale that looks like dollars read as cents, and a sale far from the list price', async () => {
    const { post } = await boot('2026-12-20');
    await am('2026-12-18', [['jump.com', 60000], ['steady.com', 60000]]);
    await am('2026-12-19', [['jump.com', 900000], ['steady.com', 61000]]);
    await post([sale('tiny.com', 5000, '2026-12-10')]);
    const r = await runDqMarket(db, clock);
    const p = r.results.find((x) => x.check === 'price_sanity')!;
    expect(p.status).toBe('fail');
    expect(p.detail).toMatchObject({ jumps_over_10x_n: 1, sales_under_100_usd_n: 1 });
  });

  it('MK562-1 (BUG-062) a Dynadot listing over $2.1M (its int4 cents times 10 overflow) runs the price check without integer out of range and is still compared', async () => {
    await boot('2026-12-20');
    await am('2026-12-18', [['huge.com', 2_000_000_000], ['tiny.com', 100]]);
    await am('2026-12-19', [['huge.com', 2_100_000_000], ['tiny.com', 2_000_000_000]]);
    const r = await runDqMarket(db, clock);
    expect(r.id).not.toBeNull();
    expect(r.results.find((x) => x.check === 'price_sanity')!.detail).toMatchObject({ jumps_over_10x_n: 1 });
  });

  it('MK523-22 each bad sale row has its own reason: SOURCE_REQUIRED, UNKNOWN_FIELD, PRICE_NOT_INTEGER_CENTS, LISTING_TYPE_INVALID, NAME_INVALID, VENUE_INVALID, DATE_INVALID, SOURCE_URL_INVALID', async () => {
    const { post } = await boot();
    const reason = async (row: object) => (await post([row])).json().error.details.rejects[0].reason;
    expect(await reason(sale('r1.com', 90000, '2026-11-02', { source: '  ' }))).toBe('SOURCE_REQUIRED');
    expect(await reason(sale('r2.com', 90000, '2026-11-02', { extra: 1 }))).toBe('UNKNOWN_FIELD:extra');
    expect(await reason(sale('r3.com', 9000.5, '2026-11-02'))).toBe('PRICE_NOT_INTEGER_CENTS');
    expect(await reason(sale('r4.com', 90000, '2026-11-02', { listing_type: 'swap' }))).toBe('LISTING_TYPE_INVALID');
    expect(await reason(sale('not a name', 90000, '2026-11-02'))).toBe('NAME_INVALID');
    expect(await reason(sale('r5.com', 90000, '2026-11-02', { venue: 'Bad Venue!' }))).toBe('VENUE_INVALID');
    expect(await reason(sale('r6.com', 90000, '2026-02-31'))).toBe('DATE_INVALID');
    expect(await reason(sale('r7.com', 90000, '2026-11-02', { source_url: 5 }))).toBe('SOURCE_URL_INVALID');
    expect(await reason(sale('r8.com', 90000, '2026-11-02', { tier: undefined }))).toBe('TIER_REQUIRED');
  });

  it('MK523-21 a name that left the source after 60+ days counts as unsold only once 90 days have passed since first_seen (a late sale report can still explain it); before that it is unknown DISAPPEARED', async () => {
    const { run, get } = await boot('2026-12-10');
    await am('2026-10-01', [['left.com', 70000]]);
    await am('2026-12-05', [['left.com', 70000]]);   // 65 days
    await am('2026-12-08', [['other.com', 70000]]);
    await am('2026-12-20', [['other.com', 70000]]); // the source goes on; left.com is absent from the sealed days after 12-05
    clock = at('2026-12-20');
    await run();
    expect(((await eps(get)).rows as { name: string; outcome_rule: string }[]).find((r) => r.name === 'left.com')).toMatchObject({ outcome: 'unknown', outcome_rule: 'DISAPPEARED' });
    clock = at('2027-01-05'); // 96 days after first_seen
    await am('2027-01-05', [['other.com', 70000]]);
    await run();
    expect(((await eps(get)).rows as { name: string; outcome_rule: string }[]).find((r) => r.name === 'left.com')).toMatchObject({ outcome: 'unsold', outcome_rule: 'UNSOLD_60D' });
  });

  it('MK525-1 GET /market/matched with an asof after the newest sealed source day is 409 MATCHED_ASOF_FUTURE and stores nothing; the newest sealed day itself is accepted', async () => {
    const { run, get, post } = await boot('2026-12-20');
    await matchedFixture(post, run); // newest sealed day 2026-12-01
    const r = await get('/market/matched?asof=2026-12-20&ratio=4&seed=1');
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatchObject({ code: 'MATCHED_ASOF_FUTURE', details: { asof: '2026-12-20', newest_sealed_day: '2026-12-01' } });
    expect(await db.selectFrom('market_matched_sets').selectAll().execute()).toHaveLength(0);
    expect((await get('/market/matched?asof=2026-12-01&ratio=4&seed=1')).statusCode).toBe(200);
  });

  it('MK525-1 with no sealed source day the limit is today (UTC): tomorrow is MATCHED_ASOF_FUTURE, today answers', async () => {
    const { get } = await boot('2026-12-20');
    expect((await get('/market/matched?asof=2026-12-21')).json().error.code).toBe('MATCHED_ASOF_FUTURE');
    expect((await get('/market/matched?asof=2026-12-20')).statusCode).toBe(200);
  });

  it('MK525-2 a set with no positives is returned with frozen false and not stored; a later call with data freezes a non-empty set', async () => {
    const { run, get, post } = await boot('2026-12-20');
    await am('2026-12-01', [['nega.com', 150000]]);
    await run();
    const empty = (await get('/market/matched?asof=2026-12-01&ratio=4&seed=1')).json();
    expect(empty).toMatchObject({ frozen: false, frozen_at: null, summary: { positives_n: 0 } });
    expect(empty.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await db.selectFrom('market_matched_sets').selectAll().execute()).toHaveLength(0);
    await post([sale('posa.com', 200000, '2026-11-01')]);
    await run();
    const real = (await get('/market/matched?asof=2026-12-01&ratio=4&seed=1')).json();
    expect(real).toMatchObject({ frozen: true, summary: { positives_n: 1 } });
    expect(real.sha256).not.toBe(empty.sha256);
    expect(await db.selectFrom('market_matched_sets').selectAll().execute()).toHaveLength(1);
  });

  it('MK525-3 the v5.25.0 migration deletes only matched sets with 0 positives and re-enables the append-only trigger', () => {
    const sql = readFileSync('migrations/1765700000000_v5-25-0.sql', 'utf8').split(/^-- Down Migration/m)[0]!;
    expect(sql).toMatch(/DISABLE TRIGGER market_matched_sets_append_only;\s*DELETE FROM public\.market_matched_sets WHERE \(payload->'summary'->>'positives_n'\)::int = 0;\s*ALTER TABLE public\.market_matched_sets ENABLE TRIGGER market_matched_sets_append_only;/);
    expect(sql.match(/DELETE FROM/g)).toHaveLength(1);
    expect(sql).not.toMatch(/^TRUNCATE|DROP TABLE public\.market_matched/m);
  });
});
