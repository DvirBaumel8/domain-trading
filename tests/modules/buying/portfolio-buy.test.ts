// v4.0.0: CR-045 item 2 (horizon at /buy), item 3 (cap 40, screening group), CR-046 item 3 (renewal maths: stre, RENEWAL_MATH_FAIL), CR-048 (LTO by name type).
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RdapFn } from '../../../src/core/rdap.js';
import { addMonthsClamped, idtDay } from '../../../src/core/dates.js';
import { renewalMath } from '../../../src/modules/buying/renewal-math.js';
import { makeApp } from '../../helpers/app.js';
import { DOMAIN, T0, approvalNow, buyBody, postBuy, readyToBuy, seedOwnedDomains } from '../../helpers/buy.js';
import { testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { issueToken } from '../../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const rdapFree: RdapFn = async () => 'not_registered';
async function setup(adapters: FakeAdapter[] = [new FakeAdapter('porkbun')]) {
  app = await makeApp({ adapters, rdap: rdapFree, now: () => T0 });
  return (await issueToken('write')).auth;
}
const dom = (d = DOMAIN) => db.selectFrom('domains').selectAll().where('domain', '=', d).executeTakeFirstOrThrow();

describe('v4.0.0 /buy: renewal maths (CR-046 item 3)', () => {
  it('RM-1: stre or stre_reason missing is 400 VALIDATION_ERROR, nothing is called', async () => {
    const pb = new FakeAdapter('porkbun');
    const auth = await setup([pb]);
    for (const drop of ['stre', 'stre_reason']) {
      const body: Record<string, unknown> = buyBody({ dry_run: true });
      delete body[drop];
      const res = await postBuy(app, body, auth);
      expect(res.statusCode, drop).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    }
    expect(pb.calls).toEqual([]);
  });

  it('RM-2: a ratio under buy.renewal_math_min (1.0) is 422 RENEWAL_MATH_FAIL with the numbers, also in a dry run', async () => {
    const pb = new FakeAdapter('porkbun');
    const auth = await setup([pb]);
    const res = await postBuy(app, buyBody({ dry_run: true, stre: 0.0001 }), auth);
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.code).toBe('RENEWAL_MATH_FAIL');
    // geo weaker BIN $399 x (1 - 20%) x 0.0001 / $11.08 renewal
    expect(res.json().error.details.renewal_math).toMatchObject({ venue: 'afternic', bin_cents: 39900, commission_bp: 2000, stre_bp: 1, renewal_cents: 1108, pass: false, min: 1 });
    const real = await postBuy(app, buyBody({ stre: 0.0001 }), auth);
    expect(real.json().error.code).toBe('RENEWAL_MATH_FAIL');
    expect(pb.calls.filter((c) => c.startsWith('register'))).toEqual([]);
    expect(await db.selectFrom('domains').selectAll().execute()).toHaveLength(0);
  });

  it('RM-3: a passing ratio is shown in the dry run and the 201, and stored on the name with STRe and its reason', async () => {
    const auth = await setup();
    const dry = await postBuy(app, buyBody({ dry_run: true }), auth);
    expect(dry.statusCode, dry.body).toBe(200);
    expect(dry.json().renewal_math).toMatchObject({ pass: true, bin_cents: 39900, stre_bp: 500, expected_net_cents: 1596, ratio: 1.44 });
    const res = await postBuy(app, buyBody(), auth);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().renewal_math).toMatchObject({ pass: true });
    const d = await dom();
    expect(d.buy_card).toMatchObject({ stre_bp: 500, stre_reason: 'fixture: a thin search market', renewal_math: { pass: true, venue: 'afternic' } });
  });

  it('RM-4: the arithmetic is integer: ratio = BIN x (1 - commission) x STRe / renewal, the commission is an input (not hard-coded)', () => {
    expect(renewalMath({ binCents: 148800, commission: 0.2, stre: 0.02, renewalCents: 1108, min: 1, venue: 'afternic' })).toMatchObject({ expected_net_cents: 2381, ratio: 2.15, pass: true, commission_bp: 2000, stre_bp: 200 });
    expect(renewalMath({ binCents: 148800, commission: 0.9, stre: 0.02, renewalCents: 1108, min: 1, venue: 'x' })).toMatchObject({ commission_bp: 9000, pass: false });
    expect(renewalMath({ binCents: 148800, commission: 0.1, stre: 0.01, renewalCents: 1488, min: 1, venue: 'sellerhub' })).toMatchObject({ ratio: 0.9, pass: false });
  });
});

