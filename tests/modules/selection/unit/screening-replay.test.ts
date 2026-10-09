// CAP-21a replay: the tier/DEMAND-2 decision per row (same code as live screening), the missing-data rule, rates, bands, precision,
// leakage lint, profit report (Amendment A3). Synthetic rows; the real reference data is in selection-replay-cr002.test.ts.
import { describe, expect, it } from 'vitest';
import { AppError } from '../../../../src/http/errors.js';
import { bandLabels, bandOf, cell, csvToUploadRow, decideReplayRow, laneOf, leakageLint, missingGates, parseCsv, profitReport, replayReport, type Entry, type LabelledRow } from '../../../../src/modules/selection/replay.js';
import { DEFAULT_SELECTION_VALUES as D, type SelectionValuesT } from '../../../../src/modules/selection/settings.js';

const row = (o: Partial<LabelledRow> & { f?: LabelledRow['features'] } = {}): LabelledRow => ({
  domain: 'x.com', role: 'test', label: 'sold', source: 's', slice: 'a', report_lane: null, price_cents: null, as_of: '2026-06-01',
  features: { registered_share: 0.1, prior_history: 0, alt_tld_before_n: 0, n_words: 2, sld_chars: 9, is_geo: 0, ...o.f }, ...o,
});
const dec = (f: LabelledRow['features'], sel: SelectionValuesT = D) => decideReplayRow(f, sel).decision;

describe('decideReplayRow (CR-002 CAP-21 missing-data rule)', () => {
  it('history unknown, share 0.4, no alt-TLD: decided reject; share 0.55: undecided', () => {
    expect(dec({ registered_share: 0.4, prior_history: null, alt_tld_before_n: 0, n_words: 3, sld_chars: 12, is_geo: 0 })).toBe('reject');
    expect(dec({ registered_share: 0.55, prior_history: null, alt_tld_before_n: 0, n_words: 3, sld_chars: 12, is_geo: 0 })).toBe('undecided');
  });
  it('an alt-TLD before the name accepts even when history is unknown (same decision either way)', () => {
    expect(dec({ registered_share: 0.55, prior_history: null, alt_tld_before_n: 1, n_words: 3, sld_chars: 12, is_geo: 0 })).toBe('accept');
  });
  it('a missing share with history 0 and no alt: tier B needs the share, so undecided', () => {
    expect(dec({ registered_share: null, prior_history: 0, alt_tld_before_n: 0, n_words: 2, sld_chars: 9, is_geo: 0 })).toBe('undecided');
    // three words: tier B is false whatever the share is, and A is false on history 0, so the decision is the same either way
    expect(dec({ registered_share: null, prior_history: 0, alt_tld_before_n: 0, n_words: 3, sld_chars: 9, is_geo: 0 })).toBe('reject');
  });
  it('geo: G-FORM-1 failing is a reject even when tier A would pass; passing G-FORM-1 accepts', () => {
    const base = { registered_share: 0.8, prior_history: 1 as const, alt_tld_before_n: 0, is_geo: 1 as const };
    expect(dec({ ...base, n_words: 3, sld_chars: 20 })).toBe('reject');
    expect(dec({ registered_share: 0.1, prior_history: 0, alt_tld_before_n: 0, is_geo: 1, n_words: 2, sld_chars: 12, city_trade_ok: true })).toBe('accept');
    expect(dec({ registered_share: 0.1, prior_history: 0, alt_tld_before_n: 0, is_geo: 1, n_words: 2, sld_chars: 12, city_trade_ok: false })).toBe('reject');
  });
  it('geo with city_trade_ok unknown is not assumed true: within limits it is undecided, over the limits still a reject', () => {
    const g = { registered_share: 0.1, prior_history: 0 as const, alt_tld_before_n: 0, is_geo: 1 as const };
    expect(dec({ ...g, n_words: 2, sld_chars: 12 })).toBe('undecided');
    expect(dec({ ...g, n_words: 2, sld_chars: 12, city_trade_ok: null })).toBe('undecided');
    expect(dec({ ...g, n_words: 3, sld_chars: 12 })).toBe('reject');
  });
  it('a harmful prior page class rejects', () => {
    expect(dec({ registered_share: 0.9, prior_history: 1, alt_tld_before_n: 0, n_words: 2, sld_chars: 9, is_geo: 0, pre_cls: 'harmful' })).toBe('reject');
  });
  it('uses the settings: the same row flips with a looser share threshold', () => {
    const f = { registered_share: 0.45, prior_history: 1 as const, alt_tld_before_n: 0, n_words: 3, sld_chars: 12, is_geo: 0 as const };
    expect(dec(f)).toBe('reject');
    expect(dec(f, { ...D, thresholds: { ...D.thresholds, registered_share_min: 0.4 } })).toBe('accept');
  });
});

