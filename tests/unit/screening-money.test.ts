// CAP-18 (selection.md §2.1, SEL9-1/SEL9-10) and CR-002 CAP-18: EV, renew ratio at the BIN and at the floor, LANDER-1, score.
import { describe, expect, it } from 'vitest';
import type { Lane } from '../../src/screening/form.js';
import { evaluateMoney, geoLadderBottomCents, syllableCount, type MoneyInput } from '../../src/screening/money.js';
import { DEFAULT_SELECTION_VALUES as D, type SelectionValuesT } from '../../src/screening/settings.js';
import { laneList } from '../../src/pricing/schedule.js';
import { V2, V3 } from '../helpers/pricing.js';

const ARA = 1108; // $11.08, lifetime $22.16
const v91: SelectionValuesT = { ...D, lead: { ...D.lead, gate_enabled: true } };
const base = (o: Partial<MoneyInput>): MoneyInput => ({
  lane: 'S3', tier: 'none', binCents: 148800, priceGrade: null, leadsAB: 0, firstYearCents: ARA, renewalCents: ARA, landerNs: 'afternic',
  retailEnd: null, retailStart: null, form: null, riskFlag: false, intentRaw: null, timingRaw: null, extBusinessRaw: null, ...o,
});
const m = (o: Partial<MoneyInput>, sel = v91, pricing = V3) => evaluateMoney(base(o), sel, pricing, 'test');
const near = (x: number | null, y: number) => expect(Math.abs((x as number) - y)).toBeLessThanOrEqual(0.02);
/** EV is quoted to one decimal in the spec: compare within 0.06. */
const ev = (c: number | null, y: number) => expect(Math.abs((c as number) / 100 - y)).toBeLessThanOrEqual(0.06);

