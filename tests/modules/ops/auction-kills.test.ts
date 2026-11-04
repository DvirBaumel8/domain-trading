// v6.4.0 (CR-101): auction_kills and the prior-kill rule of GET /auctions/shortlist. Test ids CR101-T1..T12 (rules: docs/internal/auctions.md "Kills").
// The stored auction_shortlist rows are inserted directly (the step itself is covered by auction-shortlist.test.ts).
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { makeApp } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { issueToken } from '../../helpers/tokens.js';

const NOW = Date.parse('2026-11-04T09:00:00Z');
const DATE = '2026-11-03';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let app: FastifyInstance | null = null;
afterEach(async () => { await app?.close(); app = null; });

const name = (i: number): string => `killname${i}.com`;
async function seed(n: number, o: { date?: string; price?: (i: number) => number } = {}): Promise<void> {
  const date = o.date ?? DATE;
  for (let from = 0; from < n; from += 2000) {
    const part = Array.from({ length: Math.min(2000, n - from) }, (_, k) => from + k);
    await db.insertInto('auction_shortlist').values(part.map((i) => ({
      data_date: date, domain: name(i), rank: i + 1, score: 50, score_version: 'auction-v2', parts: JSON.stringify({}), price_cents: o.price ? o.price(i) : 2000, bids: 3,
      end_time: new Date(NOW + 30 * HOUR), auction_type: 'Bid', valuation_cents: null, domain_age: null, pageviews: null, max_bid_suggested_cents: 3000, reasons: [], prebid_id: null,
      prebid_verdict: null, dropped_reason: null, generated_at: new Date(NOW - HOUR), field_n: n,
    }))).execute();
  }
}
async function setup() {
  app = await makeApp({ now: () => NOW });
  return { w: (await issueToken('write', 'gavriel')).auth, b: (await issueToken('bots', 'buyer')).auth, d: (await issueToken('data', 'data-up')).auth, r: (await issueToken('read', 'reader')).auth };
}
const post = (h: Record<string, string>, rows: unknown[]) => app!.inject({ method: 'POST', url: '/auctions/kills', headers: { ...h, 'idempotency-key': randomUUID() }, payload: { rows } });
const get = (url: string, h: Record<string, string>) => app!.inject({ method: 'GET', url, headers: h });
const kill = (i: number, o: Record<string, unknown> = {}) => ({ domain: name(i), kill_stage: 'prior_exclude', data_date_at_kill: '2026-11-02', run_id: 'pack-1', killed_at: new Date(NOW - DAY).toISOString(), ...o });
type SRow = { domain: string; prior_kill: { kill_stage: string; killed_at: string; price_cents_at_kill: number | null; reshow_reason: string } | null; rank: number };
const served = async (h: Record<string, string>, qs = '') => (await get(`/auctions/shortlist?date=${DATE}&limit=10000${qs}`, h)).json() as { total: number; prior_kill_excluded_n: number; rows: SRow[] };