describe('rates, bands, precision', () => {
  const sold = (d: 'accept' | 'reject' | 'undecided', n: number) => Array.from({ length: n }, () => ({ label: 'sold' as const, d }));
  const dropped = (d: 'accept' | 'reject' | 'undecided', n: number) => Array.from({ length: n }, () => ({ label: 'dropped' as const, d }));

  it('undecided counts in n and is neither an accept nor a reject', () => {
    const c = cell([...sold('accept', 7), ...sold('undecided', 2), ...sold('reject', 1), ...dropped('reject', 3), ...dropped('undecided', 1)], D.holdout);
    expect(c.sold).toEqual({ n: 10, accepted: 7, rejected: 1, undecided: 2, accept_rate: 0.7 });
    expect(c.dropped).toMatchObject({ n: 4, rejected: 3, undecided: 1, reject_rate: 0.75 });
  });

  it('precision at 1% and 2%: s·b / (s·b + (1−r)(1−b))', () => {
    const c = cell([...sold('accept', 76), ...sold('reject', 24), ...dropped('reject', 78), ...dropped('accept', 22)], D.holdout);
    const s = 0.76; const r = 0.78;
    expect(c.precision_at['0.01']).toBeCloseTo((s * 0.01) / (s * 0.01 + (1 - r) * 0.99), 10);
    expect(c.precision_at['0.02']).toBeCloseTo((s * 0.02) / (s * 0.02 + (1 - r) * 0.98), 10);
    expect(c.precision_at['0.01']).toBeCloseTo(0.034, 3) // CR-002 round 1: TPR .76, FPR .22 -> 3.4%;
  });

  it('thresholds are data: lowering sold_accept_min flips pass; n below min_n never passes', () => {
    const xs = [...sold('accept', 38), ...sold('reject', 12), ...dropped('reject', 40), ...dropped('accept', 10)]; // 76% / 80%, n = 50
    expect(cell(xs, D.holdout).meets_thresholds).toBe(true);
    expect(cell(xs, { ...D.holdout, sold_accept_min: 0.8 }).meets_thresholds).toBe(false);
    expect(cell(xs, { ...D.holdout, min_n: 51 }).meets_thresholds).toBe(false);
    expect(cell([...sold('accept', 7), ...sold('reject', 1), ...dropped('reject', 8)], D.holdout).meets_thresholds).toBe(false);
  });

  it('bands split at $1,000 and $2,500 (settings report_bands)', () => {
    expect(bandLabels(D.holdout.report_bands)).toEqual(['<$1000', '$1000-<$2500', '>=$2500']);
    expect(bandOf(99_999, D.holdout.report_bands)).toBe('<$1000');
    expect(bandOf(100_000, D.holdout.report_bands)).toBe('$1000-<$2500');
    expect(bandOf(249_999, D.holdout.report_bands)).toBe('$1000-<$2500');
    expect(bandOf(250_000, D.holdout.report_bands)).toBe('>=$2500');
  });

  it('the report breaks down by slice, band, lane and history type', () => {
    const accept = { registered_share: 0.8, prior_history: 1 as const, alt_tld_before_n: 0, n_words: 2, sld_chars: 9, is_geo: 0 as const, pre_cls: 'parked' };
    const rows = [
      row({ domain: 'a.com', slice: 's1', price_cents: 50_000, f: accept }),
      row({ domain: 'b.com', slice: 's2', price_cents: 150_000, f: { ...accept, prior_history: 0, registered_share: 0.1 } }),
      row({ domain: 'c.com', slice: 's2', label: 'dropped', f: { ...accept, prior_history: 0, registered_share: 0.1, pre_cls: null as unknown as undefined } }),
    ];
    const r = replayReport(rows, D);
    expect(Object.keys(r.by_slice).sort()).toEqual(['s1', 's2']);
    expect(r.by_band['<$1000']).toMatchObject({ n: 1, accepted: 1 });
    expect(r.by_band['$1000-<$2500']).toMatchObject({ n: 1, accepted: 0, rejected: 1 });
    expect(Object.keys(r.by_lane).sort()).toEqual(['expired', 'fresh']);
    expect(r.history_types.parked!.sold.accept).toBe(1);
    expect(r.history_types.unknown!.dropped.reject).toBe(1);
  });

  it('lane: supplied lane wins, else geo / history', () => {
    expect(laneOf(row({ report_lane: 'aged' }))).toBe('aged');
    expect(laneOf(row({ f: { is_geo: 1 } }))).toBe('geo');
    expect(laneOf(row({ f: { prior_history: 1 } }))).toBe('expired');
    expect(laneOf(row({ f: { prior_history: null } }))).toBe('unknown');
  });
});

