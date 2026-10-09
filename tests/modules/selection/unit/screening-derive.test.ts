// CAP-20 final status and funnel (pure). CR-002 CAP-20 acceptance: never a BUY card while buy_hold is on.
import { describe, expect, it } from 'vitest';
import { GATE_OF } from '../../../../src/modules/selection/checks/index.js';
import { deriveItem, funnel, latestByCheck } from '../../../../src/modules/selection/derive.js';
import type { CheckId, ResultRow, Status } from '../../../../src/modules/selection/types.js';

let id = 0;
function row(check: CheckId, status: Status, reason_code: string | null = status === 'PASS' ? null : 'X', item_idx = 0): ResultRow {
  return {
    id: ++id, run_id: 'r', item_idx, domain: 'a.com', lane: 'S3', check_id: check, gate: GATE_OF[check], rule_ids: [], status, reason_code, reason: null,
    fields: {}, data_as_of: null, checked_at: new Date(0), settings_label: 'v1', list_versions: {}, duration_ms: 0, upstream_calls: 0, evidence_ids: [],
    source: 'auto', cached_from: null, recorded_by: null,
  };
}
const PLAN: CheckId[] = ['form', 'brand_lists', 'typo', 'availability', 'web_risk', 'tm_us', 'census', 'pack'];
const FEATURES: CheckId[] = ['census', 'ext_dates', 'namebio'];
const d = (rows: ResultRow[], buyHold = true, done = true, plan = PLAN) => deriveItem(rows, plan, FEATURES, buyHold, done);

describe('deriveItem', () => {
  it('a FAIL at typo: rejected with first_fail typo/G1 (live mode never ran the later checks)', () => {
    const r = d([row('form', 'PASS'), row('brand_lists', 'PASS'), row('typo', 'FAIL', 'TYPO_HIT')], true, false);
    expect(r).toMatchObject({ final_status: 'rejected', first_fail: { check: 'typo', gate: 'G1', reason_code: 'TYPO_HIT' } });
  });

  it('in full mode the first FAIL in plan order is first_fail even when later gates also fail', () => {
    const r = d([row('form', 'PASS'), row('typo', 'FAIL', 'TYPO_HIT'), row('availability', 'UNKNOWN', 'SOURCE_ERROR'), row('tm_us', 'FAIL', 'TM_LIVE_MARK')]);
    expect(r).toMatchObject({ final_status: 'rejected', first_fail: { check: 'typo' } });
  });

  it('an UNKNOWN at availability: unknown (it stops a buy)', () => {
    const r = d([row('form', 'PASS'), row('brand_lists', 'PASS'), row('typo', 'PASS'), row('availability', 'UNKNOWN', 'SOURCE_ERROR')], true, false);
    expect(r.final_status).toBe('unknown');
    expect(r.first_fail).toBeNull();
  });

  it('all PASS with web_risk and tm_us MANUAL_REQUIRED: pending_manual; manual PASS rows then give would_buy (hold on) or buy_candidate (hold off)', () => {
    const base = [row('form', 'PASS'), row('brand_lists', 'PASS'), row('typo', 'PASS'), row('availability', 'PASS'),
      row('web_risk', 'MANUAL_REQUIRED', 'MANUAL_SOURCE'), row('tm_us', 'MANUAL_REQUIRED', 'MANUAL_SOURCE'), row('census', 'PASS'), row('pack', 'NOT_RUN', 'NOT_IMPLEMENTED')];
    expect(d(base)).toMatchObject({ final_status: 'pending_manual', pending_manual: ['web_risk', 'tm_us'] });
    const withManual = [...base, row('web_risk', 'PASS'), row('tm_us', 'PASS')];
    expect(d(withManual, true).final_status).toBe('would_buy');
    expect(d(withManual, false).final_status).toBe('buy_candidate');
    expect(d(withManual, true).pending_manual).toEqual([]);
  });

  it('a manual record that is itself UNKNOWN or FAIL supersedes the MANUAL_REQUIRED row', () => {
    const base = [row('form', 'PASS'), row('brand_lists', 'PASS'), row('typo', 'PASS'), row('availability', 'PASS'), row('web_risk', 'MANUAL_REQUIRED', 'MANUAL_SOURCE'), row('tm_us', 'PASS')];
    expect(d([...base, row('web_risk', 'UNKNOWN', 'HISTORY_NOT_FINAL')], true, true, PLAN.slice(0, 6)).final_status).toBe('unknown');
    expect(d([...base, row('web_risk', 'FAIL', 'UNSAFE')], true, true, PLAN.slice(0, 6)).final_status).toBe('rejected');
  });

  it('a feature check (census) UNKNOWN or FAIL does not stop or reject the name', () => {
    const rows = [row('form', 'PASS'), row('brand_lists', 'PASS'), row('typo', 'PASS'), row('availability', 'PASS'), row('web_risk', 'PASS'), row('tm_us', 'PASS'), row('census', 'UNKNOWN', 'SOURCE_ERROR'), row('pack', 'NOT_RUN', 'NOT_IMPLEMENTED')];
    expect(d(rows).final_status).toBe('would_buy');
    expect(d([...rows.slice(0, 6), row('census', 'FAIL', 'X'), rows[7]!]).final_status).toBe('would_buy');
  });

  it('NOT_RUN NOT_IMPLEMENTED (pack) is listed in not_implemented and ignored', () => {
    const rows = [row('form', 'PASS'), row('pack', 'NOT_RUN', 'NOT_IMPLEMENTED')];
    expect(d(rows, true, true, ['form', 'pack'])).toMatchObject({ final_status: 'would_buy', not_implemented: ['pack'] });
  });

  it('a gating check that is not built (NOT_IMPLEMENTED): a live name is unknown, a report/full name only lists it; pack and leads stay exempt', () => {
    const rows = [row('form', 'PASS'), row('typo', 'NOT_RUN', 'NOT_IMPLEMENTED'), row('pack', 'NOT_RUN', 'NOT_IMPLEMENTED')];
    expect(deriveItem(rows, ['form', 'typo', 'pack'], FEATURES, true, true, true)).toMatchObject({ final_status: 'unknown', not_implemented: ['typo', 'pack'] });
    expect(deriveItem(rows, ['form', 'typo', 'pack'], FEATURES, false, true, true).final_status).toBe('unknown'); // never buy_candidate
    expect(deriveItem(rows, ['form', 'typo', 'pack'], FEATURES, true, true, false)).toMatchObject({ final_status: 'would_buy', not_implemented: ['typo', 'pack'] });
    expect(deriveItem([rows[0]!, rows[2]!], ['form', 'pack'], FEATURES, true, true, true).final_status).toBe('would_buy');
  });

  it('a manual row outranks an auto MANUAL_REQUIRED row whatever the ids; between manual rows the newest wins', () => {
    const manual = { ...row('web_risk', 'FAIL', 'UNSAFE'), source: 'manual' as const };
    const autoLater = row('web_risk', 'MANUAL_REQUIRED', 'MANUAL_SOURCE'); // higher id, written after the manual record
    expect(autoLater.id).toBeGreaterThan(manual.id);
    expect(latestByCheck([manual, autoLater]).get('web_risk')).toBe(manual);
    expect(latestByCheck([autoLater, manual]).get('web_risk')).toBe(manual);
    const manual2 = { ...row('web_risk', 'PASS'), source: 'manual' as const };
    expect(latestByCheck([manual2, manual, autoLater]).get('web_risk')).toBe(manual2);
  });

  it('FLAGs are listed and do not block; INPUT_INVALID is invalid', () => {
    const rows = [row('form', 'FLAG', 'AMBIGUOUS_SPLIT'), row('brand_lists', 'PASS')];
    expect(d(rows, false, true, ['form', 'brand_lists'])).toMatchObject({ final_status: 'buy_candidate', flags: ['form'] });
    expect(d([row('form', 'FAIL', 'INPUT_INVALID')]).final_status).toBe('invalid');
  });

  it('a missing gating result: running while the run is open, unknown once it is finished (never a survivor with a gate missing)', () => {
    const rows = [row('form', 'PASS'), row('brand_lists', 'PASS')];
    expect(d(rows, true, false).final_status).toBe('running');
    expect(d(rows, true, true).final_status).toBe('unknown');
  });
});

