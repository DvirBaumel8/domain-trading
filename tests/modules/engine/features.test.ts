// v5.5.0 (CR-056 part 2): the point-in-time features (pure). Nothing dated on or after the as_of day may count. Test IDs EN-31..EN-38.
import { describe, expect, it } from 'vitest';
import { dayNumber } from '../../../src/core/dates.js';
import { buildTokenIndex, computeFeatures, extendedTable, inRegime, toVector, zipfOfCost, type EndingFact, type EngineTld, type FeatureContext } from '../../../src/modules/engine/features.js';
import { loadSplitV2 } from '../../../src/modules/selection/index.js';

const table = loadSplitV2('bt1@v3');
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
function ctx(o: {
  sales?: [string, string][]; unsold?: [string, string][]; endings?: Record<string, Partial<Record<EngineTld, EndingFact>>>;
  demand?: Record<string, { month: string; searches: number }[]>; tokRate?: boolean;
} = {}): FeatureContext {
  const tokens = buildTokenIndex((o.sales ?? []).map(([sld, d]) => ({ sld, day: dayNumber(d) })), (o.unsold ?? []).map(([sld, d]) => ({ sld, day: dayNumber(d) })), table, o.tokRate ?? true);
  return { table, tokens, endings: new Map(Object.entries(o.endings ?? {})), demand: new Map(Object.entries(o.demand ?? {})) };
}
const f = (c: FeatureContext, domain: string, asOf: string) => computeFeatures(c, domain, asOf).values;