describe('leakage lint and gate columns (Amendment A2, A3)', () => {
  it('counts rows with an input dated at or after as_of (strict <)', () => {
    const rows = [
      row({ domain: 'a.com', f: { input_dates: { census: '2026-05-31' } } }),
      row({ domain: 'b.com', f: { input_dates: { census: '2026-06-01' } } }),
      row({ domain: 'c.com', f: { input_dates: { census: '2026-07-01' } } }),
      row({ domain: 'd.com', as_of: null, f: { input_dates: { census: '2026-07-01' } } }),
      row({ domain: 'e.com' }),
    ];
    expect(leakageLint(rows)).toEqual({ rows_checked: 3, rows_leaking: 2, rows_without_as_of: 1, rows_without_dated_inputs: 1 });
  });
  it('a gate dated at or after as_of counts as leakage', () => {
    const g = (date: string) => ({ result: 'PASS' as const, source: 'manual', date });
    expect(leakageLint([row({ f: { gates: { tm_us: g('2026-06-02') } } })]).rows_leaking).toBe(1);
    expect(leakageLint([row({ f: { gates: { tm_us: g('2026-05-02') } } })]).rows_leaking).toBe(0);
  });
  it('missingGates names the missing gate columns and the input dates of dated features', () => {
    const g = { result: 'PASS' as const, source: 'x', date: '2026-01-01' };
    const all = { tm_us: g, tn: g, hist2: g, hist2_guard: g };
    const dates = { census: '2026-01-01', ext_dates: '2026-01-01', history: '2026-01-01' };
    expect(missingGates([row({ f: { gates: all, input_dates: dates } })])).toEqual([]);
    expect(missingGates([row({ domain: 'a.com', f: { gates: { ...all, tn: undefined, hist2: { ...g, source: '' } }, input_dates: dates } })])).toEqual([{ domain: 'a.com', missing: ['tn', 'hist2'] }]);
    expect(missingGates([row({ domain: 'b.com' })])[0]!.missing).toEqual(['tm_us', 'tn', 'hist2', 'hist2_guard', 'input_dates.census', 'input_dates.ext_dates', 'input_dates.history']);
    // a null feature needs no date
    expect(missingGates([row({ f: { gates: all, registered_share: null, alt_tld_before_n: null, prior_history: null, pre_cls: null } })])).toEqual([]);
  });
});