describe('funnel', () => {
  it('counts per lane (stage by stage), by final status and first-fail per check', () => {
    const plan: Record<string, CheckId[]> = { S3: ['form', 'brand_lists', 'typo'], S2: ['form', 'brand_lists'] };
    const r0 = [row('form', 'PASS', null, 0), row('brand_lists', 'PASS', null, 0), row('typo', 'PASS', null, 0)];
    const r1 = [row('form', 'PASS', null, 1), row('brand_lists', 'FAIL', 'BIGCO_HIT', 1)];
    const r2 = [row('form', 'FAIL', 'INPUT_INVALID', 2)];
    const r3 = [row('form', 'PASS', null, 3), row('brand_lists', 'PASS', null, 3)];
    const by = new Map([[0, r0], [1, r1], [2, r2], [3, r3]]);
    const items = [
      { idx: 0, lane: 'S3' as const, derived: deriveItem(r0, plan.S3!, FEATURES, true, true) },
      { idx: 1, lane: 'S3' as const, derived: deriveItem(r1, plan.S3!, FEATURES, true, true) },
      { idx: 2, lane: 'S3' as const, derived: deriveItem(r2, plan.S3!, FEATURES, true, true) },
      { idx: 3, lane: 'S2' as const, derived: deriveItem(r3, plan.S2!, FEATURES, true, true) },
    ];
    const f = funnel(items, by, plan);
    expect(f.names).toBe(4);
    expect(f.by_final_status).toEqual({ would_buy: 2, rejected: 1, invalid: 1 });
    expect(f.first_fail).toEqual({ brand_lists: { gate: 'G1', count: 1 } }); // an unreadable name is counted as `invalid` only
    expect(f.by_lane.S3!.names).toBe(3);
    expect(f.by_lane.S3!.stages.map((s) => [s.check, s.reached, s.passed, s.failed])).toEqual([['form', 2, 2, 0], ['brand_lists', 2, 1, 1], ['typo', 1, 1, 0]]);
    expect(f.by_lane.S2!.final).toEqual({ would_buy: 1 });
  });
});