describe('SEL9-1 worked checks (v9.1 priors via lead.gate_enabled)', () => {
  it('geo 8 A/B at $499, floor $299: ratio 1.69 / 1.01, EV -$1.4, EV fails', () => {
    const r = m({ lane: 'S2', binCents: 49900, leadsAB: 8 });
    near(r.ratio_at_bin, 1.69); near(r.ratio_at_floor, 1.01); ev(r.ev_cents, -1.4);
    expect([r.floor_cents, r.passes.ev1, r.passes.ratio1]).toEqual([29900, false, true]);
  });

  it('geo 10 A/B at $499: ratio 2.05 / 1.23, EV +$2.6', () => {
    const r = m({ lane: 'S2', binCents: 49900, leadsAB: 10 });
    near(r.ratio_at_bin, 2.05); near(r.ratio_at_floor, 1.23); ev(r.ev_cents, 2.6);
    expect(r.passes.ev1).toBe(true);
  });

  it('geo 12 A/B at $399: ratio 1.93 / 1.45, EV +$0.8; geo 10 A/B at $399: 1.64 / 1.23, EV -$2.4', () => {
    const a = m({ lane: 'S2', binCents: 39900, leadsAB: 12 });
    near(a.ratio_at_bin, 1.93); near(a.ratio_at_floor, 1.45); ev(a.ev_cents, 0.8);
    const b = m({ lane: 'S2', binCents: 39900, leadsAB: 10 });
    near(b.ratio_at_bin, 1.64); near(b.ratio_at_floor, 1.23); ev(b.ev_cents, -2.4);
  });

  it('geo with 0 leads: ratio fails', () => {
    const r = m({ lane: 'S2', binCents: 49900, leadsAB: 0 });
    expect(r.passes.ratio1).toBe(false);
    expect(r.ratio_at_bin!).toBeLessThanOrEqual(0.57);
  });

  it('S3 5 A/B at $1,488 (floor $967): ratio 1.59 / 1.03, EV +$0.4; 4 A/B: EV fails', () => {
    const r = m({ leadsAB: 5 });
    near(r.ratio_at_bin, 1.59); near(r.ratio_at_floor, 1.03); ev(r.ev_cents, 0.4);
    expect([r.floor_cents, r.passes.ev1, r.passes.ratio1]).toEqual([96700, true, true]);
    expect(m({ leadsAB: 4 }).passes.ev1).toBe(false);
  });

  it('S3 10 A/B and S6 5 A/B (worked table)', () => {
    const a = m({ leadsAB: 10 });
    near(a.ratio_at_bin, 2.71); near(a.ratio_at_floor, 1.76); ev(a.ev_cents, 12.8);
    const b = m({ lane: 'S6', leadsAB: 5 });
    near(b.ratio_at_bin, 2.26); near(b.ratio_at_floor, 1.47); ev(b.ev_cents, 9.1);
  });

  it('$1,488 with 0 A/B: EV -$12.06, ratio 0.46 / 0.30; with ARA $23.19 the ratio at the BIN is 0.22 (SEL9-10)', () => {
    const r = m({ leadsAB: 0 });
    near(r.ratio_at_bin, 0.46); near(r.ratio_at_floor, 0.30); ev(r.ev_cents, -12.06);
    near(m({ leadsAB: 0, renewalCents: 2319 }).ratio_at_bin, 0.22);
  });

  it('memphisplumbingpros: 1 A lead at $399 (geo): EV -$17.10, ratio 0.31 / 0.23 (the geo floor is the ladder bottom, not the BIN)', () => {
    const r = m({ lane: 'S2', binCents: 39900, leadsAB: 1 });
    near(r.ratio_at_bin, 0.31); near(r.ratio_at_floor, 0.23); ev(r.ev_cents, -17.1);
  });

  it('D-001 at $1,995: not on the price list, LANDER-1 fails; forbidden band flagged', () => {
    const r = m({ binCents: 199500, leadsAB: 10 });
    expect([r.bin_in_allowed_set, r.lander1.reason, r.forbidden_band, r.passes.lander1]).toEqual([false, 'BIN_NOT_IN_PRICE_LIST', true, false]);
  });

  it('$1,988 needs the LANDER-1 exception (30 A/B and retail end >= 20); $2,488 as well', () => {
    expect(m({ binCents: 198800, leadsAB: 29, retailEnd: 25 }).lander1).toMatchObject({ pass: false, reason: 'LANDER_EXCEPTION_NOT_MET' });
    expect(m({ binCents: 198800, leadsAB: 30, retailEnd: 19 }).lander1.pass).toBe(false);
    expect(m({ binCents: 198800, leadsAB: 30, retailEnd: 20 }).lander1.pass).toBe(true);
    expect(m({ binCents: 248800, leadsAB: 30, retailEnd: 20 }).lander1.pass).toBe(true);
  });

  it('forbidden bands are settings: $800-$999 is flagged, $788 and $1,088 are not', () => {
    expect([80000, 99900, 78800, 108800].map((b) => m({ binCents: b }).forbidden_band)).toEqual([true, true, false, false]);
  });
});

describe('CR-002 CAP-18: p_passive from the tier (v10 defaults)', () => {
  it('tier A at $1,488, 0 leads: ratio 2.28 / 1.48, EV +$27.9 per two years', () => {
    const r = m({ tier: 'A', leadsAB: 0 }, D);
    near(r.ratio_at_bin, 2.28); near(r.ratio_at_floor, 1.48); ev(r.ev_cents, 27.9);
    expect([r.p_passive, r.n, r.passes.ev1, r.passes.ratio1]).toEqual([0.02, 0, true, true]);
  });

  it('the same name with tier B: ratios halve (1.14 / 0.74); tier I = tier A', () => {
    const r = m({ tier: 'B' }, D);
    near(r.ratio_at_bin, 1.14); near(r.ratio_at_floor, 0.74);
    expect(m({ tier: 'I' }, D).p_passive).toBe(0.02);
  });

  it('tier none (or the lead gate on) falls back to the v9.1 priors of the lane', () => {
    expect(m({ tier: 'none' }, D).p_passive).toBe(D.priors_v91.p_passive.S3);
    expect(m({ tier: 'A' }, v91).p_passive).toBe(D.priors_v91.p_passive.S3);
  });

  it('tier G: 0.01 for a geo name', () => {
    expect(m({ lane: 'S2', tier: 'G', binCents: 49900 }, D).p_passive).toBe(0.01);
  });

  it('a settings change moves the number (priors are data)', () => {
    const sel: SelectionValuesT = { ...D, tier: { ...D.tier, p_passive: { ...D.tier.p_passive, A: 0.04 } } };
    near(m({ tier: 'A' }, sel).ratio_at_bin, 4.56);
  });
});