describe('engine features (point in time)', () => {
  it('EN-31: shape and word features of a two-word name', () => {
    const v = f(ctx(), 'septicdrone.com', '2026-09-01');
    expect(v).toMatchObject({ len: 11, n_words: 2, has_digit: 0, has_hyphen: 0, plural_end: 0, all_known: 1, known_share: 1, one_word: 0 });
    expect(v.vowel_share).toBeCloseTo(4 / 11, 6);
    expect(v.seg_cost_per_char).toBeCloseTo(((8 + 5) * 2) / 11, 6);
    expect(v.zipf_min).toBe(zipfOfCost(8)); expect(v.zipf_max).toBe(zipfOfCost(8));
    const w = f(ctx(), 'solarpanels.com', '2026-09-01');
    expect(w.plural_end).toBe(1);
    expect(w.zipf_min!).toBeLessThanOrEqual(w.zipf_max!);
    const d = f(ctx(), 'abc123.com', '2026-09-01');
    expect(d).toMatchObject({ has_digit: 1, all_known: 0, n_words: null, zipf_min: null });
    expect(f(ctx(), 'a-b.com', '2026-09-01').has_hyphen).toBe(1);
  });

  it('EN-32: the regime: letters only, 6..20 characters, 2..3 known words; an extra term (regime / tech list) becomes a known word', () => {
    expect(inRegime('septicdrone', table)).toBe(true);
    expect(inRegime('septic', table)).toBe(false); // one word
    expect(inRegime('septic1drone', table)).toBe(false);
    expect(inRegime('drone', table)).toBe(false); // 5 letters
    expect(inRegime('septicdronexqzvk', table)).toBe(false);
    expect(inRegime('zqxvkseptic', table)).toBe(false);
    const ext = extendedTable(table, ['zqxvk', 'ab1', 'septic']);
    expect(inRegime('zqxvkseptic', ext)).toBe(true);
    expect(ext.cost.get('zqxvk')).toBe(8);
    expect(ext.cost.get('septic')).toBe(table.cost.get('septic')); // a term already known keeps its cost
    expect(ext.cost.has('ab1')).toBe(false);
  });

  it('EN-33: word trend: only sales of the 365 days before as_of count; as_of itself and later never do', () => {
    const asOf = '2026-09-01';
    const c = ctx({ sales: [
      ['septicdrone', '2026-09-01'], // on as_of: not counted
      ['septicdrone', '2026-12-01'], // later: not counted
      ['septicdrone', '2025-09-01'], // exactly 365 days before: counted
      ['septicdrone', '2025-08-31'], // 366 days before: not counted
      ['solarpanel', '2026-03-01'], ['solarpanel', '2026-04-01'], ['pizzagarden', '2026-05-01'],
    ] });
    const v = f(c, 'septicdrone.com', asOf);
    // the window holds septicdrone (2025-09-01), solarpanel x2, pizzagarden = 4 sales; both words of the name are in 1 of them
    expect(v.trend_pit_max).toBeCloseTo(1 / 4, 8);
    expect(v.trend_pit_min).toBeCloseTo(1 / 4, 8);
    const s = f(c, 'solarpanel.com', asOf);
    expect(s.trend_pit_max).toBeCloseTo(2 / 4, 8);
    // moving as_of back to before every sale leaves an empty window: unknown, not zero
    expect(f(c, 'septicdrone.com', '2025-08-31').trend_pit_max).toBeNull();
    // the rarest word of a mixed name
    const m = f(c, 'solarpanel.com', asOf); // solar and panel are each in the 2 solarpanel sales
    expect(m.trend_pit_min).toBeCloseTo(2 / 4, 8);
  });

  it('EN-34: token sale rate: Laplace-smoothed, from rows dated before as_of only, and off when the unsold side is not dated', () => {
    const c = ctx({
      sales: [['septicdrone', '2026-01-01'], ['septicdrone', '2026-02-01'], ['septicdrone', '2026-09-01']],
      unsold: [['septicdrone', '2026-03-01'], ['septicdrone', '2026-10-01']],
    });
    // before 2026-09-01: 2 sales, 1 unsold -> (2+1)/(2+1+2)
    expect(f(c, 'septicdrone.com', '2026-09-01').tok_rate_pit).toBeCloseTo(3 / 5, 8);
    // before 2026-01-01: nothing -> (0+1)/(0+0+2)
    expect(f(c, 'septicdrone.com', '2026-01-01').tok_rate_pit).toBeCloseTo(0.5, 8);
    expect(f(ctx({ sales: [['septicdrone', '2026-01-01']], tokRate: false }), 'septicdrone.com', '2026-09-01').tok_rate_pit).toBeNull();
  });

  it('EN-35: other endings: registered strictly before as_of is 1; registered later is 0; free is 0; unanswered is unknown; the count adds the known ones', () => {
    const e = (registered: boolean | null, created?: string): EndingFact => ({ registered, createdMs: created ? ms(created) : null });
    const c = ctx({ endings: { septicdrone: { net: e(true, '2019-04-02'), co: e(true, '2026-09-01'), org: e(true, '2027-01-01'), io: e(false), ai: e(null) } } });
    const v = f(c, 'septicdrone.com', '2026-09-01');
    expect(v).toMatchObject({ net_pit: 1, co_pit: 0, org_pit: 0, io_pit: 0, ai_pit: null, n_endings_pit: 1 });
    expect(f(c, 'septicdrone.com', '2018-01-01').net_pit).toBe(0); // registered later than this as_of
    expect(f(c, 'septicdrone.com', '2020-01-01').net_pit).toBe(1);
    expect(f(ctx(), 'septicdrone.com', '2026-09-01')).toMatchObject({ net_pit: null, n_endings_pit: null });
    // registered with no creation date cannot be placed in time: unknown
    expect(f(ctx({ endings: { septicdrone: { net: e(true) } } }), 'septicdrone.com', '2026-09-01').net_pit).toBeNull();
  });

  it('EN-36: .com acquisition: hand-registered within 36 months, older = aftermarket or old, created after as_of keeps its own category, unknown stays unknown', () => {
    const com = (created: string | null, registered: boolean | null = true) => ctx({ endings: { septicdrone: { com: { registered, createdMs: created ? ms(created) : null } } } });
    const acq = (c: FeatureContext, asOf: string) => computeFeatures(c, 'septicdrone.com', asOf);
    expect(acq(com('2024-10-01'), '2026-09-01').acq).toBe('handreg'); // 23 months
    expect(acq(com('2023-09-15'), '2026-09-01').acq).toBe('handreg'); // just under 36 months
    expect(acq(com('2023-08-01'), '2026-09-01').acq).toBe('aftermarket_or_old'); // 37 months
    expect(acq(com('2026-09-01'), '2026-09-01').acq).toBe('created_after'); // on as_of counts as after: strictly before is the rule
    const after = acq(com('2026-10-05'), '2026-09-01');
    expect(after.acq).toBe('created_after');
    expect(after.values).toMatchObject({ acq_created_after: 1, acq_handreg: 0, acq_aftermarket_or_old: 0, com_age_years: null });
    expect(acq(com('2016-01-01'), '2026-09-01').values.com_age_years!).toBeCloseTo(10.67, 1);
    expect(acq(com(null, false), '2026-09-01')).toMatchObject({ acq: null });
    expect(acq(com(null, null), '2026-09-01').values.acq_handreg).toBeNull();
  });

  it('EN-37: keyword demand: only an upload month at or before the as_of month counts; the newest such month wins', () => {
    const c = ctx({ demand: { 'septic drone': [{ month: '2026-03', searches: 100 }, { month: '2026-09', searches: 500 }, { month: '2026-11', searches: 900 }] } });
    expect(f(c, 'septicdrone.com', '2026-09-30').demand).toBe(500);
    expect(f(c, 'septicdrone.com', '2026-08-01').demand).toBe(100);
    expect(f(c, 'septicdrone.com', '2026-02-01').demand).toBeNull();
    expect(f(c, 'solarpanel.com', '2026-09-30').demand).toBeNull();
  });

  it('EN-38: the model row: chosen features in order, a missing value is NaN', () => {
    const v = f(ctx(), 'septicdrone.com', '2026-09-01');
    const x = toVector(v, ['len', 'net_pit', 'n_words']);
    expect(Array.from(x).map((n) => (Number.isNaN(n) ? 'nan' : n))).toEqual([11, 'nan', 2]);
  });
});
