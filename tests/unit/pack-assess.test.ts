import { describe, expect, it } from 'vitest';
import { assessPack, requiredChecks, type JudgmentT } from '../../src/modules/selection/pack.js';
import { DEFAULT_SELECTION_VALUES } from '../../src/modules/selection/settings.js';
import type { CheckId, Lane, ResultRow, Status } from '../../src/modules/selection/types.js';
import type { VerdictRow } from '../../src/modules/selection/verdicts.js';

const NOW = Date.parse('2026-10-06T12:00:00Z');
const H = 3_600_000;
const sel = { ...DEFAULT_SELECTION_VALUES };
const PLAN: CheckId[] = ['form', 'brand_lists', 'availability', 'web_risk', 'history', 'tm_us', 'census', 'quote', 'price'];
const judgment: JudgmentT = {
  van_test: { verdict: 'PASS', reason: 'Clear to a van driver' }, tn1: { verdict: 'PASS', reason: 'No operator trades under it' },
  bigco: { verdict: 'PASS', reason: 'No big-company overlap' }, reason_not_to_buy: 'Thin end-user demand', judged_by: 'Gavriel', judged_at: '2026-10-06T08:00:00+03:00',
};
let seq = 0;
const row = (check: CheckId, status: Status, over: Partial<ResultRow> = {}): ResultRow => ({
  id: ++seq, run_id: 'r', item_idx: 0, domain: 'x.com', lane: 'S3', check_id: check, gate: 'G', rule_ids: [], status, reason_code: null, reason: null, fields: {},
  data_as_of: null, checked_at: new Date(NOW - H), settings_label: 'v1', list_versions: {}, duration_ms: 0, upstream_calls: 0, evidence_ids: [], source: 'auto',
  cached_from: null, recorded_by: null, ...over,
});
interface Opts { status?: Partial<Record<CheckId, Status>>; flags?: Partial<Record<CheckId, 'PASS' | 'REJECT'>>; drop?: CheckId[]; lane?: Lane; availabilityAgeH?: number; quoteAgeH?: number; judgment?: JudgmentT; plan?: CheckId[] }
function fx(o: Opts = {}) {
  const plan = o.plan ?? PLAN;
  const latest = new Map<CheckId, ResultRow>();
  const verdicts = new Map<number, VerdictRow>();
  for (const c of [...plan, 'same_name', 'tm_eu'] as CheckId[]) {
    if (o.drop?.includes(c)) continue;
    const st = o.status?.[c] ?? 'PASS';
    const fields: Record<string, unknown> = c === 'quote' ? { quoted_at: new Date(NOW - (o.quoteAgeH ?? 1) * H).toISOString(), quote_source: 'live' }
      : c === 'availability' ? { checked_at: new Date(NOW - (o.availabilityAgeH ?? 1) * H).toISOString() } : {};
    const r = row(c, st, { fields });
    latest.set(c, r);
    const v = o.flags?.[c];
    if (v) verdicts.set(r.id, { id: r.id, result_id: r.id, check_id: c, item_idx: 0, verdict: v, reason: 'because', decided_by: 'Shomer', decided_at: new Date(NOW), recorded_by: 'g' });
  }
  return { lane: o.lane ?? 'S3', plan, latest, verdicts, judgment: o.judgment ?? judgment, sel, now: NOW };
}
const codes = (o: Opts) => assessPack(fx(o)).missing.map((m) => m.code);

describe('assessPack', () => {
  it('complete: every required gate PASS/PASS_WITH_NOTE, FLAG with a PASS verdict, fresh availability and quote', () => {
    expect(assessPack(fx({ status: { tm_us: 'FLAG', web_risk: 'PASS_WITH_NOTE' }, flags: { tm_us: 'PASS' } })).status).toBe('complete');
  });
  it('excluded checks (census) never decide, but are listed with decides:false', () => {
    const r = assessPack(fx({ status: { census: 'FAIL' } }));
    expect(r.status).toBe('complete');
    expect(r.gates.find((g) => g.check === 'census')).toMatchObject({ decides: false, status: 'FAIL' });
    expect(r.gates.find((g) => g.check === 'same_name')).toMatchObject({ decides: true });
  });
  it('incomplete, one missing item per cause', () => {
    expect(codes({ status: { web_risk: 'UNKNOWN' } })).toEqual(['UNKNOWN']);
    expect(codes({ status: { history: 'FAIL' } })).toEqual(['FAIL']);
    expect(codes({ status: { tm_us: 'FLAG' } })).toEqual(['FLAG_NO_VERDICT']);
    expect(codes({ status: { tm_us: 'FLAG' }, flags: { tm_us: 'REJECT' } })).toEqual(['FLAG_REJECTED']);
    expect(codes({ drop: ['same_name'] })).toEqual(['NO_RESULT']);
    expect(codes({ lane: 'S6', drop: ['tm_eu'] })).toEqual(['NO_RESULT']);
    expect(codes({ lane: 'S6', status: { tm_eu: 'MANUAL_REQUIRED' } })).toEqual(['MANUAL_REQUIRED']);
    expect(codes({ availabilityAgeH: 25 })).toEqual(['STALE_AVAILABILITY']);
    expect(codes({ quoteAgeH: 25 })).toEqual(['STALE_QUOTE']);
    expect(codes({ judgment: { ...judgment, van_test: { verdict: 'REJECT', reason: 'Sounds like spam' } } })).toEqual(['JUDGMENT_REJECTED']);
  });
  it('a verdict on an older row of the same check does not count', () => {
    const f = fx({ status: { tm_us: 'FLAG' }, flags: { tm_us: 'PASS' } });
    const old = f.latest.get('tm_us')!;
    f.latest.set('tm_us', row('tm_us', 'FLAG')); // a newer FLAG row in force: the verdict belongs to the old id
    expect(f.verdicts.has(old.id)).toBe(true);
    expect(assessPack(f).missing.map((m) => m.code)).toEqual(['FLAG_NO_VERDICT']);
  });
  it('tm_eu for a lane not in eu_tm.required_lanes is not required (even if absent)', () => {
    expect(codes({ lane: 'S3', drop: ['tm_eu'] })).toEqual([]);
    expect(requiredChecks('S3', [...PLAN, 'tm_eu'], sel)).not.toContain('tm_eu');
    expect(requiredChecks('S6', PLAN, sel)).toContain('tm_eu');
  });
});