describe('one price list (the same lane lists as computePlan and the price job)', () => {
  it('a non-geo $499 is not in the set and LANDER-1 fails (computePlan says BIN_NOT_IN_PRICE_LIST for it)', () => {
    const r = m({ binCents: 49900 });
    expect([r.bin_in_allowed_set, r.lander1.pass, r.lander1.reason]).toEqual([false, false, 'BIN_NOT_IN_PRICE_LIST']);
  });
  it('a geo $1,488 is not in the set; a geo $499 is; a geo $788 is not', () => {
    expect(m({ lane: 'S2', binCents: 148800 }).bin_in_allowed_set).toBe(false);
    expect(m({ lane: 'S2', binCents: 148800 }).lander1.pass).toBe(false);
    expect(m({ lane: 'S2', binCents: 49900 }).bin_in_allowed_set).toBe(true);
    expect(m({ lane: 'S2', binCents: 78800 }).bin_in_allowed_set).toBe(false);
  });
  it('the geo ladder bottom comes from the geo lane list', () => {
    expect(geoLadderBottomCents(V3)).toBe(laneList('geo', V3)[0]);
  });
});

describe('money mechanics', () => {
  it('net factor: 0.85 with Afternic, 0.75 otherwise', () => {
    expect(m({}).net_price_cents).toBe(126480);
    expect(m({ landerNs: 'other' }).net_price_cents).toBe(111600);
  });

  it('missing quote: EV and ratios are null, their passes unknown', () => {
    const r = m({ firstYearCents: null, renewalCents: null });
    expect([r.ev_cents, r.ratio_at_bin, r.ratio_at_floor, r.passes.ev1, r.passes.ratio1]).toEqual([null, null, null, null, null]);
    const half = m({ firstYearCents: null });
    expect([half.ev_cents, half.passes.ev1, half.ratio_at_bin === null]).toEqual([null, null, false]);
  });

  it('lifetime cost is the first year plus one renewal', () => {
    expect(m({ firstYearCents: 900, renewalCents: 1300 }).lifetime_cost_cents).toBe(2200);
  });

  it('geo floor for the ratio is the lowest geo rung of the price list (no literal 299 in code)', () => {
    expect(geoLadderBottomCents(V3)).toBe(29900);
    const custom = { ...V3, allowedBinsCents: [25000, 39900, 49900, 78800, 148800], geoBinMinCents: 25000 };
    expect(geoLadderBottomCents(custom)).toBe(25000);
    expect(m({ lane: 'S2', binCents: 49900, leadsAB: 8 }, v91, custom).floor_cents).toBe(25000);
    expect(geoLadderBottomCents(V2)).toBe(29900); // no price list: the geo band minimum
  });

  it('the non-geo floor is the pricing floor of the BIN (one formula)', () => {
    expect(m({ binCents: 148800 }).floor_cents).toBe(96700);
    expect(m({ binCents: 108800 }).floor_cents).toBe(75000);
  });

  it('without a price list: bin_in_allowed_set is null and a non-geo LANDER-1 cannot pass', () => {
    const r = m({}, v91, V2);
    expect([r.bin_in_allowed_set, r.lander1.pass, r.lander1.reason]).toEqual([null, false, 'PRICE_LIST_MISSING']);
    expect(r.lander1.message).toMatch(/pricing_settings v3 not created yet/);
    expect(m({ lane: 'S2', binCents: 49900 }, v91, V2).lander1.pass).toBe(true);
  });

  it('syllables: vowel groups, at least one', () => {
    expect([syllableCount('netextend'), syllableCount('rhythm'), syllableCount('aeiou')]).toEqual([3, 1, 1]);
  });
});

