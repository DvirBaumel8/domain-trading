// POST /selection/evaluate: pure tier + money evaluation. CR-002 §5.3 fixture and the SEL5-2 forbidden-feature rule.
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { makeApp } from '../helpers/app.js';
import { testDb as db } from '../helpers/db.js';
import { createV3 } from '../helpers/pricing.js';
import { issueToken } from '../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());

async function setup() {
  let clock = Date.now();
  app = await makeApp({ now: () => clock });
  const w = await issueToken('write', 'gavriel');
  const post = (payload: unknown, url = '/selection/evaluate') => (clock += 7_000, app.inject({ method: 'POST', url, headers: { ...w.auth, 'idempotency-key': randomUUID() }, payload: payload as object }));
  return { post, w, tick: () => (clock += 7_000) };
}
const tierA = { lane: 'S3', features: { registered_share: 0.65, prior_history: 1, alt_tld_before_n: 0, n_words: 2, sld_chars: 9 }, leads_ab: 0, bin_usd: 1488, first_year_usd: 11.08, renewal_usd: 11.08 };
const near = (x: number, y: number) => expect(Math.abs(x - y)).toBeLessThanOrEqual(0.02);

describe('POST /selection/evaluate', () => {
  it('CR-002 §5.3 fixture over HTTP: tier A at $1,488, 0 leads -> ratio 2.28 / 1.48, EV +$27.9', async () => {
    const { post } = await setup();
    await createV3(db);
    const res = await post(tierA);
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect([b.settings_version, b.backtest, b.pricing_version, b.bin_cents, b.warnings]).toEqual(['v1', false, 3, 148800, []]);
    expect([b.tier.tier, b.tier.demand2, b.tier.fired]).toEqual(['A', 'PASS', 'A']);
    near(b.money.ratio_at_bin, 2.28); near(b.money.ratio_at_floor, 1.48);
    expect(Math.abs(b.money.ev_cents / 100 - 27.9)).toBeLessThanOrEqual(0.06);
    expect(b.money).toMatchObject({
      p_passive: 0.02, floor_cents: 96700, lifetime_cost_cents: 2216, net_price_cents: 126480, bin_in_allowed_set: true, forbidden_band: false,
      lander1: { pass: true, reason: null }, passes: { ev1: true, ratio1: true, lander1: true },
      display: { bin: '$1,488.00', floor: '$967.00', net_price: '$1,264.80', lifetime_cost: '$22.16', ev: '$27.93' },
    });
    expect(b.money.model_version).toBe('selection:v1/pricing:v3');
  });

  it('the same name with tier B (share 0.62, prior 0): ratios halve', async () => {
    const { post } = await setup();
    await createV3(db);
    const b = (await post({ ...tierA, features: { registered_share: 0.62, prior_history: 0, alt_tld_before_n: 0, n_words: 2 } })).json();
    expect(b.tier.tier).toBe('B');
    near(b.money.ratio_at_bin, 1.14); near(b.money.ratio_at_floor, 0.74);
  });

  it('missing BIN: non-geo uses nongeo_default_bin_cents of the current pricing; geo uses the grade price (weaker $399)', async () => {
    const { post } = await setup();
    await createV3(db);
    const { bin_usd: _b, ...noBin } = tierA;
    expect((await post(noBin)).json().bin_cents).toBe(148800);
    const geo = (await post({ lane: 'S2', features: { is_geo: 1, gform1_pass: 1 }, leads_ab: 12, price_grade: 'weaker', first_year_usd: 11.08, renewal_usd: 11.08 })).json();
    expect([geo.bin_cents, geo.tier.tier, geo.money.floor_cents]).toEqual([39900, 'G', 29900]);
    const dflt = (await post({ lane: 'S2', features: {}, leads_ab: 0 })).json();
    expect([dflt.bin_cents, dflt.tier.inputs.is_geo]).toEqual([49900, 1]); // price.geo_default_grade strong
  });

  it('geo ratio_at_floor uses the geo ladder bottom, not the pricing floor (which is the BIN)', async () => {
    const { post } = await setup();
    await createV3(db);
    // with gate_enabled false the lane priors would not apply to tier G; this is G at 0.01
    const b = (await post({ lane: 'S2', features: { is_geo: 1, gform1_pass: 1 }, leads_ab: 0, bin_usd: 499, renewal_usd: 11.08, first_year_usd: 11.08 })).json();
    near(b.money.ratio_at_bin, 499 * 0.85 * 0.01 / 11.08);
    near(b.money.ratio_at_floor, 299 * 0.85 * 0.01 / 11.08);
  });

  it('without a price list (pricing v2): warning PRICING_V3_MISSING; a non-geo name without a BIN -> 422 BIN_REQUIRED', async () => {
    const { post } = await setup();
    const r = await post(tierA);
    expect(r.json().warnings).toEqual(['PRICING_V3_MISSING']);
    expect(r.json().money.bin_in_allowed_set).toBeNull();
    const { bin_usd: _b, ...noBin } = tierA;
    const e = await post(noBin);
    expect([e.statusCode, e.json().error.code]).toEqual([422, 'BIN_REQUIRED']);
  });

  it('a draft version evaluates as a backtest; the active one does not', async () => {
    const { post } = await setup();
    await createV3(db);
    expect((await post({ label: 'x', set: { 'thresholds.registered_share_min': 0.7 } }, '/selection/settings')).statusCode).toBe(201);
    const mid = { ...tierA, features: { ...tierA.features, registered_share: 0.55 } };
    const back = (await post({ ...mid, settings: 'x' })).json();
    expect([back.settings_version, back.backtest, back.tier.tier, back.tier.demand2]).toEqual(['x', true, 'none', 'FAIL']);
    const live = (await post({ ...mid, settings: 'v1' })).json();
    expect([live.settings_version, live.backtest, live.tier.tier]).toEqual(['v1', false, 'A']);
    const nope = await post({ ...tierA, settings: 'zzz' });
    expect([nope.statusCode, nope.json().error.code]).toEqual([404, 'SETTINGS_NOT_FOUND']);
  });

  it('a forbidden gate feature anywhere in the body -> 422 FORBIDDEN_FEATURE before validation (SEL5-2)', async () => {
    const { post } = await setup();
    for (const body of [
      { ...tierA, govalue_usd: 3000 },
      { ...tierA, features: { ...tierA.features, estibot_value: 900 } },
      { ...tierA, extra: [{ deep: { HumbleWorth_USD: 1 } }] },
      { lane: 'nope', alexa_rank: 5 },
    ]) {
      const r = await post(body);
      expect([r.statusCode, r.json().error.code]).toEqual([422, 'FORBIDDEN_FEATURE']);
      expect(typeof r.json().error.details.path).toBe('string');
    }
  });

  it('forbidden keys are a setting: a draft that adds a key blocks it in backtests of that draft', async () => {
    const { post } = await setup();
    await post({ label: 'x', set: { 'score.forbidden_feature_keys': ['govalue_usd', 'sketchy_rank'] } }, '/selection/settings');
    const r = await post({ ...tierA, settings: 'x', sketchy_rank: 1 });
    expect([r.statusCode, r.json().error.code]).toEqual([422, 'FORBIDDEN_FEATURE']);
  });

  it('validation: strict body, lane, 3-decimal USD, null features are allowed (unknown), READ token 403', async () => {
    const { post, w } = await setup();
    await createV3(db);
    const code = async (b: unknown) => { const r = await post(b); return [r.statusCode, r.json().error?.code]; };
    expect(await code({ ...tierA, extra: 1 })).toEqual([422, 'VALIDATION_ERROR']);
    expect(await code({ ...tierA, lane: 'S5' })).toEqual([422, 'VALIDATION_ERROR']);
    expect(await code({ ...tierA, bin_usd: 1488.005 })).toEqual([422, 'VALIDATION_ERROR']);
    expect(await code({ ...tierA, leads_ab: -1 })).toEqual([422, 'VALIDATION_ERROR']);
    expect(await code({ ...tierA, features: { color: 1 } })).toEqual([422, 'VALIDATION_ERROR']);
    expect(await code({ lane: 'S3', leads_ab: 0, features: { registered_share: null, prior_history: null, alt_tld_before_n: null } })).toEqual([200, undefined]);
    const read = await issueToken('read');
    const res = await app.inject({ method: 'POST', url: '/selection/evaluate', headers: { ...read.auth, 'idempotency-key': randomUUID() }, payload: tierA });
    expect(res.statusCode).toBe(403);
    void w;
  });

  it('unknown features give UNKNOWN, never PASS: share unknown and alt 0 -> demand2 UNKNOWN; no quote -> EV and ratios null', async () => {
    const { post } = await setup();
    await createV3(db);
    const b = (await post({ lane: 'S3', features: { registered_share: null, prior_history: 1, alt_tld_before_n: 0, n_words: 2 }, leads_ab: 0 })).json();
    expect([b.tier.tier, b.tier.demand2]).toEqual(['none', 'UNKNOWN']);
    expect([b.money.ev_cents, b.money.ratio_at_bin, b.money.passes.ev1, b.money.passes.ratio1]).toEqual([null, null, null, null]);
  });

  it('form: derived from the features when absent, explicit when sent; domain gives the syllable count; the score is returned', async () => {
    const { post } = await setup();
    await createV3(db);
    const a = (await post({ ...tierA, features: { ...tierA.features, short: 1 }, domain: 'NetExtend.com' })).json();
    expect(a.money.factors.A.raw).toBe(10);
    const long = (await post({ ...tierA, features: { ...tierA.features, short: 0 }, form: { sld_len: 20, word_count: 5, short: 0 }, domain: 'netextendnetextend.com' })).json();
    expect(long.money.factors.A.raw).toBeCloseTo((1 + 2 + 4) / 3, 6); // 20 letters -> 1, 5 words -> 2, 6 vowel groups -> 4
    expect(typeof a.money.score_0_100).toBe('number');
    expect(a.money.data_coverage).toBeGreaterThan(0);
  });

  it('writes nothing but the audit row', async () => {
    const { post } = await setup();
    await post(tierA);
    expect(await db.selectFrom('selection_settings').select('id').execute()).toHaveLength(1);
    expect(await db.selectFrom('audit_log').select('path').where('path', '=', '/selection/evaluate').execute()).toHaveLength(1);
  });
});
