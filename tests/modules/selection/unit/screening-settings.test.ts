// CAP-00 settings schema: cross-field validation happens when a draft is made, never mid-run (plan Review Focus 3).
import { describe, expect, it } from 'vitest';
import { AppError } from '../../../../src/http/errors.js';
import { DEFAULT_SELECTION_VALUES as D, SelectionValues, applySet, deepEqual, type SelectionValuesT } from '../../../../src/modules/selection/settings.js';

const clone = (): SelectionValuesT => JSON.parse(JSON.stringify(D));
const issues = (v: unknown) => {
  const r = SelectionValues.safeParse(v);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};
const code = (fn: () => unknown): string => {
  try { fn(); } catch (e) { return e instanceof AppError ? e.code : String(e); }
  return 'none';
};

describe('SelectionValues', () => {
  it('accepts the defaults', () => {
    expect(issues(D)).toEqual([]);
  });

  it('is strict: an unknown key anywhere is refused', () => {
    const v = clone() as unknown as Record<string, unknown>;
    v.surprise = 1;
    expect(issues(v).length).toBeGreaterThan(0);
    const w = clone();
    (w.form as Record<string, unknown>).surprise = 1;
    expect(issues(w).length).toBeGreaterThan(0);
  });

  it('refuses an unknown $threshold', () => {
    const v = clone();
    v.tier.clauses.A = { all: [{ f: 'registered_share', op: '>=', v: '$nope' }] };
    expect(issues(v).join('\n')).toMatch(/unknown threshold \$nope/);
  });

  it('refuses an unknown tier feature', () => {
    const v = clone();
    v.tier.clauses.A = { all: [{ f: 'color', op: '==', v: 1 }] };
    expect(issues(v).join('\n')).toMatch(/unknown tier feature "color"/);
  });

  it('refuses {"tier":X} that is not an earlier tier', () => {
    const v = clone();
    v.tier.clauses.A = { any: [{ tier: 'I' }] };
    expect(issues(v).join('\n')).toMatch(/must refer to an earlier tier/);
    const w = clone();
    w.tier.clauses.I = { any: [{ tier: 'I' }] };
    expect(issues(w).join('\n')).toMatch(/earlier tier/);
  });

  it('refuses a tier in the order without a clause or a p_passive', () => {
    const v = clone();
    delete v.tier.clauses.G;
    expect(issues(v).join('\n')).toMatch(/tier G is in order but has no clause/);
    const w = clone();
    delete w.tier.p_passive.G;
    expect(issues(w).join('\n')).toMatch(/tier G has no p_passive/);
  });

  it('refuses an unknown check id in a lane gate list and in feature_checks', () => {
    const v = clone();
    v.run.gates.S3 = ['form', 'foo'];
    expect(issues(v).join('\n')).toMatch(/unknown check id "foo"/);
    const w = clone();
    w.run.feature_checks = ['census', 'bar'];
    expect(issues(w).join('\n')).toMatch(/unknown check id "bar"/);
  });

  it('refuses a feature check that is a real check but not a feature check (availability)', () => {
    const v = clone();
    v.run.feature_checks = ['census', 'availability'];
    expect(issues(v).join('\n')).toMatch(/"availability" is not a feature check/);
  });

  it('refuses a gate list for an unknown lane and a missing default', () => {
    const v = clone();
    v.run.gates.S9 = ['form'];
    expect(issues(v).join('\n')).toMatch(/unknown lane S9/);
    const w = clone();
    delete w.run.gates.default;
    expect(issues(w).join('\n')).toMatch(/needs a default list/);
  });

  it('refuses lane weights that do not sum to 100 (SEL3-1)', () => {
    const v = clone();
    v.score.weights.S3.A = 14;
    expect(issues(v).join('\n')).toMatch(/weights of S3 must sum to 100 \(they sum to 99\)/);
  });

  it('refuses an action outside PASS / FLAG / FAIL', () => {
    const v = clone() as unknown as { history: Record<string, unknown> };
    v.history.strong_action = 'REJECT';
    expect(issues(v).length).toBeGreaterThan(0);
  });

  it('refuses shares outside 0..1 and an inverted forbidden band', () => {
    const v = clone();
    v.concentration.max_lane_share = 1.5;
    expect(issues(v).length).toBeGreaterThan(0);
    const w = clone();
    w.price.forbidden_bands_cents = [[99900, 80000]];
    expect(issues(w).join('\n')).toMatch(/must be \[low, high\]/);
  });

  it('refuses a city_word_allowlist entry that is not lowercase letters', () => {
    const v = clone();
    v.form.city_word_allowlist = ['Tulsa'];
    expect(issues(v).length).toBeGreaterThan(0);
  });
});

