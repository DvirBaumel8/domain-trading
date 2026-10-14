// v5.5.0 (CR-056 part 2): POST /score. Test IDs EN-60..EN-72.
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RdapLookup, RdapLookupFn } from '../../../src/core/rdap.js';
import { makeApp } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { FAST_TRAIN, seedEngineData, type EngineSeed } from '../../helpers/engine-data.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { issueToken } from '../../helpers/tokens.js';

const T0 = Date.parse('2026-10-14T09:00:00Z');
let now = T0;
let app: FastifyInstance | undefined;
beforeEach(() => { now = T0; });
afterEach(async () => { await app?.close(); app = undefined; });

const BOOTSTRAP = JSON.stringify({ publication: '2026-10-01T00:00:00Z', services: [[['net'], ['https://rdap.verisign.com/net/v1/']], [['org'], ['https://rdap.pir.test/']], [['ai'], ['https://rdap.ai.test/']]] });
type Fact = { created: string } | 'free';
/** A fake registry: `answers` maps "name.tld" to a creation date or free; anything else is not registered. */
function registry(answers: Record<string, Fact> = {}, delayMs = 0) {
  const asked: string[] = [];
  const rdapLookup: RdapLookupFn = async (domain, o) => {
    asked.push(domain);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const a = answers[domain];
    const base = { reasonCode: null, httpStatus: 200, url: `${o?.baseUrl}${domain}`, retrievedAt: new Date(now), body: null } as const;
    if (a && a !== 'free') return { ...base, outcome: 'registered', facts: { registrar: 'R', created_at: `${a.created}T00:00:00.000Z`, expires_at: null, updated_at: null, statuses: [], nameservers: [] } } as RdapLookup;
    return { ...base, outcome: 'not_registered', httpStatus: 404, facts: null } as RdapLookup;
  };
  return { asked, screening: { rdapLookup, fetch: (async () => new Response(BOOTSTRAP, { status: 200 })) as unknown as typeof globalThis.fetch } };
}

async function setup(reg = registry(), extra: Record<string, unknown> = {}) {
  app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => now, engineTrain: { ...FAST_TRAIN }, screening: reg.screening, ...extra });
  return { w: (await issueToken('write', 'gavriel')).auth, r: (await issueToken('read')).auth, reg };
}
async function trained(seedOpts = {}): Promise<{ seed: EngineSeed; w: Record<string, string>; r: Record<string, string>; reg: ReturnType<typeof registry> }> {
  const seed = await seedEngineData(db, seedOpts);
  const s = await setup();
  const res = await app!.inject({ method: 'POST', url: '/engine/train', headers: { ...s.w, 'idempotency-key': randomUUID() }, payload: {} });
  expect(res.statusCode).toBe(202);
  await app!.jobQueue.idle();
  return { seed, ...s };
}
const score = (h: Record<string, string>, payload: unknown) => app!.inject({ method: 'POST', url: '/score', headers: h, payload: payload as object });