describe('v4.0.0 /buy: horizon, group, cap (CR-045)', () => {
  it('HZ-1: horizon is optional and defaults to evergreen; trend is stored with sell_or_drop_by = buy date + 12 months', async () => {
    const auth = await setup();
    const res = await postBuy(app, buyBody({ horizon: 'trend', drop_policy: 'at_first_expiry' }), auth);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ horizon: 'trend', screening_group: 'passed' });
    const d = await dom();
    expect(d.horizon).toBe('trend');
    expect(d.sell_or_drop_by).toBe(addMonthsClamped(idtDay(new Date(T0)), 12));
    expect(d.drop_date).toBe(d.expiry_date);
  });

  it('HZ-2: a trend or regulation name with drop_policy after_one_renewal gets the HORIZON_DROP_POLICY_MISMATCH warning', async () => {
    const auth = await setup();
    const res = await postBuy(app, buyBody({ dry_run: true, horizon: 'regulation' }), auth);
    expect(res.json().warnings.some((w: string) => w.startsWith('HORIZON_DROP_POLICY_MISMATCH'))).toBe(true);
    const ok = await postBuy(app, buyBody({ dry_run: true, horizon: 'regulation', drop_policy: 'at_first_expiry' }), auth);
    expect(ok.json().warnings.some((w: string) => w.startsWith('HORIZON_DROP_POLICY_MISMATCH'))).toBe(false);
    const evergreen = await postBuy(app, buyBody({ dry_run: true }), auth);
    expect(evergreen.json().horizon).toBe('evergreen');
    expect(evergreen.json().warnings.some((w: string) => w.startsWith('HORIZON_DROP_POLICY_MISMATCH'))).toBe(false);
  });

  it('LTO-1 (CR-048): lto_max_months is 422 LTO_NOT_ALLOWED on a trend name, on a first-expiry drop, and passes the horizon rule on an evergreen name', async () => {
    const auth = await setup();
    const listing = { mode: 'hybrid', bin: 1488, lto_max_months: 12 };
    const trend = await postBuy(app, buyBody({ dry_run: true, category: 'trend', price_grade: null, horizon: 'trend', proposed_listing: listing, override: true, override_reason: 'x' }), auth);
    expect(trend.statusCode, trend.body).toBe(422);
    expect(trend.json().error.code).toBe('LTO_NOT_ALLOWED');
    const first = await postBuy(app, buyBody({ dry_run: true, category: 'trend', price_grade: null, drop_policy: 'at_first_expiry', proposed_listing: listing, override: true, override_reason: 'x' }), auth);
    expect(first.json().error.code).toBe('LTO_NOT_ALLOWED');
    const ever = await postBuy(app, buyBody({ dry_run: true, category: 'trend', price_grade: null, proposed_listing: listing }), auth);
    // an evergreen name reaches the existing rules: lease-to-own still needs an override (not the horizon refusal)
    expect(ever.json().error?.message ?? '').not.toMatch(/drops at its first expiry/);
  });

  it('CAP-40-1: with 40 names held a real buy is 409 DOMAIN_CAP_REACHED (max_domains 40) and a dry run reports would_be_blocked', async () => {
    const pb = new FakeAdapter('porkbun');
    const auth = await setup([pb]);
    await readyToBuy(DOMAIN);
    await seedOwnedDomains(40);
    const dry = await postBuy(app, buyBody({ dry_run: true }), auth);
    expect(dry.statusCode, dry.body).toBe(200);
    expect(dry.json().would_be_blocked).toBe('DOMAIN_CAP_REACHED');
    const strict = await postBuy(app, buyBody({ dry_run: 'strict' }), auth);
    expect(strict.json().error.code).toBe('DOMAIN_CAP_REACHED');
    const real = await postBuy(app, buyBody(), auth);
    expect(real.statusCode).toBe(409);
    expect(real.json().error).toMatchObject({ code: 'DOMAIN_CAP_REACHED', details: { domains: 40, max_domains: 40 } });
    expect(pb.calls.filter((c) => c.startsWith('register') && !c.includes('dry=true'))).toEqual([]);
  });

  it('CAP-40-2: the migration set the cap to 40', async () => {
    expect((await db.selectFrom('settings').select('max_domains').executeTakeFirstOrThrow()).max_domains).toBe(40);
  });

  it('GRP-1: the screening group is borderline when the name\'s latest run holds a FLAG result, else passed', async () => {
    const auth = await setup();
    const ready = await readyToBuy(DOMAIN);
    await db.insertInto('screening_results').values({
      run_id: ready.runId, item_idx: 0, domain: DOMAIN, lane: 'S3', check_id: 'history', gate: 'G3', rule_ids: ['X'], status: 'FLAG', reason_code: 'WEAK_HISTORY', reason: 'seeded',
      fields: '{}', checked_at: new Date(T0 - 7_200_000), settings_label: 'v1', list_versions: '{}', duration_ms: 0, upstream_calls: 0, source: 'auto',
    }).execute();
    const res = await postBuy(app, buyBody({ approval_ref: approvalNow() }), auth, undefined, { ready: false });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().screening_group).toBe('borderline');
    expect((await dom()).screening_group).toBe('borderline');
  });
});

describe('CR-051 B-1: screening group without a pack', () => {
  it('GRP-2: a name with no screening pack is in neither test group (null)', async () => {
    const { screeningGroupOf } = await import('../../../src/modules/buying/renewal-math.js');
    const { testDb } = await import('../../helpers/db.js');
    expect(await screeningGroupOf(testDb, 'neverscreened-cr051.com')).toBeNull();
  });
});
