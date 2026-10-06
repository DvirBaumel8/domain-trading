// CAP-24 rule tier and DEMAND-2 (CR-002) with the CAP-21 missing-data rule: a missing input is unknown, never a pass or a fail.
import { describe, expect, it } from 'vitest';
import { DEFAULT_SELECTION_VALUES as D } from '../../src/screening/settings.js';
import { evaluateTier, type TierFeatures } from '../../src/screening/tier.js';

const F = (o: Partial<TierFeatures>): TierFeatures => ({
  registered_share: null, prior_history: null, alt_tld_before_n: null, n_words: null, sld_chars: null, is_geo: 0, gform1_pass: null, short: null, ...o,
});
const run = (f: TierFeatures, thresholds = D.thresholds) => evaluateTier(f, D.tier, thresholds);

describe('CAP-24 acceptance (CR-002)', () => {
  it('netextend.com (share 0.65, prior 1, alt 0, 2 words): tier A, DEMAND-2 PASS, clause A fired', () => {
    const r = run(F({ registered_share: 0.65, prior_history: 1, alt_tld_before_n: 0, n_words: 2 }));
    expect([r.tier, r.demand2, r.fired, r.tier_exact]).toEqual(['A', 'PASS', 'A', true]);
    expect(r.clauses).toEqual({ A: 'true', I: 'true', B: 'true', G: 'false' });
  });

  it('limemob and dentstorm stay known false positives: share >= 0.5 with prior history is PASS (regression fixtures)', () => {
    for (const share of [0.5, 0.55, 0.7]) {
      expect(run(F({ registered_share: share, prior_history: 1, alt_tld_before_n: 0, n_words: 2 })).demand2).toBe('PASS');
    }
  });

  it('boutworld and techaipost (share < 0.5, prior 1, alt 0, 3+ words) stay known false negatives: FAIL', () => {
    for (const share of [0.35, 0.45]) {
      const r = run(F({ registered_share: share, prior_history: 1, alt_tld_before_n: 0, n_words: 3 }));
      expect([r.tier, r.demand2, r.fired]).toEqual(['none', 'FAIL', null]);
    }
  });

  it('share unknown with alt_tld_before_n 2: tier I PASS, not exact (tier A could still have applied)', () => {
    const r = run(F({ registered_share: null, prior_history: 1, alt_tld_before_n: 2, n_words: 2 }));
    expect([r.tier, r.demand2, r.tier_exact, r.clauses.A]).toEqual(['I', 'PASS', false, 'unknown']);
  });

  it('share unknown with alt_tld_before_n 0: UNKNOWN', () => {
    const r = run(F({ registered_share: null, prior_history: 1, alt_tld_before_n: 0, n_words: 2 }));
    expect([r.tier, r.demand2]).toEqual(['none', 'UNKNOWN']);
  });

  it('history unknown, share 0.40, alt 0: FAIL (decided: no tier can apply either way)', () => {
    const r = run(F({ registered_share: 0.4, prior_history: null, alt_tld_before_n: 0, n_words: 3 }));
    expect([r.tier, r.demand2]).toEqual(['none', 'FAIL']);
  });

  it('history unknown, share 0.55, alt 0, 3 words: UNKNOWN (history could make it tier A)', () => {
    const r = run(F({ registered_share: 0.55, prior_history: null, alt_tld_before_n: 0, n_words: 3 }));
    expect([r.tier, r.demand2, r.clauses.A, r.clauses.B]).toEqual(['none', 'UNKNOWN', 'unknown', 'false']);
  });

  it('hvacchicago.com (geo, G-FORM-1 passes, share unknown): tier G PASS', () => {
    const r = run(F({ is_geo: 1, gform1_pass: 1, n_words: 2, sld_chars: 11 }));
    expect([r.tier, r.demand2, r.fired]).toEqual(['G', 'PASS', 'G']);
  });

  it('a geo name that fails G-FORM-1 is not tier G', () => {
    expect(run(F({ is_geo: 1, gform1_pass: 0, registered_share: 0.1, prior_history: 0, alt_tld_before_n: 0, n_words: 4 })).demand2).toBe('FAIL');
  });

  it('tier B needs share >= 0.60 and at most 2 words', () => {
    const base = { registered_share: 0.62, prior_history: 0 as const, alt_tld_before_n: 0, n_words: 2 };
    expect(run(F(base)).tier).toBe('B');
    expect(run(F({ ...base, n_words: 3 })).tier).toBe('none');
    expect(run(F({ ...base, registered_share: 0.55 })).tier).toBe('none');
  });

  it('CAP-00 acceptance: a setting changes the decision without a code change', () => {
    const f = F({ registered_share: 0.65, prior_history: 1, alt_tld_before_n: 0, n_words: 3 });
    expect(run(f).tier).toBe('A');
    const r = run(f, { ...D.thresholds, registered_share_min: 0.7 });
    expect([r.tier, r.demand2]).toEqual(['none', 'FAIL']);
  });

  it('echoes its inputs', () => {
    const f = F({ registered_share: 0.65, prior_history: 1 });
    expect(run(f).inputs).toBe(f);
  });
});

describe('tier DSL mechanics', () => {
  it('all = false beats unknown; any = true beats unknown', () => {
    const tier = {
      ...D.tier, order: ['A', 'B'] as ('A' | 'B')[], demand2_pass_tiers: ['A', 'B'] as ('A' | 'B')[],
      clauses: {
        A: { all: [{ f: 'registered_share', op: '>=', v: 0.5 }, { f: 'prior_history', op: '==', v: 1 }] },
        B: { any: [{ f: 'registered_share', op: '>=', v: 0.5 }, { f: 'prior_history', op: '==', v: 1 }] },
      },
    } as typeof D.tier;
    const r = evaluateTier(F({ registered_share: 0.2 }), tier, {});
    expect([r.clauses.A, r.clauses.B]).toEqual(['false', 'unknown']);
    const r2 = evaluateTier(F({ prior_history: 1 }), tier, {});
    expect([r2.clauses.A, r2.clauses.B, r2.tier, r2.tier_exact]).toEqual(['unknown', 'true', 'B', false]);
  });

  it('every operator', () => {
    const mk = (op: string, v: number) => ({ ...D.tier, order: ['A'] as 'A'[], demand2_pass_tiers: ['A'] as 'A'[], clauses: { A: { all: [{ f: 'n_words', op, v }] } } }) as typeof D.tier;
    const t = (op: string, v: number) => evaluateTier(F({ n_words: 2 }), mk(op, v), {}).tier;
    expect([t('>=', 2), t('>', 2), t('<=', 2), t('<', 2), t('==', 2), t('!=', 2)]).toEqual(['A', 'none', 'A', 'none', 'A', 'none']);
  });
});
