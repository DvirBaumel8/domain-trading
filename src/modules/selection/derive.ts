// Final status and funnel of a screening run (CAP-20). Pure: results in, verdict out.
import { GATE_OF } from './checks/index.js';
import type { CheckId, Lane, ResultRow } from './types.js';

export type FinalStatus = 'buy_candidate' | 'would_buy' | 'pending_manual' | 'rejected' | 'unknown' | 'invalid' | 'running' | 'pending' | 'not_screened';

export interface Derived {
  final_status: FinalStatus;
  first_fail: { check: CheckId; gate: string; reason_code: string } | null;
  flags: CheckId[];
  pending_manual: CheckId[];
  /** Planned checks that answered NOT_RUN / NOT_IMPLEMENTED: shown, never counted as a pass or a fail. */
  not_implemented: CheckId[];
}

/**
 * The result per check: a manual record always outranks an automatic or cached row, except an automated history FAIL (whatever the ids: a human record posted
 * while the worker was still running must not be hidden by the auto row that lands later); within a kind the highest id wins.
 */
export const beats = (a: ResultRow, b: ResultRow): boolean => {
  // Fail closed: an automated history FAIL (only possible with sources.wayback on; a cached manual row carries fields.manual) is never outranked by a manual row.
  const autoFail = (r: ResultRow) => r.check_id === 'history' && r.source !== 'manual' && r.status === 'FAIL' && r.fields.manual !== true;
  if (a.source === 'manual' && autoFail(b)) return false;
  if (b.source === 'manual' && autoFail(a)) return true;
  return (a.source === 'manual') !== (b.source === 'manual') ? a.source === 'manual' : a.id > b.id;
};

export function latestByCheck(results: ResultRow[]): Map<CheckId, ResultRow> {
  const m = new Map<CheckId, ResultRow>();
  for (const r of results) {
    const have = m.get(r.check_id);
    if (!have || beats(r, have)) m.set(r.check_id, r);
  }
  return m;
}

/** Checks that stay unbuilt in v1.1.0 (P1b screening pack, post-buy leads): never block a name. */
export const EXEMPT_UNBUILT: CheckId[] = ['pack', 'leads'];

/**
 * - `invalid`: the name could not be read (`form` FAIL `INPUT_INVALID`).
 * - `rejected`: a gating check FAILed (first in plan order is `first_fail`; in live mode later checks were never run).
 * - `unknown`: a gating check is UNKNOWN, or the run is finished and a planned gating check has no result.
 * - `not_screened`: the effective plan holds no gating check (only feature checks, e.g. `checks: ["census"]`).
 * - `running`: no FAIL/UNKNOWN yet and the run is not finished with a gating check still to come.
 * - `pending` (v2.9.0): a survivor so far, but the run is still running and a planned check (a feature check, say) has no result yet: never shown as a result before its checks ran.
 * - `pending_manual`: everything else passed but a MANUAL_REQUIRED record is outstanding.
 * - `would_buy` while `buyHold` (CR-002: never a BUY card while the hold is on), else `buy_candidate`.
 * Feature checks (`featureChecks`) never reject or stop a name; their UNKNOWN only leaves a feature unknown.
 * A gating check that answered NOT_RUN `NOT_IMPLEMENTED` (not built yet) makes a LIVE name `unknown` (never a survivor with a gate unchecked),
 * except `pack` and `leads`; in a full (report) run it is only listed in `not_implemented`.
 */
