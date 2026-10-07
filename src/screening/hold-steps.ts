// v2.13.0 (CR-012 part D, Q-5): the path to lifting the buy hold as a list of steps, derived from data. Information only: nothing acts on it.
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { formatUsd } from '../core/money.js';
import { holdSuites, suiteStatuses } from './replay.js';
import type { SelectionValuesT } from './settings.js';

export type StepStatus = 'done' | 'open' | 'failed';
export type StepActor = 'gavriel' | 'dvir';
export interface HoldStep { n: number; step: string; status: StepStatus; evidence: Record<string, unknown> | null; next_actor: StepActor | null }

/** A tranche whose name contains "probe" is a test probe (CR-012: `accept-v2-probe-20261007`), not a production tranche. */
export const isProbeTranche = (name: string): boolean => /probe/i.test(name);

export async function buyHoldSteps(db: Kysely<Database>, active: { label: string; values: SelectionValuesT }): Promise<{ steps: HoldStep[]; ready: boolean }> {
  const iso = (d: Date) => d.toISOString();
  const mk = (n: number, step: string, status: StepStatus, actor: StepActor, evidence: Record<string, unknown> | null): HoldStep => ({ n, step, status, evidence, next_actor: status === 'done' ? null : actor });

  // 1. a sealed test set
  const sealed = await db.selectFrom('test_sets').select(['name', 'sealed_at']).where('status', '=', 'sealed').orderBy('sealed_at', 'desc').limit(1).executeTakeFirst();
  const s1 = mk(1, 'A fresh test set is sealed', sealed ? 'done' : 'open', 'gavriel', sealed ? { set: sealed.name, sealed_at: sealed.sealed_at ? iso(sealed.sealed_at) : null } : null);

  // 2. a sibling method approved
  const method = await db.selectFrom('sibling_method_approvals').select(['method', 'approval_at']).orderBy('approval_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
  const s2 = mk(2, 'A sibling method is approved by Dvir, by name', method ? 'done' : 'open', 'dvir', method ? { method: method.method, approved_at: iso(method.approval_at) } : null);

  // 3. a clears_hold suite frozen; failed when any of them has a failed holdout replay
  const defs = await db.selectFrom('holdout_suites').select(['suite', 'version', 'clears_hold', 'created_at']).orderBy('suite').orderBy('version', 'desc').execute();
  const latest = new Map<string, { suite: string; version: number; created_at: Date }>();
  for (const d of defs) if (!latest.has(d.suite) && d.clears_hold === true) latest.set(d.suite, { suite: d.suite, version: d.version, created_at: d.created_at });
  const clearing = [...latest.values()];
  const failedReplays = clearing.length === 0 ? [] : await db.selectFrom('replay_runs').select(['id', 'suite']).where('suite', 'in', clearing.map((c) => c.suite)).where('mode', '=', 'holdout').where('pass', '=', false).orderBy('created_at').execute();
  const newest = [...clearing].sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0];
  const s3 = failedReplays.length > 0
    ? mk(3, 'A hold suite that clears the hold is frozen', 'failed', 'gavriel', { suite: newest!.suite, version: newest!.version, created_at: iso(newest!.created_at), suites: clearing.map((c) => ({ suite: c.suite, version: c.version, created_at: iso(c.created_at) })), failed_replays: failedReplays.map((r) => ({ suite: r.suite, replay_id: r.id })) })
    : mk(3, 'A hold suite that clears the hold is frozen', newest ? 'done' : 'open', 'gavriel', newest ? { suite: newest.suite, version: newest.version, created_at: iso(newest.created_at), suites: clearing.map((c) => ({ suite: c.suite, version: c.version, created_at: iso(c.created_at) })) } : null);

  // 4. a draft (settings version) with buy_hold false: the active one when it has none, else the newest
  const versions = await db.selectFrom('selection_settings').select(['id', 'label', 'values', 'activation_seq', 'activated_at']).orderBy('id', 'desc').execute();
  const unheld = versions.filter((v) => (v.values as { buy_hold?: boolean }).buy_hold === false);
  const draft = unheld.find((v) => v.label === active.label) ?? unheld[0];
  const s4 = mk(4, 'A settings draft with buy_hold false exists', draft ? 'done' : 'open', 'gavriel', draft ? { label: draft.label } : null);

  // 5. a passing holdout replay of every hold suite on that draft (a failure sticks)
  const hold = await holdSuites(db, active.values.holdout);
  let s5: HoldStep;
  if (!draft || hold.suites.length === 0) s5 = mk(5, 'Every hold suite passes its holdout replay on that draft', 'open', 'gavriel', null);
  else {
    const st = await suiteStatuses(db, draft.id, active.values.holdout);
    const ev = { settings: draft.label, replays: st.map((x) => ({ suite: x.suite, replay_id: x.replay_id, pass: x.pass })) };
    const failed = st.some((x) => x.failed_before);
    s5 = mk(5, 'Every hold suite passes its holdout replay on that draft', failed ? 'failed' : st.length > 0 && st.every((x) => x.pass) ? 'done' : 'open', 'gavriel', st.some((x) => x.replay_id !== null) || failed ? ev : null);
  }

  // 6. that draft is active (buy_hold false in force)
  const activeRow = versions.find((v) => v.label === active.label);
  const s6 = mk(6, 'Dvir activates the draft (lifts the hold)', active.values.buy_hold === false ? 'done' : 'open', 'dvir', active.values.buy_hold === false ? { label: active.label, activated_at: activeRow?.activated_at ? iso(activeRow.activated_at) : null } : null);

  // 7. an open production (non-probe) tranche
  const tr = (await db.selectFrom('tranches').select(['id', 'name', 'spend_cap_cents']).where('status', '=', 'open').orderBy('opened_at', 'desc').execute()).find((t) => !isProbeTranche(t.name));
  const s7 = mk(7, 'A production tranche is open', tr ? 'done' : 'open', 'dvir', tr ? { tranche_id: tr.id, name: tr.name, cap_cents: tr.spend_cap_cents, cap: tr.spend_cap_cents === null ? null : formatUsd(tr.spend_cap_cents) } : null);

  const steps = [s1, s2, s3, s4, s5, s6, s7];
  return { steps, ready: steps.slice(0, 5).every((s) => s.status === 'done') };
}