describe('score 0-100 (selection.md §2.2)', () => {
  it('every lane\'s weights sum to 100 (SEL3-1)', () => {
    for (const lane of ['S2', 'S3', 'S4', 'S6', 'S7'] as Lane[]) {
      expect(Object.values(D.score.weights[lane]).reduce((a, b) => a + b, 0)).toBe(100);
    }
  });

  it('short = 1 sets A-Form to 10 (FORM-2); a long name uses the mean of the three bands', () => {
    const form = (short: 0 | 1) => ({ geoBandRaw: null, sldLen: 9, wordCount: 2, short, syllables: 3 });
    expect(m({ form: form(1) }).factors.A.raw).toBe(10);
    // 20 letters (1), 5 words (2), 9 syllables (1) -> mean 4/3
    const long = m({ form: { geoBandRaw: null, sldLen: 20, wordCount: 5, short: 0, syllables: 9 } });
    expect(long.factors.A.raw).toBeCloseTo(4 / 3, 6);
    expect(long.factors.A.points).toBeCloseTo((4 / 3) * 1.5, 3);
  });

  it('geo A-Form follows the length bands (12 -> 10, 14 -> 7, 18 -> 4, 25 -> 1)', () => {
    const a = (len: number) => m({ lane: 'S2', binCents: 49900, form: { geoBandRaw: null, sldLen: len, wordCount: 2, short: 0, syllables: 4 } }).factors.A.raw;
    expect([12, 14, 18, 25].map(a)).toEqual([10, 7, 4, 1]);
  });

  it('B Buyers: 0 -> 0, below the gate -> 0, at the gate 6, 1.5x 8, 2x 10', () => {
    const b = (n: number) => m({ lane: 'S3', leadsAB: n }).factors.B.raw; // gate 5
    expect([0, 3, 5, 8, 10].map(b)).toEqual([0, 0, 6, 8, 10]);
  });

  it('D Liquidity from retail counts (>=30 9, >=10 6, else 2), null when no counts; capped by retail_only_max_points', () => {
    const d = (s: number | null, e: number | null) => m({ retailStart: s, retailEnd: e }).factors.D.raw;
    expect([d(20, 15), d(5, 6), d(1, 2), d(null, null)]).toEqual([9, 6, 2, null]);
    const capped: SelectionValuesT = { ...v91, score: { ...v91.score, retail_only_max_points: 5 } };
    expect(m({ retailStart: 40, retailEnd: 0 }, capped).factors.D.points).toBe(5);
  });

  it('G Risk: clean 10, flag 5; null raws give 0 points and lower the coverage', () => {
    const clean = m({ riskFlag: false });
    const flag = m({ riskFlag: true });
    expect([clean.factors.G.raw, flag.factors.G.raw]).toEqual([10, 5]);
    expect(clean.factors.F).toEqual({ raw: null, weight: 10, points: 0 });
    // lane S3: only B (20) and G (5) are known -> 0.25
    expect(clean.data_coverage).toBe(0.25);
    expect(clean.passes.coverage).toBe(false);
  });

  it('score is the rounded, clipped sum of raw x weight / 10', () => {
    const r = m({
      lane: 'S3', leadsAB: 10, form: { geoBandRaw: null, sldLen: 9, wordCount: 2, short: 1, syllables: 3 },
      retailStart: 20, retailEnd: 20, intentRaw: 5, timingRaw: 6, riskFlag: false,
    });
    // A 10x15/10=15, B 10x20/10=20, C 5x15/10=7.5, D 9x10/10=9, E 6x25/10=15, F 0, G 10x5/10=5 -> 71.5 -> 72
    expect([r.score_0_100, r.data_coverage]).toEqual([72, 0.9]);
  });

  it('parked_penalty applies only when asked and only if the setting is not 0', () => {
    const sel: SelectionValuesT = { ...v91, score: { ...v91.score, parked_penalty: 10 } };
    const a = m({ leadsAB: 10, parkedOnly: true }, sel).score_0_100;
    const b = m({ leadsAB: 10, parkedOnly: true }, v91).score_0_100;
    expect(b - a).toBe(10);
  });

  it('the model version names the settings and the pricing version', () => {
    expect(m({}).model_version).toBe('selection:test/pricing:v3');
  });
});
