// CR-008 AC-1, AC-2, AC-3: the v11 draft (section 6.1 with DOM's C-3 fix), the 894 TEST15 fixtures through the real tier code, the boundaries.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_SELECTION_VALUES } from '../../src/modules/selection/settings.js';
import { screeningHarness, type ScreeningHarness } from '../helpers/screening.js';
import { testDb as db } from '../helpers/db.js';

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());

const share = (extra: object[]) => [
  { f: 'registered_share', op: '>=', v: '$registered_share_min_v11' }, ...extra,
];
const form = [
  { f: 'n_words', op: '>=', v: '$v11_min_words' }, { f: 'n_words', op: '<=', v: '$v11_max_words' },
  { f: 'sld_chars', op: '<=', v: '$v11_max_chars' }, { f: 'is_geo', op: '==', v: 0 },
];
const V11_SET = {
  'thresholds.registered_share_min_v11': 0.55, 'thresholds.v11_min_words': 2, 'thresholds.v11_max_words': 3, 'thresholds.v11_max_chars': 25,
  'tier.clauses': {
    A: { all: share(form) },
    I: { all: [{ f: 'alt_tld_before_n', op: '>=', v: '$alt_tld_before_min' }, ...form] },
    G: DEFAULT_SELECTION_VALUES.tier.clauses.G,
  },
  'tier.order': ['A', 'I', 'G'], 'tier.demand2_pass_tiers': ['A', 'I', 'G'],
  'freshness_hours.census': 168, 'ext.alt_list': ['net', 'org', 'biz', 'ca'],
};

async function v11(): Promise<ScreeningHarness> {
  const x = await screeningHarness();
  app = x.app;
  const r = await x.post('/selection/settings', { label: 'v11', set: V11_SET, note: 'v11: A is the share path, I the other-extension path' });
  expect(r.statusCode, r.body).toBe(201);
  const b = r.json();
  expect(b.values.buy_hold).toBe(true);
  expect(b.values.holdout).toEqual(DEFAULT_SELECTION_VALUES.holdout);
  expect(b.values.ext).toEqual({ list: DEFAULT_SELECTION_VALUES.ext.list, alt_list: ['net', 'org', 'biz', 'ca'] });
  return x;
}