describe('applySet (dotted-path drafts)', () => {
  it('changes one value and leaves the base untouched', () => {
    const next = applySet(D, { 'thresholds.registered_share_min': 0.4 });
    expect(next.thresholds.registered_share_min).toBe(0.4);
    expect(D.thresholds.registered_share_min).toBe(0.5);
    expect(next.thresholds.registered_share_min_B).toBe(0.6);
  });

  it('adds a threshold (an open map) and lets a clause use it', () => {
    const next = applySet(D, {
      'thresholds.share_floor': 0.3,
      'tier.clauses.B': { all: [{ f: 'registered_share', op: '>=', v: '$share_floor' }, { f: 'n_words', op: '<=', v: '$form_B_max_words' }] },
    });
    expect(next.thresholds.share_floor).toBe(0.3);
  });

  it('indexes into arrays', () => {
    expect(applySet(D, { 'tranche.size': 12, 'price.forbidden_bands_cents.0': [70000, 99900] }).price.forbidden_bands_cents[0]).toEqual([70000, 99900]);
  });

  it('SETTINGS_KEY_UNKNOWN for a path that is not in the schema (including inside arrays and under scalars)', () => {
    expect(code(() => applySet(D, { 'nope.x': 1 }))).toBe('SETTINGS_KEY_UNKNOWN');
    expect(code(() => applySet(D, { 'form.nope': 1 }))).toBe('SETTINGS_KEY_UNKNOWN');
    expect(code(() => applySet(D, { 'buy_hold.x': 1 }))).toBe('SETTINGS_KEY_UNKNOWN');
    expect(code(() => applySet(D, { 'price.forbidden_bands_cents.9': [1, 2] }))).toBe('SETTINGS_KEY_UNKNOWN');
  });

  it('SETTINGS_INVALID when the result breaks a rule, with the issues', () => {
    try {
      applySet(D, { 'score.weights.S3.A': 14 });
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('SETTINGS_INVALID');
      expect(JSON.stringify((e as AppError).details)).toMatch(/sum to 100/);
    }
    expect(code(() => applySet(D, { 'run.gates.S3': ['form', 'foo'] }))).toBe('SETTINGS_INVALID');
    expect(code(() => applySet(D, { 'form.short_max_words': 'two' }))).toBe('SETTINGS_INVALID');
  });

  it('SETTINGS_KEY_LOCKED for a change to a prior, by a leaf path or by replacing a parent (SEL9-2)', () => {
    expect(code(() => applySet(D, { 'tier.p_passive.A': 0.03 }))).toBe('SETTINGS_KEY_LOCKED');
    expect(code(() => applySet(D, { 'lead.p_lead.S2': 0.01 }))).toBe('SETTINGS_KEY_LOCKED');
    expect(code(() => applySet(D, { 'priors_v91.p_passive.S2': 0.02 }))).toBe('SETTINGS_KEY_LOCKED');
    expect(code(() => applySet(D, { 'priors_v91': { p_passive: { S2: 0.02, S3: 0.004, S4: 0.004, S6: 0.005, S7: 0.004 } } }))).toBe('SETTINGS_KEY_LOCKED');
    expect(code(() => applySet(D, { lead: { ...D.lead, p_lead: { ...D.lead.p_lead, S3: 0.5 } } }))).toBe('SETTINGS_KEY_LOCKED');
    // BUG-5: replacing a locked parent with a value of the wrong shape is still LOCKED (not SETTINGS_INVALID), with details.path
    for (const [k, v] of [['tier.p_passive', 0.1], ['lead.p_lead', 0.1], ['priors_v91', 0.1], ['priors_v91', { p_passive: 5 }]] as const) {
      let err: { code?: string; details?: { path?: string } } = {};
      try { applySet(D, { [k]: v }); } catch (e) { err = e as typeof err; }
      expect([k, err.code, err.details?.path]).toEqual([k, 'SETTINGS_KEY_LOCKED', k]);
    }
  });

  it('replacing a parent that keeps the locked values the same is fine', () => {
    const next = applySet(D, { lead: { ...D.lead, gate_enabled: true } });
    expect(next.lead.gate_enabled).toBe(true);
    expect(deepEqual(next.lead.p_lead, D.lead.p_lead)).toBe(true);
  });
});