describe('auction kills (CR-101)', () => {
  it('CR101-T1: 3 posted kills are not served; prior_kill_excluded_n is 3', async () => {
    const { b } = await setup();
    await seed(10);
    const r = await post(b, [kill(1), kill(2), kill(3)]);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ table: 'auction_kills', received_n: 3, accepted_n: 3, duplicate_n: 0, rejected_n: 0 });
    const j = await served(b);
    expect(j.rows.map((x) => x.domain)).not.toEqual(expect.arrayContaining([name(1)]));
    expect(j.rows).toHaveLength(7);
    expect(j.rows.every((x) => x.prior_kill === null)).toBe(true);
    expect(j).toMatchObject({ total: 7, prior_kill_excluded_n: 3 });
  });

  it('CR101-T2: replay of a day: 110 prior_exclude names of 240 are not served, the stored rows are unchanged', async () => {
    const { w, b } = await setup();
    await seed(240);
    expect((await post(b, Array.from({ length: 110 }, (_, i) => kill(i * 2)))).statusCode).toBe(201);
    const j = await served(w);
    expect(j.rows).toHaveLength(130);
    const killed = new Set(Array.from({ length: 110 }, (_, i) => name(i * 2)));
    expect(j.rows.filter((x) => killed.has(x.domain))).toEqual([]);
    expect(j.prior_kill_excluded_n).toBe(110);
    expect(Number((await sql<{ n: string }>`select count(*)::text as n from auction_shortlist where data_date = ${DATE}`.execute(db)).rows[0]!.n)).toBe(240);
  });

  it('CR101-T3: counts: total + prior_kill_excluded_n equals the old total, field_n is unchanged', async () => {
    const { b } = await setup();
    await seed(40);
    const before = await served(b);
    expect(before).toMatchObject({ total: 40, prior_kill_excluded_n: 0 });
    await post(b, [kill(5), kill(6), kill(7, { kill_stage: 'tier_a' })]);
    const after = await served(b);
    expect(after.total + after.prior_kill_excluded_n).toBe(before.total);
    expect(new Set(after.rows.map((x) => (x as unknown as { field_n: number }).field_n))).toEqual(new Set([40]));
  });

  it('CR101-T4: re-show by price: a tier_a kill at $40 with today $18 is served with price_halved; at $25 it is not', async () => {
    const { b } = await setup();
    await seed(2, { price: (i) => (i === 0 ? 1800 : 2500) });
    expect((await post(b, [kill(0, { kill_stage: 'tier_a', price_cents_at_kill: 4000 }), kill(1, { kill_stage: 'tier_a', price_cents_at_kill: 4000 })])).statusCode).toBe(201);
    const j = await served(b);
    expect(j.rows.map((x) => x.domain)).toEqual([name(0)]);
    expect(j.rows[0]!.prior_kill).toMatchObject({ kill_stage: 'tier_a', price_cents_at_kill: 4000, reshow_reason: 'price_halved' });
    expect(j.rows[0]!.prior_kill!.killed_at).toMatch(/\+0[23]:00$/);
    expect(j).toMatchObject({ total: 1, prior_kill_excluded_n: 1 });
  });

  it('CR101-T5: a meaning_shape kill is not re-shown when the price halves; a price-less tier_b kill neither', async () => {
    const { b } = await setup();
    await seed(2, { price: () => 500 });
    await post(b, [kill(0, { kill_stage: 'meaning_shape', price_cents_at_kill: 4000 }), kill(1, { kill_stage: 'tier_b' })]);
    expect(await served(b)).toMatchObject({ total: 0, prior_kill_excluded_n: 2, rows: [] });
  });

  it('CR101-T6: TTL: a kill older than 90 days is served again with ttl, 89 days is not', async () => {
    const { b } = await setup();
    await seed(2);
    await post(b, [kill(0, { killed_at: new Date(NOW - 91 * DAY).toISOString(), data_date_at_kill: '2026-08-04' }), kill(1, { killed_at: new Date(NOW - 89 * DAY).toISOString(), data_date_at_kill: '2026-08-06' })]);
    const j = await served(b);
    expect(j.rows.map((x) => [x.domain, x.prior_kill?.reshow_reason])).toEqual([[name(0), 'ttl']]);
    expect(j.prior_kill_excluded_n).toBe(1);
    // the TTL is a migration setting
    await sql`update settings set shortlist_kill_ttl_days = 30`.execute(db);
    expect((await served(b)).rows).toHaveLength(2);
  });

  it('CR101-T7: a revoked row that supersedes a kill makes the name served again (without prior_kill); GET /auctions/kills shows revoked_by; an older kill of the same name still blocks', async () => {
    const { b } = await setup();
    await seed(3);
    const a = (await post(b, [kill(0), kill(1), kill(1, { kill_stage: 'meaning_shape' })])).json();
    const ids = a.ids as { row: number; id: number }[];
    const rev = await post(b, [{ domain: name(0), kill_stage: 'revoked', supersedes: ids[0]!.id, data_date_at_kill: '2026-11-03', run_id: 'pack-2', killed_at: new Date(NOW - HOUR).toISOString(), kill_detail: 'wrong kill' }]);
    expect(rev.statusCode, rev.body).toBe(201);
    // name(1) has two kills; revoking only one leaves the other blocking
    await post(b, [{ domain: name(1), kill_stage: 'revoked', supersedes: ids[1]!.id, data_date_at_kill: '2026-11-03', run_id: 'pack-2', killed_at: new Date(NOW - HOUR).toISOString() }]);
    const j = await served(b);
    expect(j.rows.map((x) => x.domain)).toEqual([name(0), name(2)]);
    expect(j.rows.every((x) => x.prior_kill === null)).toBe(true);
    expect(j.prior_kill_excluded_n).toBe(1);
    const list = (await get(`/auctions/kills?domain=${name(0)}`, b)).json();
    expect(list.rows.map((x: { kill_stage: string; revoked_by: number | null }) => [x.kill_stage, x.revoked_by === null])).toEqual([['revoked', true], ['prior_exclude', false]]);
    // a revoke of a missing id, of a revoke row, of another name, and without supersedes is rejected
    const bad = await post(b, [
      { domain: name(0), kill_stage: 'revoked', supersedes: 99999, data_date_at_kill: '2026-11-03', run_id: 'p', killed_at: new Date(NOW).toISOString() },
      { domain: name(2), kill_stage: 'revoked', supersedes: ids[0]!.id, data_date_at_kill: '2026-11-03', run_id: 'p', killed_at: new Date(NOW).toISOString() },
      { domain: name(2), kill_stage: 'revoked', data_date_at_kill: '2026-11-03', run_id: 'p', killed_at: new Date(NOW).toISOString() },
      { domain: name(2), kill_stage: 'hold', supersedes: ids[0]!.id, data_date_at_kill: '2026-11-03', run_id: 'p', killed_at: new Date(NOW).toISOString() },
    ]);
    expect(bad.json().rejects.map((x: { reason: string }) => x.reason)).toEqual(['SUPERSEDES_NOT_FOUND', 'SUPERSEDES_DOMAIN_MISMATCH', 'SUPERSEDES_REQUIRED', 'SUPERSEDES_ONLY_FOR_REVOKED']);
  });

  it('CR101-T8: append-only: UPDATE, DELETE and TRUNCATE raise; a duplicate post is counted and stores no row', async () => {
    const { b } = await setup();
    await seed(2);
    await post(b, [kill(0)]);
    await expect(sql`update auction_kills set run_id = 'x'`.execute(db)).rejects.toThrow();
    await expect(sql`delete from auction_kills`.execute(db)).rejects.toThrow();
    await expect(sql`truncate auction_kills`.execute(db)).rejects.toThrow();
    const dup = await post(b, [kill(0, { run_id: 'pack-other' }), kill(1), kill(1)]);
    expect(dup.json()).toMatchObject({ accepted_n: 1, duplicate_n: 2, rejected_n: 0 });
    expect(Number((await sql<{ n: string }>`select count(*)::text as n from auction_kills`.execute(db)).rows[0]!.n)).toBe(2);
  });

  it('CR101-T9: validation: "@" in kill_detail is 422 NO_PII; a non-.com row is rejected TLD_NOT_SUPPORTED; more than 2,000 rows is 422; a data token GET is 403; READ and data tokens cannot POST; the 70% size guard applies', async () => {
    const { w, b, d, r } = await setup();
    const pii = await post(b, [kill(0, { kill_detail: 'ask me@example.com' })]);
    expect(pii.statusCode).toBe(422);
    expect(pii.json().error.code).toBe('NO_PII');
    const mixed = await post(w, [kill(0), { ...kill(1), domain: 'killname1.net' }, kill(2, { kill_stage: 'nope' }), kill(3, { price_cents_at_kill: 0 }), kill(4, { data_date_at_kill: '2027-01-01' }), kill(5, { killed_at: 'yesterday' })]);
    expect(mixed.statusCode).toBe(201);
    expect(mixed.json()).toMatchObject({ accepted_n: 1, rejected_n: 5 });
    expect(mixed.json().rejects.map((x: { reason: string }) => x.reason)).toEqual(['TLD_NOT_SUPPORTED', 'KILL_STAGE_INVALID', 'PRICE_INVALID', 'DATE_IN_FUTURE', 'KILLED_AT_INVALID']);
    const big = await post(b, Array.from({ length: 2001 }, (_, i) => kill(i)));
    expect(big.statusCode).toBe(422);
    expect((await post(b, Array.from({ length: 2000 }, (_, i) => kill(i + 10)))).statusCode).toBe(201);
    expect((await get('/auctions/kills', d)).statusCode).toBe(403);
    expect((await post(d, [kill(0)])).statusCode).toBe(403);
    expect((await post(r, [kill(0)])).statusCode).toBe(403);
    expect((await get('/auctions/kills', r)).statusCode).toBe(200);
    expect((await app!.inject({ method: 'POST', url: '/auctions/kills', headers: { 'idempotency-key': randomUUID() }, payload: { rows: [kill(0)] } })).statusCode).toBe(401);
    expect((await app!.inject({ method: 'POST', url: '/auctions/kills', headers: { ...b, 'idempotency-key': randomUUID() }, payload: { rows: [kill(0)], extra: 1 } })).statusCode).toBe(422);
    await app!.close();
    const limit = 1024 ** 3;
    app = await makeApp({ now: () => NOW, engineDbSize: { bytes: async () => limit * 0.74 } });
    const small = await post(b, [kill(300)]);
    expect(small.statusCode).toBe(409);
    expect(small.json().error).toMatchObject({ code: 'DB_SIZE_HIGH', details: { stop_percent: 70 } });
  });

  it('CR101-T10: limit and offset page over the filtered list, no row on two pages, total is the filtered count; GET /auctions/kills pages too', async () => {
    const { b } = await setup();
    await seed(40);
    await post(b, Array.from({ length: 10 }, (_, i) => kill(i * 4)));
    const all = await served(b);
    expect(all).toMatchObject({ total: 30, prior_kill_excluded_n: 10 });
    const seen: string[] = [];
    for (let off = 0; off < 30; off += 12) {
      const p = (await get(`/auctions/shortlist?date=${DATE}&limit=12&offset=${off}`, b)).json() as { total: number; rows: SRow[] };
      expect(p.total).toBe(30);
      seen.push(...p.rows.map((x) => x.domain));
    }
    expect(seen).toEqual(all.rows.map((x) => x.domain));
    expect(new Set(seen).size).toBe(30);
    const k1 = (await get('/auctions/kills?limit=4&offset=0', b)).json();
    const k2 = (await get('/auctions/kills?limit=4&offset=8', b)).json();
    expect(k1).toMatchObject({ total: 10, count: 4 });
    expect(k2.count).toBe(2);
    expect((await get(`/auctions/kills?since=2030-01-01`, b)).json().total).toBe(0);
  });

  it('CR101-T11: perf: 10,000 stored rows and 5,000 kills, GET /auctions/shortlist p95 under 800 ms', async () => {
    const { b } = await setup();
    await seed(10_000);
    for (let i = 0; i < 5000; i += 2000) await post(b, Array.from({ length: Math.min(2000, 5000 - i) }, (_, k) => kill(i + k * 1)));
    const ms: number[] = [];
    for (let i = 0; i < 12; i++) {
      const t = performance.now();
      const res = await get(`/auctions/shortlist?date=${DATE}&limit=100&offset=${i * 50}`, b);
      ms.push(performance.now() - t);
      expect(res.statusCode).toBe(200);
    }
    expect(res0(ms)).toBeLessThan(800);
    const j = (await get(`/auctions/shortlist?date=${DATE}&limit=10000`, b)).json();
    expect(j).toMatchObject({ total: 5000, prior_kill_excluded_n: 5000 });
  }, 60_000);

  it('CR101-T12: the funnel counts the served names left out for a kill; the existing shortlist routes keep their answer shape (AS545-19..20, CR088-AT2 run in auction-shortlist.test.ts)', async () => {
    const { b } = await setup();
    await seed(6);
    await post(b, [kill(0), kill(1)]);
    const f = (await get(`/auctions/funnel?from=${DATE}&to=${DATE}`, b)).json();
    expect(f.shortlisted).toMatchObject({ names: 6, served: 6, prior_kill_excluded: 2 });
    expect((await get('/auctions/shortlist', b)).json()).toMatchObject({ data_date: DATE, total: 4, prior_kill_excluded_n: 2 });
  });
});

function res0(ms: number[]): number { const s = [...ms].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]!; }