const csv = readFileSync(new URL('../../docs/requests/CR-008-reference/v11_fixtures.csv', import.meta.url), 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
const head = csv[0]!.split(',');
const rows = csv.slice(1).map((l) => { const c = l.split(','); return Object.fromEntries(head.map((k, i) => [k, c[i]!])) as Record<string, string>; });

describe('CR-008 v11 draft and fixtures', () => {
  it('V11-1 AC-1: the draft validates (201), buy_hold stays true, holdout unchanged, tier B is gone', async () => {
    const x = await v11();
    const g = (await x.get('/selection/settings?label=v11')).json();
    expect(g.values.tier.order).toEqual(['A', 'I', 'G']);
    expect(Object.keys(g.values.tier.clauses).sort()).toEqual(['A', 'G', 'I']);
    expect(g.values.tier.p_passive).toEqual(DEFAULT_SELECTION_VALUES.tier.p_passive);
    expect(g.active).toBe(false);
    // the pre-C-3 form (clauses one by one, B left in the document) is refused, as DOM answered
    const bad = await x.post('/selection/settings', { label: 'v11x', set: { ...V11_SET, 'tier.clauses': undefined, 'tier.clauses.A': (V11_SET['tier.clauses'] as any).A, 'tier.clauses.I': (V11_SET['tier.clauses'] as any).I } });
    expect([bad.statusCode, bad.json().error.code]).toEqual([422, 'SETTINGS_INVALID']);
  });

  it('V11-2 AC-2: the 894 TEST15 rows registered as fit / R15-TEST15-USED; every decision equals expected, 0 undecided, sold accepted 286/400, dropped rejected 381/494, all 24 rows at 0.55 accepted', async () => {
    const x = await v11();
    expect(rows).toHaveLength(894);
    const upload = rows.map((r) => ({
      domain: r.domain, role: 'fit', label: r.label, source: 'CR-008 TEST15', slice: 'R15-TEST15-USED', as_of: r.as_of,
      features: { registered_share: Number(r.registered_share), alt_tld_before_n: Number(r.alt_tld_before_n), n_words: Number(r.n_words), sld_chars: Number(r.sld_chars), is_geo: Number(r.is_geo) },
    }));
    let inserted = 0;
    for (let i = 0; i < upload.length; i += 200) {
      const r = await x.post('/selection/labelled-names', { rows: upload.slice(i, i + 200) });
      expect(r.statusCode, r.body).toBe(200);
      inserted += r.json().inserted;
    }
    expect(inserted).toBe(894);
    const rep = await x.post('/selection/replays', { suite: 'V11-FIX', mode: 'diagnostic', settings: 'v11', slices: ['R15-TEST15-USED'], profit: false });
    expect(rep.statusCode, rep.body).toBe(201);
    const pooled = rep.json().report.pooled;
    expect(pooled.sold).toMatchObject({ n: 400, accepted: 286, undecided: 0 });
    expect(pooled.dropped).toMatchObject({ n: 494, rejected: 381, undecided: 0 });
    expect(rep.json().report.leakage_lint).toBeDefined();

    // row by row, through the real tier code with the stored v11 settings
    const { decideReplayRow } = await import('../../src/modules/selection/replay.js');
    const { selectionSettingsByLabel } = await import('../../src/modules/selection/settings.js');
    const sel = (await selectionSettingsByLabel(db, 'v11'))!.values;
    const stored = await db.selectFrom('labelled_names').selectAll().where('slice', '=', 'R15-TEST15-USED').execute();
    expect(stored).toHaveLength(894);
    const want = new Map(rows.map((r) => [r.domain, r]));
    const wrong: string[] = [];
    let exact055 = 0;
    for (const s of stored) {
      const r = want.get(s.domain)!;
      const d = decideReplayRow(s.features as never, sel).decision;
      if (d !== (r.expected === 'accept' ? 'accept' : 'reject')) wrong.push(`${s.domain} ${d} vs ${r.expected}`);
      if (Number(r.registered_share) === 0.55) { exact055++; if (d !== 'accept') wrong.push(`${s.domain} at 0.55 not accepted`); }
    }
    expect(wrong).toEqual([]);
    expect(exact055).toBe(24);
    expect(rows.filter((r) => r.label === 'sold' && r.expected === 'accept')).toHaveLength(286);
    expect(rows.filter((r) => r.label === 'dropped' && r.expected === 'reject')).toHaveLength(381);
  });

  it('V11-3 AC-3 boundaries via POST /selection/evaluate (settings v11, lane S7), and lane S2 only passes through G', async () => {
    const x = await v11();
    const ev = async (features: object, lane = 'S7') => {
      const r = await x.post('/selection/evaluate', { lane, settings: 'v11', leads_ab: 0, bin_usd: 1488, features });
      expect(r.statusCode, r.body).toBe(200);
      const t = r.json().tier;
      return { demand2: t.demand2 as string, tier: t.tier as string, clauses: t.clauses };
    };
    const f = (o: object) => ({ registered_share: 0.55, alt_tld_before_n: 0, n_words: 2, sld_chars: 12, is_geo: 0, ...o });
    expect(await ev(f({}))).toMatchObject({ demand2: 'PASS', tier: 'A' });
    expect(await ev(f({ registered_share: 0.549 }))).toMatchObject({ demand2: 'FAIL', tier: 'none' });
    expect(await ev(f({ registered_share: 0.2, alt_tld_before_n: 1 }))).toMatchObject({ demand2: 'PASS', tier: 'I' });
    for (const o of [{ n_words: 4 }, { n_words: 1 }, { sld_chars: 26 }]) expect(await ev(f({ registered_share: 0.9, ...o })), JSON.stringify(o)).toMatchObject({ demand2: 'FAIL' });
    expect(await ev(f({ registered_share: null, alt_tld_before_n: 1 }))).toMatchObject({ demand2: 'PASS' });
    expect(await ev(f({ registered_share: null }))).toMatchObject({ demand2: 'UNKNOWN' });
    expect(await ev(f({ registered_share: null, alt_tld_before_n: null }))).toMatchObject({ demand2: 'UNKNOWN' });
    // geo lane (S2): is_geo defaults to 1, so A and I are false; only G can pass
    const geoFail = await ev({ registered_share: 0.9, alt_tld_before_n: 1, n_words: 2, sld_chars: 12, gform1_pass: 0 }, 'S2');
    expect(geoFail).toMatchObject({ demand2: 'FAIL', tier: 'none', clauses: { A: 'false', I: 'false', G: 'false' } });
    const geoPass = await ev({ registered_share: 0.1, alt_tld_before_n: 0, n_words: 2, sld_chars: 12, gform1_pass: 1 }, 'S2');
    expect(geoPass).toMatchObject({ demand2: 'PASS', tier: 'G', clauses: { A: 'false', I: 'false', G: 'true' } });
  });
});
