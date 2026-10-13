// CR-043 (v3.10.0) pure parts: lookalike names, topic derivation, CSV cell escaping, settings defaults for stored older settings.
import { describe, expect, it } from 'vitest';
import { lookalikeNames } from '../../../../src/modules/selection/checks/lookalikes.js';
import { csvSafe } from '../../../../src/modules/selection/run-report.js';
import { DEFAULT_SELECTION_VALUES, SelectionValues, featureChecksOf } from '../../../../src/modules/selection/settings.js';
import { assemble } from '../../../../src/modules/selection/engine.js';
import type { ResultRow, RunItem } from '../../../../src/modules/selection/types.js';
import { topicFor } from '../../../../src/modules/selection/topic.js';

const cfg = { endings: ['net', 'org', 'io', 'co', 'ai', 'co.uk'], prefixes: ['get', 'try'] };

describe('CR-043 lookalikeNames', () => {
  it('CR43-1 endings, the hyphenated form at the word boundary, get- and try- versions; never the .com itself', () => {
    expect(lookalikeNames('rooferdrone', ['roofer', 'drone'], cfg).map((n) => n.domain)).toEqual([
      'rooferdrone.net', 'rooferdrone.org', 'rooferdrone.io', 'rooferdrone.co', 'rooferdrone.ai', 'rooferdrone.co.uk', 'roofer-drone.com', 'getrooferdrone.com', 'tryrooferdrone.com',
    ]);
  });
  it('CR43-2 three words also give each single boundary; one word gives no hyphen form; scout tokens that do not join to the SLD are ignored', () => {
    expect(lookalikeNames('abcdef', ['ab', 'cd', 'ef'], { endings: [], prefixes: [] }).map((n) => n.domain)).toEqual(['ab-cd-ef.com', 'ab-cdef.com', 'abcd-ef.com']);
    expect(lookalikeNames('single', ['single'], { endings: [], prefixes: [] })).toEqual([]);
    expect(lookalikeNames('abcdef', ['xx', 'yy'], { endings: [], prefixes: [] })).toEqual([]);
  });
});

describe('CR-043 topicFor and csvSafe', () => {
  it('CR43-3 the scout topic is lower-cased and trimmed; else lane plus the first two content words (3+ letters)', () => {
    expect(topicFor('S3', ['a', 'drone', 'roof', 'x'], '  Roof Drones ')).toBe('roof drones');
    expect(topicFor('S3', ['it', 'drone', 'roof', 'inspection'], null)).toBe('s3:drone roof');
    expect(topicFor('S3', ['it', 'os'], null)).toBeNull();
    expect(topicFor('S3', null, null)).toBeNull();
  });
  it('CR43-4 a cell starting with = + - @ tab or CR gets a leading apostrophe; other cells are unchanged', () => {
    for (const c of ['=SUM(A1)', '+1', '-5', '@x', '\tx', '\rx']) expect(csvSafe(c)).toBe(`'${c}`);
    for (const c of ['', 'abc', 'a=b', '1-2', "'x"]) expect(csvSafe(c)).toBe(c);
  });
});

describe('CR-043 settings of a stored older version', () => {
  it('CR43-5 a document without the new keys parses with defaults that keep today\'s verdicts (every new reject off)', () => {
    const old: Record<string, any> = JSON.parse(JSON.stringify(DEFAULT_SELECTION_VALUES));
    delete old.lookalikes; delete old.buy; delete old.form.max_sld_chars;
    old.intake = { drop_list_max_share: 1 };
    const v = SelectionValues.parse(old);
    expect(v.form.max_sld_chars).toBeNull();
    expect(v.intake).toMatchObject({ require_sellers_min: 0, require_comps: false, topic_window_days: 30 });
    expect(v.buy.exclude_lanes).toEqual([]);
    expect(v.lookalikes).toMatchObject({ enabled: true, endings: ['net', 'org', 'io', 'co', 'ai', 'co.uk'], prefixes: ['get', 'try'] });
    expect(featureChecksOf(v)).toContain('lookalikes');
  });
  it('CR43-6 the new keys validate: max_sld_chars >= 1, require_sellers_min <= 10, buy.exclude_lanes holds lanes only', () => {
    const bad = (f: (d: any) => void) => { const d = JSON.parse(JSON.stringify(DEFAULT_SELECTION_VALUES)); f(d); return SelectionValues.safeParse(d).success; };
    expect(bad((d) => { d.form.max_sld_chars = 20; })).toBe(true);
    expect(bad((d) => { d.form.max_sld_chars = 0; })).toBe(false);
    expect(bad((d) => { d.intake.require_sellers_min = 11; })).toBe(false);
    expect(bad((d) => { d.buy.exclude_lanes = ['S2']; })).toBe(true);
    expect(bad((d) => { d.buy.exclude_lanes = ['S9']; })).toBe(false);
    expect(bad((d) => { d.lookalikes.endings = ['not an ending']; })).toBe(false);
  });
});

describe('CR-043 buy.exclude_lanes', () => {
  const row = (idx: number, lane: any): ResultRow => ({
    id: idx + 1, run_id: 'r', item_idx: idx, domain: `n${idx}.com`, lane, check_id: 'form', gate: 'G0', rule_ids: [], status: 'PASS', reason_code: null, reason: null, fields: {},
    data_as_of: null, checked_at: new Date(), settings_label: 'v1', list_versions: {}, duration_ms: 0, upstream_calls: 0, evidence_ids: [], source: 'auto', cached_from: null, recorded_by: null,
  });
  const items: RunItem[] = [{ idx: 0, domain: 'n0.com', lane: 'S3', leads_ab: 0 }, { idx: 1, domain: 'n1.com', lane: 'S2', leads_ab: 0 }];
  const plan = { S3: ['form'], S2: ['form'] } as never;
  const status = (values: typeof DEFAULT_SELECTION_VALUES) => assemble(items, plan, [row(0, 'S3'), row(1, 'S2')], values, false, true).items.map((i) => [i.derived.final_status, i.derived.reason_code ?? null]);

  it('CR43-60 default []: an S2 survivor is a buy_candidate as before', () => {
    expect(status(DEFAULT_SELECTION_VALUES)).toEqual([['buy_candidate', null], ['buy_candidate', null]]);
  });
  it('CR43-61 exclude_lanes ["S2"]: S2 becomes not_for_buy with LANE_NOT_FOR_BUY (also while the buy hold is on), S3 is unchanged', () => {
    const v = { ...DEFAULT_SELECTION_VALUES, buy: { ...DEFAULT_SELECTION_VALUES.buy, exclude_lanes: ['S2' as const] } };
    expect(status(v)).toEqual([['buy_candidate', null], ['not_for_buy', 'LANE_NOT_FOR_BUY']]);
    expect(assemble(items, plan, [row(0, 'S3'), row(1, 'S2')], v, true, true).items.map((i) => i.derived.final_status)).toEqual(['would_buy', 'not_for_buy']);
  });
});