describe('profit report (Amendment A3)', () => {
  const e = (label: 'sold' | 'dropped', d: Entry['d'], price?: number): Entry => ({ row: row({ label, price_cents: price ?? null }), d, lane: 'expired' });
  it('is refused when a sold row has no price (PROFIT_REPORT_INCOMPLETE)', () => {
    expect.assertions(2);
    try { profitReport([e('sold', 'accept'), e('sold', 'accept', 100_000)], D); } catch (x) { expect([(x as AppError).code, (x as AppError).status]).toEqual(['PROFIT_REPORT_INCOMPLETE', 422]); }
    try { profitReport([e('dropped', 'reject')], D); } catch (x) { expect((x as AppError).code).toBe('PROFIT_REPORT_INCOMPLETE'); }
  });
  it('shows as computed, without the top 3 sales, BIN-capped, and the break-even base rate', () => {
    const prices = [500_000, 400_000, 300_000, 100_000, 50_000];
    const entries = [...prices.map((p) => e('sold', 'accept', p)), e('sold', 'reject', 20_000), ...Array.from({ length: 4 }, () => e('dropped', 'reject')), e('dropped', 'accept')];
    const p = profitReport(entries, D);
    const cap = D.profit.bin_price_cents;
    expect(p).toMatchObject({ accepted_sold: 5, accepted_dropped: 1, bin_price_cents: cap, cost_cents: 6 * D.profit.cost_per_name_year_cents * D.money.hold_years });
    expect(p.as_computed.gross_cents).toBe(1_350_000);
    expect(p.without_top3.gross_cents).toBe(150_000);
    expect(p.bin_capped.gross_cents).toBe(3 * cap + 100_000 + 50_000);
    expect(p.as_computed.net_cents).toBe(Math.round(1_350_000 * D.money.net_factor_afternic));
    expect(p.as_computed.profit_cents).toBe(p.as_computed.net_cents - p.cost_cents);
    for (const f of [p.as_computed, p.without_top3, p.bin_capped]) expect(f.break_even_base_rate).toBeGreaterThan(0);
    expect(p.without_top3.break_even_base_rate!).toBeGreaterThan(p.as_computed.break_even_base_rate!);
  });
  it('the break-even base rate solves precision(b) × mean net price = yearly cost', () => {
    const entries = [...Array.from({ length: 8 }, () => e('sold', 'accept', 500_000)), ...Array.from({ length: 2 }, () => e('sold', 'reject', 1)), ...Array.from({ length: 8 }, () => e('dropped', 'reject')), ...Array.from({ length: 2 }, () => e('dropped', 'accept'))];
    const p = profitReport(entries, D);
    const b = p.as_computed.break_even_base_rate!;
    const s = 0.8; const r = 0.8;
    const precision = (s * b) / (s * b + (1 - r) * (1 - b));
    expect(precision * (500_000 * D.money.net_factor_afternic)).toBeCloseTo(D.profit.cost_per_name_year_cents, 4);
  });
});

describe('CSV upload mapping', () => {
  it('parses quoted fields and maps features.csv columns; an empty cell is unknown, never imputed', () => {
    expect(parseCsv('\uFEFFdomain,x\na.com,1\n')[0]).toEqual({ domain: 'a.com', x: '1' });
    const rows = parseCsv('domain,label,slice,role,registered_share,prior_history,pre_cls,alt_tld_before_n,n_words,sld_chars,geo_city,geo_trade,as_of\r\n"a.com",sold,s1,test,0.5,,parked,,2,9,,,2026-01-02\nb.com,dropped,s1,dev,,1,,0,2,9,austin,roofing,\n');
    expect(rows).toHaveLength(2);
    const a = csvToUploadRow(rows[0]!) as { features: Record<string, unknown>; as_of: unknown; source: unknown };
    expect(a.features).toMatchObject({ registered_share: 0.5, prior_history: null, alt_tld_before_n: null, is_geo: 0 });
    expect([a.as_of, a.source]).toEqual(['2026-01-02', 's1']);
    const b = csvToUploadRow(rows[1]!) as { features: Record<string, unknown>; as_of: unknown };
    expect(b.features).toMatchObject({ is_geo: 1, city_trade_ok: true, geo_city: 'austin', registered_share: null });
    expect(b.as_of).toBeNull();
  });
});