describe('POST /score', () => {
  it('EN-60: without a model: 409 MODEL_NOT_READY', async () => {
    const { r } = await setup();
    const res = await score(r, { domains: ['septicdrone.com'] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('MODEL_NOT_READY');
  });

  it('EN-61: a READ token is enough; no Idempotency-Key, no audit row, no idempotency row; no token is 401', async () => {
    const { seed, r } = await trained();
    const auditBefore = (await db.selectFrom('audit_log').select('id').execute()).length;
    const keysBefore = (await db.selectFrom('idempotency_keys').select('key').execute()).length;
    const res = await score(r, { domains: [seed.sold[0]!.domain] });
    expect(res.statusCode, res.body).toBe(200);
    expect((await db.selectFrom('audit_log').select('id').execute()).length).toBe(auditBefore);
    expect((await db.selectFrom('idempotency_keys').select('key').execute()).length).toBe(keysBefore);
    expect((await app!.inject({ method: 'POST', url: '/score', payload: { domains: ['septicdrone.com'] } })).statusCode).toBe(401);
    // the other POSTs are untouched: a READ token still cannot train
    expect((await app!.inject({ method: 'POST', url: '/engine/train', headers: r, payload: {} })).statusCode).toBe(403);
  });

  it('EN-62: the answer has the agreed shape per name', async () => {
    const { seed, r } = await trained();
    const d = seed.sold[0]!.domain;
    const body = (await score(r, { domains: [d, seed.unsold[0]!] })).json();
    expect(body).toMatchObject({ model_version: 'eng-1.0.1', as_of: '2026-10-14', count: 2 });
    const x = body.results[0];
    expect(Object.keys(x).sort()).toEqual(['domain', 'features', 'features_as_of', 'in_regime', 'likely_buyers', 'model_version', 'percentile_vs_dropped', 'percentile_vs_sold', 'price_tier', 'reasons', 'score'].sort());
    expect(x).toMatchObject({ domain: d, in_regime: true, features_as_of: '2026-10-14', model_version: 'eng-1.0.1' });
    expect(x.score).toBeGreaterThanOrEqual(0); expect(x.score).toBeLessThanOrEqual(1);
    expect(x.percentile_vs_dropped).toBeGreaterThanOrEqual(0); expect(x.percentile_vs_dropped).toBeLessThanOrEqual(100);
    expect(Object.keys(x.price_tier)).toEqual(['lt1k', '1k_5k', '5k_25k', 'gt25k']);
    expect(Object.values(x.price_tier as Record<string, number>).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 2);
    expect(x.reasons.length).toBeGreaterThanOrEqual(3); expect(x.reasons.length).toBeLessThanOrEqual(5);
    for (const re of x.reasons) { expect(['+', '-']).toContain(re.effect); expect(re.text.length).toBeGreaterThan(3); expect(re.feature).toBeTruthy(); }
    expect(x.features).toMatchObject({ n_words: 2, has_digit: 0, net_pit: expect.any(Number) });
    expect(x.features).toHaveProperty('acq');
    // a sold-like name scores above a dropped-like name
    expect(body.results[0].score).toBeGreaterThan(body.results[1].score);
  });

  it('EN-63: the same input twice gives identical output (bar 5), also in another order of the names', async () => {
    const { seed, r } = await trained();
    const names = seed.sold.slice(0, 10).map((s) => s.domain).concat(seed.unsold.slice(0, 10));
    const a = await score(r, { domains: names, as_of: '2026-09-01' });
    const b = await score(r, { domains: names, as_of: '2026-09-01' });
    expect(b.body).toBe(a.body);
    const rev = (await score(r, { domains: [...names].reverse(), as_of: '2026-09-01' })).json().results as { domain: string }[];
    expect(rev.reverse()).toEqual(a.json().results);
  });

  it('EN-64: the input is checked: 1..500 .com names, a real as_of not in the future, no unknown fields', async () => {
    const { r } = await trained();
    expect((await score(r, { domains: [] })).statusCode).toBe(422);
    expect((await score(r, { domains: Array.from({ length: 501 }, (_, i) => `name${i}.com`) })).statusCode).toBe(422);
    const bad = await score(r, { domains: ['septicdrone.net'] });
    expect(bad.statusCode).toBe(422); expect(bad.json().error.code).toBe('TLD_NOT_SUPPORTED');
    expect((await score(r, { domains: ['a.b.com'] })).json().error.code).toBe('DOMAIN_INVALID');
    expect((await score(r, { domains: ['septicdrone.com'], as_of: '2026-10-15' })).statusCode).toBe(422);
    expect((await score(r, { domains: ['septicdrone.com'], as_of: '2026-02-30' })).statusCode).toBe(422);
    expect((await score(r, { domains: ['septicdrone.com'], extra: 1 })).statusCode).toBe(422);
    expect((await score(r, { domains: ['Septicdrone.COM'] })).json().results[0].domain).toBe('septicdrone.com');
  });

  it('EN-65: outside the regime the score is still returned, with in_regime false and a warning', async () => {
    const { r } = await trained();
    const x = (await score(r, { domains: ['abc123xyz.com', 'septicdrone.com'] })).json().results;
    expect(x[0]).toMatchObject({ in_regime: false, warning: expect.stringContaining('Outside the regime') });
    expect(x[0].score).toBeGreaterThanOrEqual(0);
    expect(x[1]).not.toHaveProperty('warning');
  });

  it('EN-66: likely buyers: the same name on other endings registered before as_of, from the stored RDAP answers; PIT by as_of', async () => {
    const { seed, r } = await trained();
    const sld = seed.sold[0]!.domain.replace('.com', '');
    await db.insertInto('engine_endings').values({ name: sld, tld: 'org', registered: true, created_at_registry: new Date('2019-04-02T00:00:00Z'), checked_at: new Date('2026-10-13T00:00:00Z'), http_status: 200, reason_code: null, evidence: null }).execute();
    await db.insertInto('engine_endings').values({ name: sld, tld: 'ai', registered: true, created_at_registry: new Date('2026-09-30T00:00:00Z'), checked_at: new Date('2026-10-13T00:00:00Z'), http_status: 200, reason_code: null, evidence: null }).execute();
    const now14 = (await score(r, { domains: [seed.sold[0]!.domain] })).json().results[0];
    const hosts = now14.likely_buyers.map((b: { host: string }) => b.host);
    expect(hosts).toContain(`${sld}.org`); expect(hosts).toContain(`${sld}.ai`);
    expect(now14.likely_buyers.find((b: { host: string }) => b.host === `${sld}.org`)).toEqual({ host: `${sld}.org`, registered: '2019-04-02', source: 'rdap' });
    const earlier = (await score(r, { domains: [seed.sold[0]!.domain], as_of: '2026-09-01' })).json().results[0];
    const eh = earlier.likely_buyers.map((b: { host: string }) => b.host);
    expect(eh).toContain(`${sld}.org`); expect(eh).not.toContain(`${sld}.ai`); // registered after that as_of
    expect(earlier.features.ai_pit).toBe(0);
    const before2018 = (await score(r, { domains: [seed.sold[0]!.domain], as_of: '2017-01-01' })).json().results[0];
    expect(before2018.likely_buyers).toEqual([]); expect(before2018.features.org_pit).toBe(0);
  });

  it('EN-67: live_business appears on a buyer only when the newest sibling scan of the name has it', async () => {
    const { seed, r } = await trained();
    const d = seed.sold[0]!.domain; const sld = d.replace('.com', '');
    await db.insertInto('engine_endings').values({ name: sld, tld: 'org', registered: true, created_at_registry: new Date('2019-04-02T00:00:00Z'), checked_at: new Date('2026-10-13T00:00:00Z'), http_status: 200, reason_code: null, evidence: null }).execute();
    const before = (await score(r, { domains: [d] })).json().results[0];
    expect(before.likely_buyers.find((b: { host: string }) => b.host === `${sld}.org`)).not.toHaveProperty('live_business');
    await db.insertInto('sibling_scans').values({
      domain: d, fetched_at: new Date('2026-10-13T00:00:00Z'), settings_label: 'v1', siblings: JSON.stringify([{ domain: `${sld}.org`, live_business: true }, { domain: `${sld}.net`, live_business: null }]),
      lead_points: JSON.stringify({}), complete: true, upstream_calls: 1, evidence_ids: '[]', recorded_by: 'test',
    }).execute();
    const after = (await score(r, { domains: [d] })).json().results[0];
    expect(after.likely_buyers.find((b: { host: string }) => b.host === `${sld}.org`).live_business).toBe(true);
  });

  it('EN-68: a name with no stored answers is asked live (all six endings), the answers are cached in engine_endings, and the next call asks nothing', async () => {
    const reg = registry({ 'freshnamehere.net': { created: '2018-06-01' }, 'freshnamehere.com': { created: '2025-12-01' } });
    const seed = await seedEngineData(db);
    const s = await setup(reg);
    await app!.inject({ method: 'POST', url: '/engine/train', headers: { ...s.w, 'idempotency-key': randomUUID() }, payload: {} });
    await app!.jobQueue.idle();
    const one = (await score(s.r, { domains: ['freshnamehere.com'] })).json().results[0];
    expect(reg.asked.sort()).toEqual(['freshnamehere.ai', 'freshnamehere.co', 'freshnamehere.com', 'freshnamehere.io', 'freshnamehere.net', 'freshnamehere.org']);
    expect(one.likely_buyers).toEqual([{ host: 'freshnamehere.net', registered: '2018-06-01', source: 'rdap' }]);
    expect(one.features).toMatchObject({ net_pit: 1, co_pit: 0, n_endings_pit: 1, acq: 'handreg' });
    const rows = await db.selectFrom('engine_endings').selectAll().where('name', '=', 'freshnamehere').execute();
    expect(rows).toHaveLength(6);
    const before = reg.asked.length;
    const two = (await score(s.r, { domains: ['freshnamehere.com'] })).json().results[0];
    expect(reg.asked.length).toBe(before);
    expect(two).toEqual(one);
    void seed;
  });

  it('EN-69: names the registry did not answer in time stay unknown (null), never guessed; the others are answered', async () => {
    const reg = registry({}, 120);
    const { w } = await setup(reg, { engineScore: { budgetMs: 40 } });
    await seedEngineData(db);
    await app!.inject({ method: 'POST', url: '/engine/train', headers: { ...w, 'idempotency-key': randomUUID() }, payload: {} });
    await app!.jobQueue.idle();
    const r = (await issueToken('read')).auth;
    const names = Array.from({ length: 12 }, (_, i) => `latecomer${String.fromCharCode(97 + i)}.com`);
    const t0 = Date.now();
    const res = (await score(r, { domains: names })).json();
    expect(Date.now() - t0).toBeLessThan(3000);
    const nets = res.results.map((x: { features: { net_pit: number | null } }) => x.features.net_pit);
    expect(nets.some((v: number | null) => v === 0)).toBe(true); // the first asks were answered (not registered)
    expect(nets.some((v: number | null) => v === null)).toBe(true); // the rest ran out of time
    expect(res.results.every((x: { score: number }) => typeof x.score === 'number')).toBe(true);
    // unanswered pairs have no row; answered ones are stored
    const stored = await db.selectFrom('engine_endings').select('name').where('name', 'like', 'latecomer%').execute();
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.length).toBeLessThan(12 * 6);
  });

  it('EN-70: 20 names with stored answers answer within 5 seconds (bar 5)', async () => {
    const { seed, r } = await trained();
    const names = seed.sold.slice(0, 10).map((x) => x.domain).concat(seed.unsold.slice(0, 10));
    const t0 = Date.now();
    const res = await score(r, { domains: names });
    expect(res.statusCode).toBe(200);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});