export function deriveItem(results: ResultRow[], plan: CheckId[], featureChecks: CheckId[], buyHold: boolean, runDone: boolean, live = true): Derived {
  const latest = latestByCheck(results);
  const none: Derived = { final_status: 'running', first_fail: null, flags: [], pending_manual: [], not_implemented: [] };
  const form = latest.get('form');
  if (form && form.status === 'FAIL' && form.reason_code === 'INPUT_INVALID') {
    return { ...none, final_status: 'invalid', first_fail: { check: 'form', gate: form.gate, reason_code: 'INPUT_INVALID' } };
  }
  const gating = plan.filter((c) => !featureChecks.includes(c));
  // v2.6.0 (N-7): a plan cut to feature checks only has no gate; the name was not screened and is never ranked.
  if (gating.length === 0) return { ...none, flags: plan.filter((c) => latest.get(c)?.status === 'FLAG'), final_status: 'not_screened' };
  const notImpl = (r: ResultRow | undefined) => r?.status === 'NOT_RUN' && r.reason_code === 'NOT_IMPLEMENTED';
  const flags = plan.filter((c) => latest.get(c)?.status === 'FLAG');
  const not_implemented = plan.filter((c) => notImpl(latest.get(c)));
  const failed = gating.find((c) => latest.get(c)?.status === 'FAIL');
  const base = { flags, pending_manual: [] as CheckId[], not_implemented };
  if (failed) {
    const r = latest.get(failed)!;
    return { ...base, final_status: 'rejected', first_fail: { check: failed, gate: r.gate, reason_code: r.reason_code ?? 'FAIL' } };
  }
  const pending_manual = gating.filter((c) => latest.get(c)?.status === 'MANUAL_REQUIRED');
  const unbuilt = live && gating.some((c) => notImpl(latest.get(c)) && !EXEMPT_UNBUILT.includes(c));
  if (unbuilt || gating.some((c) => latest.get(c)?.status === 'UNKNOWN')) return { ...base, pending_manual, final_status: 'unknown', first_fail: null };
  const missing = gating.some((c) => {
    const r = latest.get(c);
    return !r || (r.status === 'NOT_RUN' && !notImpl(r));
  });
  if (missing) return { ...base, pending_manual, final_status: runDone ? 'unknown' : 'running', first_fail: null };
  if (!runDone && plan.some((c) => !latest.has(c))) return { ...base, pending_manual, final_status: 'pending', first_fail: null };
  if (pending_manual.length > 0) return { ...base, pending_manual, final_status: 'pending_manual', first_fail: null };
  return { ...base, final_status: buyHold ? 'would_buy' : 'buy_candidate', first_fail: null };
}

export interface DerivedItem { idx: number; lane: Lane; derived: Derived }

export interface Funnel {
  names: number;
  by_final_status: Record<string, number>;
  /** First-fail counts per check: how many names each gate stopped. */
  first_fail: Record<string, { gate: string; count: number }>;
  by_lane: Record<string, {
    names: number;
    final: Record<string, number>;
    /** Per planned check, in plan order: names with a result (`reached`) and how they came out. */
    stages: { check: CheckId; gate: string; reached: number; passed: number; flagged: number; failed: number; unknown: number; manual_required: number; not_run: number }[];
  }>;
}

export function funnel(items: DerivedItem[], resultsByItem: Map<number, ResultRow[]>, plan: Partial<Record<Lane, CheckId[]>>): Funnel {
  const out: Funnel = { names: items.length, by_final_status: {}, first_fail: {}, by_lane: {} };
  for (const it of items) {
    const st = it.derived.final_status;
    out.by_final_status[st] = (out.by_final_status[st] ?? 0) + 1;
    // An unreadable name is counted once, as `invalid`; it is not a form-gate failure.
    const lane = (out.by_lane[it.lane] ??= {
      names: 0, final: {},
      stages: (plan[it.lane] ?? []).map((check) => ({ check, gate: GATE_OF[check], reached: 0, passed: 0, flagged: 0, failed: 0, unknown: 0, manual_required: 0, not_run: 0 })),
    });
    lane.names++;
    lane.final[st] = (lane.final[st] ?? 0) + 1;
    if (st === 'invalid') continue;
    if (it.derived.first_fail) {
      const f = (out.first_fail[it.derived.first_fail.check] ??= { gate: it.derived.first_fail.gate, count: 0 });
      f.count++;
    }
    const latest = latestByCheck(resultsByItem.get(it.idx) ?? []);
    for (const s of lane.stages) {
      const r = latest.get(s.check);
      if (!r) continue;
      s.reached++;
      if (r.status === 'PASS' || r.status === 'PASS_WITH_NOTE') s.passed++;
      else if (r.status === 'FLAG') s.flagged++;
      else if (r.status === 'FAIL') s.failed++;
      else if (r.status === 'UNKNOWN') s.unknown++;
      else if (r.status === 'MANUAL_REQUIRED') s.manual_required++;
      else s.not_run++;
    }
  }
  return out;
}
