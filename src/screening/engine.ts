// CAP-20 screening run engine. A run is persisted per (item, check): Render free sleeps, so a run resumes where it stopped
// (the daily job and the next poll call resumeStalled/kick). Results are append-only; a check that is not built yet answers
// NOT_RUN / NOT_IMPLEMENTED; a run that outlives its time budget finishes as `partial` with every open check UNKNOWN / TIMEOUT.
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely, type Selectable } from 'kysely';
import type { Database, ScreeningResultsTable } from '../db/types.js';
import { normalizeDomain } from '../domain-name.js';
import { AppError } from '../http/errors.js';
import { CHECKS, DEPENDS_ON, GATE_OF } from './checks/index.js';
import { MANUAL_CHECKS } from './checks/manual.js';
import { settleHostPacers } from './rdap-batch.js';
import { beats, deriveItem, funnel, latestByCheck, type Derived, type Funnel } from './derive.js';
import { loadDataLexicon, buildLexicon } from './lexicon.js';
import { listVersion, currentLists } from './lists.js';
import {
  activeSelectionSettings, deepEqual, selectionSettingsByLabel, type SelectionValuesT,
} from './settings.js';
import {
  outcome, type Check, type CheckId, type CheckOutcome, type Lane, type ResultRow, type RunItem, type RunView, type ScreeningDeps, type Status,
} from './types.js';

/** A running run with no row for this long is resumed on the next poll or tick (Render sleeps after ~15 min idle). */
export const HEARTBEAT_STALE_MS = 120_000;
const MAX_RECOMPUTE_PASSES = 5;
/** R1b: how often a run writes its heartbeat (HEARTBEAT_STALE_MS is 120 s) and re-reads its status for a cancel from another process. Wall-clock, so a fake `now` does not stop them. */
export const HEARTBEAT_EVERY_MS = 10_000;
export const CANCEL_CHECK_EVERY_MS = 5_000;

export interface InputName {
  domain: string; lane: Lane; city?: string; state?: string; trade?: string; price_grade?: 'strong' | 'weaker';
  bin_usd?: number; leads_ab?: number; census_list?: string; as_of?: string; rank?: number;
}
export interface RunBody { mode: 'live' | 'full'; settings?: string; tranche_id?: string; checks?: CheckId[]; names: InputName[] }
export interface CreatedRun { id: string; status: 'running'; mode: 'live' | 'full'; backtest: boolean; settings_version: string; buy_hold: boolean; names_n: number }

type Row = Selectable<ScreeningResultsTable>;
export function toResultRow(r: Row): ResultRow {
  return {
    id: Number(r.id), run_id: r.run_id, item_idx: r.item_idx, domain: r.domain, lane: r.lane as Lane, check_id: r.check_id as CheckId, gate: r.gate,
    rule_ids: r.rule_ids, status: r.status, reason_code: r.reason_code, reason: r.reason, fields: r.fields as Record<string, unknown>,
    data_as_of: r.data_as_of, checked_at: r.checked_at, settings_label: r.settings_label, list_versions: r.list_versions as Record<string, number>,
    duration_ms: r.duration_ms, upstream_calls: r.upstream_calls, evidence_ids: (r.evidence_ids ?? []).map(Number), source: r.source,
    cached_from: r.cached_from === null ? null : Number(r.cached_from), inputs: r.inputs as Record<string, number | null> | null, generation: Number(r.generation), recorded_by: r.recorded_by,
  };
}

/** The dependency row ids (DEPENDS_ON; null = no row) a computation of `c` reads from `latest`. null for a check without dependencies. */
export type Inputs = Record<string, number | null>;
export function inputsOf(latest: Map<CheckId, ResultRow>, c: CheckId): Inputs | null {
  const deps = DEPENDS_ON[c];
  return deps ? Object.fromEntries(deps.map((d) => [d, latest.get(d)?.id ?? null])) : null;
}
/** Uniqueness discriminator of an automatic row: a hash of its inputs (identical inputs collide, so two workers write one row). 0 without inputs. */
export const generationOf = (inputs: Inputs | null): number =>
  inputs === null ? 0 : parseInt(createHash('sha256').update(JSON.stringify(Object.entries(inputs).sort(([a], [b]) => (a < b ? -1 : 1)))).digest('hex').slice(0, 12), 16);

/**
 * Checks of `plan` whose in-force row is stale: an automatic or cached row (never a manual one) computed from other dependency rows than
 * the ones in force now (any dependency in DEPENDS_ON with a row, in the plan or not; null and non-null count as different), or whose
 * dependency is itself stale. A row with no recorded inputs falls back to "a dependency row is newer than this row". Walks the plan in order.
 */
export function staleChecks(latest: Map<CheckId, ResultRow>, plan: CheckId[]): Set<CheckId> {
  const stale = new Set<CheckId>();
  for (const c of plan) {
    const own = latest.get(c);
    if (!own || own.source === 'manual') continue;
    const deps = DEPENDS_ON[c] ?? [];
    const changed = own.inputs
      ? deps.some((d) => (latest.get(d)?.id ?? null) !== (own.inputs![d] ?? null))
      : deps.some((d) => (latest.get(d)?.id ?? 0) > own.id);
    if (changed || deps.some((d) => stale.has(d))) stale.add(c);
  }
  return stale;
}

/**
 * Whether a recompute would run for this run: some name has a stale check in its plan and is not stopped by a gating FAIL/UNKNOWN
 * outside the stale checks (live mode only). The worker and the manual route use the same test, so a run is reopened only for work that happens.
 */
export function recomputePending(items: RunItem[], plan: Partial<Record<Lane, CheckId[]>>, rows: ResultRow[], features: readonly string[], live: boolean): boolean {
  const by = new Map<number, ResultRow[]>();
  for (const r of rows) (by.get(r.item_idx) ?? by.set(r.item_idx, []).get(r.item_idx)!).push(r);
  for (const it of items) {
    if (it.input_error) continue;
    const p = plan[it.lane] ?? [];
    const latest = latestByCheck(by.get(it.idx) ?? []);
    const stale = staleChecks(latest, p);
    if (stale.size === 0) continue;
    const stopped = live && p.some((c) => !features.includes(c) && !stale.has(c) && ['FAIL', 'UNKNOWN'].includes(latest.get(c)?.status ?? ''));
    if (!stopped) return true;
  }
  return false;
}

/** Puts a finished (done or partial) run back to `running` with a fresh deadline for a recompute. False when it was already running or was cancelled (a cancelled run is never reopened). */
export async function reopenRun(db: Kysely<Database>, runId: string, now: Date, budgetMinutes: number): Promise<boolean> {
  const r = await db.updateTable('screening_runs')
    .set({ status: 'running', finished_at: null, heartbeat_at: null, deadline_at: new Date(now.getTime() + budgetMinutes * 60_000) })
    .where('id', '=', runId).where('status', 'in', ['done', 'partial']).executeTakeFirst();
  return Number(r.numUpdatedRows) > 0;
}

const isFeature = (c: CheckId, featureChecks: readonly string[]) => featureChecks.includes(c);

/** The plan of one lane: the settings' gate list (lane list, else `default`), in settings order, cut to `checks` when given. */
export function planFor(values: SelectionValuesT, lane: Lane, checks?: CheckId[]): CheckId[] {
  const list = (values.run.gates[lane] ?? values.run.gates.default ?? []) as CheckId[];
  return checks ? list.filter((c) => checks.includes(c)) : list;
}

const causeOf = (e: unknown): 'NOT_COM' | 'DOMAIN_INVALID' => ((e as AppError).code === 'TLD_NOT_SUPPORTED' ? 'NOT_COM' : 'DOMAIN_INVALID');
const CAUSE_TEXT = {
  DUPLICATE: 'The name appears more than once in this batch; only its first occurrence is screened',
  NOT_COM: 'Only second-level .com names are screened',
  DOMAIN_INVALID: 'Not a valid domain name',
};

export async function createRun(
  db: Kysely<Database>, body: RunBody, ctx: { createdBy: string; auditId: string; now: Date; /** v2.5.0 test sets: a run deadline in hours instead of run.time_budget_minutes. */ deadlineHours?: number; /** v2.6.0: internal only (test-set rescore); never reachable from POST /screening/runs. */ allowUnapprovedMethod?: boolean; /** v2.7.0: internal only (test-set runs); never reachable from POST /screening/runs. */ testSet?: { maxAnswerAgeDays: number; asOfIsNow: boolean } }, registry: Partial<Record<CheckId, Check>> = CHECKS,
): Promise<CreatedRun> {
  const active = await activeSelectionSettings(db);
  let sel = { id: active.id, label: active.label, values: active.values };
  const backtest = body.settings !== undefined && body.settings !== active.label;
  if (backtest) {
    const v = await selectionSettingsByLabel(db, body.settings!);
    if (!v) throw new AppError(404, 'SETTINGS_NOT_FOUND', `No selection settings version "${body.settings}"`);
    if (body.mode === 'live') throw new AppError(422, 'DRAFT_NOT_ALLOWED_LIVE', `"${v.label}" is not the active settings version; only a full run may use it (its results are labelled backtest)`, { active: active.label });
    sel = { id: v.id, label: v.label, values: v.values };
  }
  if (body.mode === 'live' && body.names.some((n) => n.as_of !== undefined)) {
    throw new AppError(422, 'AS_OF_LIVE_REFUSED', 'as_of is only for full (backtest) runs; a live run is as of the request time');
  }
  if (body.tranche_id !== undefined) {
    const t = await db.selectFrom('tranches').select('id').where('id', '=', body.tranche_id).executeTakeFirst();
    if (!t) throw new AppError(404, 'TRANCHE_NOT_FOUND', `No tranche "${body.tranche_id}"`);
  }
  const asOfNow = ctx.now.toISOString();
  const seen = new Set<string>();
  const items: RunItem[] = body.names.map((n, idx) => {
    const base: RunItem = {
      idx, domain: n.domain.trim().toLowerCase(), lane: n.lane, leads_ab: n.leads_ab ?? 0,
      ...(n.city !== undefined && { city: n.city }), ...(n.state !== undefined && { state: n.state }), ...(n.trade !== undefined && { trade: n.trade }),
      ...(n.price_grade !== undefined && { price_grade: n.price_grade }), ...(n.bin_usd !== undefined && { bin_usd: n.bin_usd }),
      ...(n.census_list !== undefined && { census_list: n.census_list }), ...(n.rank !== undefined && { rank: n.rank }),
      ...(body.mode === 'live' ? { as_of: asOfNow } : n.as_of !== undefined ? { as_of: n.as_of } : {}),
    };
    try {
      const d = normalizeDomain(n.domain);
      if (seen.has(d)) return { ...base, domain: d, input_error: 'DUPLICATE' };
      seen.add(d);
      return { ...base, domain: d };
    } catch (e) {
      return { ...base, input_error: causeOf(e) };
    }
  });

  const gate_plan: Partial<Record<Lane, CheckId[]>> = {};
  for (const it of items) {
    if (gate_plan[it.lane]) continue;
    const p = planFor(sel.values, it.lane, body.checks);
    if (p.length === 0) throw new AppError(422, 'VALIDATION_ERROR', `checks leaves nothing to run for lane ${it.lane}`, { lane: it.lane });
    gate_plan[it.lane] = p;
  }
  const listNames = [...new Set(Object.values(gate_plan).flat().flatMap((c) => registry[c as CheckId]?.lists ?? []))];
  const lists = await currentLists(db, listNames);
  const list_versions = Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, v.version]));

  const id = `run_${randomUUID()}`;
  await db.transaction().execute(async (trx) => {
    await trx.insertInto('screening_runs').values({
      id, created_at: ctx.now, created_by: ctx.createdBy, audit_id: ctx.auditId, mode: body.mode, backtest, settings_id: sel.id, settings_label: sel.label,
      buy_hold: sel.values.buy_hold, tranche_id: body.tranche_id ?? null,
      input: JSON.stringify({ names: items, ...(body.checks && { checks: body.checks }), ...(ctx.allowUnapprovedMethod && { allow_unapproved_method: true }), ...(ctx.testSet && { test_set: { max_answer_age_days: ctx.testSet.maxAnswerAgeDays, as_of_is_now: ctx.testSet.asOfIsNow } }) }), gate_plan: JSON.stringify(gate_plan),
      list_versions: JSON.stringify(list_versions), status: 'running',
      deadline_at: new Date(ctx.now.getTime() + (ctx.deadlineHours !== undefined ? ctx.deadlineHours * 3_600_000 : sel.values.run.time_budget_minutes * 60_000)),
    }).execute();
    for (const it of items.filter((i) => i.input_error)) {
      await trx.insertInto('screening_results').values({
        run_id: id, item_idx: it.idx, domain: it.domain, lane: it.lane, check_id: 'form', gate: GATE_OF.form, rule_ids: ['INPUT'],
        status: 'FAIL', reason_code: 'INPUT_INVALID', reason: `${it.input_error}: ${CAUSE_TEXT[it.input_error as keyof typeof CAUSE_TEXT]}`,
        fields: JSON.stringify({ cause: it.input_error, input: body.names[it.idx]!.domain }), checked_at: ctx.now, settings_label: sel.label,
        list_versions: '{}', duration_ms: 0, upstream_calls: 0, source: 'auto',
      }).execute();
    }
  });
  return { id, status: 'running', mode: body.mode, backtest, settings_version: sel.label, buy_hold: sel.values.buy_hold, names_n: items.length };
}

export interface AssembledItem { item: RunItem; plan: CheckId[]; rows: ResultRow[]; derived: Derived }
export interface AssembledRun {
  items: AssembledItem[];
  funnel: Funnel;
  progress: { checks_planned: number; checks_done: number };
}

/**
 * A backtest never yields a buy card: the hold also applies when the run's settings version is not (or no longer) the active one.
 * Returns the `buyHold` flag to give deriveItem.
 */
export async function effectiveHold(db: Kysely<Database>, run: { buy_hold: boolean; backtest: boolean; settings_label: string }): Promise<boolean> {
  if (run.buy_hold || run.backtest) return true;
  return (await activeSelectionSettings(db)).label !== run.settings_label;
}

/**
 * Throws 409 NOT_SCREENED_OK when the run is a backtest (reason BACKTEST) or used a cut plan, a `checks` subset or any lane plan narrower than the
 * settings' full plan (reason PARTIAL_PLAN). Only a full-plan, non-backtest run admits a name to a tranche or a pack.
 */
export function fullPlanRunOrThrow(run: { id: string; backtest: boolean; gate_plan: unknown; input: unknown }, sel: { values: SelectionValuesT }): void {
  if (run.backtest) throw new AppError(409, 'NOT_SCREENED_OK', 'A backtest run never makes a name eligible', { run_id: run.id, reason: 'BACKTEST' });
  const gp = run.gate_plan as Partial<Record<Lane, CheckId[]>>;
  const cut = Object.entries(gp).some(([lane, plan]) => JSON.stringify(plan) !== JSON.stringify(planFor(sel.values, lane as Lane)));
  if (cut || (run.input as { checks?: unknown }).checks !== undefined) {
    throw new AppError(409, 'NOT_SCREENED_OK', 'The run used a cut plan (checks subset); only a full-plan run admits a name', { run_id: run.id, reason: 'PARTIAL_PLAN' });
  }
}

/** Items with their latest results, final status and the funnel. `runDone`: no more results will come (done or partial). */
export function assemble(
  items: RunItem[], plan: Partial<Record<Lane, CheckId[]>>, rows: ResultRow[], values: SelectionValuesT, buyHold: boolean, runDone: boolean, live = true,
): AssembledRun {
  const byItem = new Map<number, ResultRow[]>();
  for (const r of rows) (byItem.get(r.item_idx) ?? byItem.set(r.item_idx, []).get(r.item_idx)!).push(r);
  const features = values.run.feature_checks as CheckId[];
  let planned = 0;
  let done = 0;
  const out: AssembledItem[] = items.map((item) => {
    const p = plan[item.lane] ?? [];
    // A stale row counts as missing for every reader (status, funnel, progress, the GET view, tranche admission) until its recompute lands.
    const all = byItem.get(item.idx) ?? [];
    const stale = item.input_error ? new Set<CheckId>() : staleChecks(latestByCheck(all), p);
    const rs = stale.size === 0 ? all : all.filter((r) => !stale.has(r.check_id));
    if (stale.size > 0) byItem.set(item.idx, rs);
    const derived = deriveItem(rs, p, features, buyHold, runDone, live);
    if (!item.input_error) {
      planned += p.length;
      const latest = latestByCheck(rs);
      done += p.filter((c) => latest.has(c)).length;
    }
    return { item, plan: p, rows: rs, derived };
  });
  return {
    items: out,
    funnel: funnel(out.map((o) => ({ idx: o.item.idx, lane: o.item.lane, derived: o.derived })), byItem, plan),
    progress: { checks_planned: planned, checks_done: done },
  };
}

export interface ScreeningWorkerDeps {
  db: Kysely<Database>;
  now: () => number;
  log: { warn(o: object, m: string): void; error(o: object, m: string): void };
  screening: ScreeningDeps;
  /** Test-only: stop (as if the process died) after this many results written by the first execution. */
  stopAfterResults?: number;
}

type RunRow = Selectable<Database['screening_runs']>;

export const loadRows = async (db: Kysely<Database>, runId: string): Promise<ResultRow[]> =>
  (await db.selectFrom('screening_results').selectAll().where('run_id', '=', runId).orderBy('id').execute()).map(toResultRow);

/** Recomputes the funnel summary of a run that has ended (also after a manual record changes a name). */
export async function refreshSummary(db: Kysely<Database>, run: RunRow): Promise<void> {
  if (run.status === 'running') return;
  const sel = await selectionSettingsByLabel(db, run.settings_label);
  if (!sel) return;
  const items = (run.input as { names: RunItem[] }).names;
  const a = assemble(items, run.gate_plan as Partial<Record<Lane, CheckId[]>>, await loadRows(db, run.id), sel.values, await effectiveHold(db, run), true, run.mode === 'live');
  await db.updateTable('screening_runs').set({ summary: JSON.stringify({ ...a.funnel, progress: a.progress }) }).where('id', '=', run.id).execute();
}

export class ScreeningWorker {
  /** The registry in use: a copy of CHECKS, so tests can plug a fake check in without touching the shared one. */
  readonly checks: Partial<Record<CheckId, Check>> = { ...CHECKS };
  private stopAfterResults: number | undefined;
  private readonly active = new Map<string, Promise<void>>();
  /** Runs cancelled through this process: paced lookups and the check loop see it at once, without a database read. */
  private readonly cancelledHere = new Set<string>();
  /** Wall-clock time of the last heartbeat write / DB cancel check, per run. */
  private readonly lastHeartbeat = new Map<string, number>();
  private readonly lastCancelCheck = new Map<string, number>();

  constructor(private readonly deps: ScreeningWorkerDeps) {
    this.stopAfterResults = deps.stopAfterResults;
  }

  /** Starts the run in this process unless it is already running here. Returns at once. */
  kick(runId: string): void {
    if (this.active.has(runId)) return;
    const p: Promise<void> = this.execute(runId)
      .catch(async (e) => {
        this.deps.log.error({ err: (e as Error).message, runId }, 'screening run failed');
        // A run that keeps failing must still end: past its deadline it finishes partial with SOURCE_ERROR rows.
        await this.closeOut(runId, 'SOURCE_ERROR', String((e as Error).message ?? e).slice(0, 200), true).catch(() => {});
      })
      .finally(() => { if (this.active.get(runId) === p) this.active.delete(runId); this.lastHeartbeat.delete(runId); this.lastCancelCheck.delete(runId); if (this.active.size === 0) settleHostPacers(this.deps.screening.sleep); });
    this.active.set(runId, p);
  }

  /**
   * v2.9.0 (CR-010 F-1): cancels a `running` run. The status moves to `cancelled` first (a finishing worker's `done` then loses), the in-memory flag
   * stops this process's paced lookups and check loop, and every open check of a name that is not already stopped gets UNKNOWN `CANCELLED`
   * (results already written are kept). Returns null when the run is not `running` (the caller reads its status).
   */
  async cancel(runId: string, by: string, _reason?: string): Promise<{ cancelled_at: Date } | null> {
    const { db } = this.deps;
    this.cancelledHere.add(runId);
    const at = new Date(this.deps.now());
    const r = await db.updateTable('screening_runs').set({ status: 'cancelled', finished_at: at, cancelled_at: at, cancelled_by: by })
      .where('id', '=', runId).where('status', '=', 'running').executeTakeFirst();
    if (Number(r.numUpdatedRows) === 0) { this.cancelledHere.delete(runId); return null; }
    await this.closeCancelled(runId);
    return { cancelled_at: at };
  }

  /** Whether the run was cancelled through this process (synchronous; handed to checks as `isCancelled`). */
  isCancelled(runId: string): boolean { return this.cancelledHere.has(runId); }

  /** Cross-process check used between checks: this process's flag, else the stored status. */
  private async cancelledNow(runId: string): Promise<boolean> {
    if (this.cancelledHere.has(runId)) return true;
    const t = Date.now();
    const last = this.lastCancelCheck.get(runId);
    if (last !== undefined && t - last < CANCEL_CHECK_EVERY_MS) return false;
    this.lastCancelCheck.set(runId, t);
    const st = await this.deps.db.selectFrom('screening_runs').select('status').where('id', '=', runId).executeTakeFirst();
    return st?.status === 'cancelled';
  }

  /** Starts it if needed and resolves when this process has finished (or stopped) working on it. */
  async runToEnd(runId: string): Promise<void> {
    this.kick(runId);
    await this.active.get(runId);
  }

  /** Waits for every run this process is working on (app shutdown, tests). */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.active.values()]);
  }

  /**
   * Running runs this process is not working on: past the deadline they are finalised (`partial`), else resumed when the
   * heartbeat is missing or older than HEARTBEAT_STALE_MS. Called by the daily job (and the tick). `finalized` lists only runs whose status changed.
   */
  async resumeStalled(): Promise<{ resumed: string[]; finalized: string[] }> {
    const now = this.deps.now();
    const rows = await this.deps.db.selectFrom('screening_runs').select(['id', 'deadline_at', 'heartbeat_at']).where('status', '=', 'running').execute();
    const resumed: string[] = [];
    const finalized: string[] = [];
    for (const r of rows) {
      if (this.active.has(r.id)) continue;
      if (now >= r.deadline_at.getTime()) {
        await this.runToEnd(r.id);
        await this.closeOut(r.id, 'TIMEOUT', 'The run ran out of its time budget before this check', true); // a no-op when execute already ended it
        const st = await this.deps.db.selectFrom('screening_runs').select('status').where('id', '=', r.id).executeTakeFirst();
        if (st && st.status !== 'running') finalized.push(r.id);
      } else if (!r.heartbeat_at || now - r.heartbeat_at.getTime() > HEARTBEAT_STALE_MS) {
        this.kick(r.id);
        resumed.push(r.id);
      }
    }
    return { resumed, finalized };
  }

  /** Inserts one result row. null when the (item, check, generation) already has an automatic row (a racing worker wrote it first). */
  private async insertRow(
    run: RunRow, it: RunItem, checkId: CheckId, o: CheckOutcome,
    meta: { source: 'auto' | 'cache'; durationMs: number; checkedAt: Date; listVersions: Record<string, number>; cachedFrom?: number; inputs?: Inputs | null },
  ): Promise<ResultRow | null> {
    const { db } = this.deps;
    try {
      const r = await db.insertInto('screening_results').values({
        run_id: run.id, item_idx: it.idx, domain: it.domain, lane: it.lane, check_id: checkId, gate: GATE_OF[checkId],
        rule_ids: this.checks[checkId]?.ruleIds ?? [], status: o.status, reason_code: o.reasonCode, reason: o.reason,
        fields: JSON.stringify(o.fields), data_as_of: o.dataAsOf, checked_at: meta.checkedAt, settings_label: run.settings_label,
        list_versions: JSON.stringify(meta.listVersions), duration_ms: Math.max(0, Math.round(meta.durationMs)), upstream_calls: o.upstreamCalls,
        evidence_ids: o.evidenceIds.map(String), source: meta.source, cached_from: meta.cachedFrom === undefined ? null : String(meta.cachedFrom), generation: String(generationOf(meta.inputs ?? null)), inputs: meta.inputs ? JSON.stringify(meta.inputs) : null,
      }).returningAll().executeTakeFirstOrThrow();
      const t = Date.now();
      const last = this.lastHeartbeat.get(run.id);
      if (last === undefined || t - last >= HEARTBEAT_EVERY_MS) {
        this.lastHeartbeat.set(run.id, t);
        await db.updateTable('screening_runs').set({ heartbeat_at: new Date(this.deps.now()) }).where('id', '=', run.id).execute();
      }
      return toResultRow(r);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return null;
      throw e;
    }
  }

  /** Ends a run: sets the status (only while it is still `running`) and stores the funnel. Returns whether this call ended it. */
  private async finalize(run: RunRow, status: 'done' | 'partial'): Promise<boolean> {
    const { db } = this.deps;
    const sel = await selectionSettingsByLabel(db, run.settings_label);
    const a = assemble((run.input as { names: RunItem[] }).names, run.gate_plan as Partial<Record<Lane, CheckId[]>>, await loadRows(db, run.id), sel!.values, await effectiveHold(db, run), true, run.mode === 'live');
    const r = await db.updateTable('screening_runs').set({ status, finished_at: new Date(this.deps.now()), summary: JSON.stringify({ ...a.funnel, progress: a.progress }) })
      .where('id', '=', run.id).where('status', '=', 'running').executeTakeFirst();
    return Number(r.numUpdatedRows) > 0;
  }

  /**
   * Past the deadline (or `force`d when execute failed and the deadline passed): every open check of a name that is not already
   * stopped becomes UNKNOWN (`code`), then the run is `partial`. Reads only the database, so it works when execute cannot.
   */
  private async closeOut(runId: string, code: 'TIMEOUT' | 'SOURCE_ERROR', reason: string, onlyPastDeadline: boolean): Promise<void> {
    const { db } = this.deps;
    const run = await db.selectFrom('screening_runs').selectAll().where('id', '=', runId).executeTakeFirst();
    if (!run || run.status !== 'running') return;
    if (onlyPastDeadline && this.deps.now() < run.deadline_at.getTime()) return;
    await this.fillOpen(run, code, reason);
    await this.finalize(run, 'partial');
  }

  /** The run was just set to `cancelled`: open checks become UNKNOWN CANCELLED and the funnel summary is stored. */
  private async closeCancelled(runId: string): Promise<void> {
    const { db } = this.deps;
    const run = await db.selectFrom('screening_runs').selectAll().where('id', '=', runId).executeTakeFirstOrThrow();
    await this.fillOpen(run, 'CANCELLED', 'The run was cancelled before this check');
    await refreshSummary(db, run);
  }

  /** Every open (or stale) check of a name that is not already stopped becomes UNKNOWN (`code`). */
  private async fillOpen(run: RunRow, code: 'TIMEOUT' | 'SOURCE_ERROR' | 'CANCELLED', reason: string): Promise<void> {
    const { db } = this.deps;
    const runId = run.id;
    const sel = await selectionSettingsByLabel(db, run.settings_label);
    const features = sel!.values.run.feature_checks;
    const plan = run.gate_plan as Partial<Record<Lane, CheckId[]>>;
    const latest = new Map<number, Map<CheckId, ResultRow>>();
    const by = new Map<number, ResultRow[]>();
    for (const r of await loadRows(db, runId)) (by.get(r.item_idx) ?? by.set(r.item_idx, []).get(r.item_idx)!).push(r);
    for (const [idx, rs] of by) latest.set(idx, latestByCheck(rs));
    for (const it of (run.input as { names: RunItem[] }).names) {
      if (it.input_error) continue;
      const all = latest.get(it.idx) ?? new Map<CheckId, ResultRow>();
      const p = plan[it.lane] ?? [];
      // A stale row is as good as missing (as in load()): it gets the UNKNOWN row too, so no name ends on a pre-record PASS.
      const have = new Map(all);
      for (const c of staleChecks(all, p)) have.delete(c);
      const stopped = run.mode === 'live' && p.some((c) => !features.includes(c) && ['FAIL', 'UNKNOWN'].includes(have.get(c)?.status ?? ''));
      if (stopped) continue;
      for (const c of p) {
        if (have.has(c)) continue;
        const row = await this.insertRow(run, it, c, outcome('UNKNOWN', code, reason), { source: 'auto', durationMs: 0, checkedAt: new Date(this.deps.now()), listVersions: {}, inputs: inputsOf(all, c) });
        if (row) { all.set(c, row); have.set(c, row); } // later checks of the name record this row as their input
      }
    }
  }

  private async execute(runId: string): Promise<void> {
    const { db } = this.deps;
    const run = await db.selectFrom('screening_runs').selectAll().where('id', '=', runId).executeTakeFirst();
    if (!run || run.status !== 'running') return;
    const sel = await selectionSettingsByLabel(db, run.settings_label);
    if (!sel) throw new Error(`settings ${run.settings_label} vanished`);
    const values = sel.values;
    const input = run.input as { names: RunItem[]; checks?: CheckId[] };
    const items = input.names;
    const plan = run.gate_plan as Partial<Record<Lane, CheckId[]>>;
    const versions = run.list_versions as Record<string, number>;
    const lists: Record<string, { version: number; terms: string[] }> = {};
    for (const [name, v] of Object.entries(versions)) {
      const l = await listVersion(db, name, v);
      if (l) lists[name] = { version: l.version, terms: l.terms };
    }
    const lexicon = buildLexicon(loadDataLexicon(), lists, { cityOneToken: values.form.geo_city_one_token, cityWordAllowlist: values.form.city_word_allowlist });
    const runView: RunView = { id: run.id, mode: run.mode, backtest: run.backtest, buyHold: run.buy_hold, trancheId: run.tranche_id, createdAt: run.created_at, allowUnapprovedMethod: (run.input as { allow_unapproved_method?: boolean }).allow_unapproved_method === true };
    const tsIn = (run.input as { test_set?: { max_answer_age_days: number; as_of_is_now: boolean } }).test_set;
    if (tsIn) runView.testSet = { maxAnswerAgeDays: tsIn.max_answer_age_days, asOfIsNow: tsIn.as_of_is_now === true };
    let deadline = run.deadline_at.getTime();
    const features = values.run.feature_checks;
    const order = [...items].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.idx - b.idx);

    const state = new Map<number, Map<CheckId, ResultRow>>();
    // Checks whose in-force row an earlier dependency outdated: dropped from `state` so the loop below recomputes them (appending a row), never cached.
    const staleByItem = new Map<number, Set<CheckId>>();
    const load = async () => {
      state.clear();
      staleByItem.clear();
      const by = new Map<number, ResultRow[]>();
      for (const r of await loadRows(db, runId)) (by.get(r.item_idx) ?? by.set(r.item_idx, []).get(r.item_idx)!).push(r);
      for (const [idx, m] of by) {
        const latest = latestByCheck(m);
        const it = items.find((i) => i.idx === idx);
        const stale = it && !it.input_error ? staleChecks(latest, plan[it.lane] ?? []) : new Set<CheckId>();
        for (const c of stale) latest.delete(c);
        if (stale.size > 0) staleByItem.set(idx, stale);
        state.set(idx, latest);
      }
    };
    await load();
    const latestOf = (idx: number) => state.get(idx) ?? state.set(idx, new Map()).get(idx)!;
    const gating = (it: RunItem) => (plan[it.lane] ?? []).filter((c) => !isFeature(c, features));
    const hasStatus = (it: RunItem, ...st: Status[]) => gating(it).some((c) => { const r = latestOf(it.idx).get(c); return !!r && st.includes(r.status); });
    const stopped = (it: RunItem) => run.mode === 'live' && hasStatus(it, 'FAIL', 'UNKNOWN');
    const shared = new Map<string, unknown>();
    let written = 0;

    const write = async (it: RunItem, checkId: CheckId, o: CheckOutcome, meta: { source: 'auto' | 'cache'; durationMs: number; checkedAt: Date; listVersions: Record<string, number>; cachedFrom?: number; inputs?: Inputs | null }): Promise<boolean> => {
      const r = await this.insertRow(run, it, checkId, o, meta);
      if (!r) { await load(); return false; } // another worker wrote this (item, check): take its row, write nothing
      // Same precedence as derive: a manual record outranks an auto or cached row. One posted while this check ran is read back now,
      // so the stop decision below never rests on the auto row it is hiding.
      const m = (MANUAL_CHECKS as readonly string[]).includes(checkId)
        ? await db.selectFrom('screening_results').selectAll().where('run_id', '=', run.id).where('item_idx', '=', it.idx)
          .where('check_id', '=', checkId).where('source', '=', 'manual').orderBy('id', 'desc').limit(1).executeTakeFirst()
        : undefined;
      let best = latestOf(it.idx).get(checkId);
      for (const c of [r, m ? toResultRow(m) : null]) if (c && (!best || beats(c, best))) best = c;
      latestOf(it.idx).set(checkId, best!);
      staleByItem.get(it.idx)?.delete(checkId);
      written++;
      return true;
    };
    const stopNow = () => {
      if (this.stopAfterResults !== undefined && written >= this.stopAfterResults) { this.stopAfterResults = undefined; return true; }
      return false;
    };

    const merged = [...new Set(Object.values(plan).flat() as CheckId[])]; // lane lists agree on order (checked when the settings are drafted)
    // After the run ends, a manual record that landed meanwhile (a history record posted while this worker was finishing) may have staled
    // a row: the run is then reopened here too, so no record is missed whichever side commits first. Bounded; each pass only appends.
    for (let pass = 0; pass < MAX_RECOMPUTE_PASSES; pass++) {
    for (const checkId of merged) {
      for (const it of order) {
        if (it.input_error || !(plan[it.lane] ?? []).includes(checkId) || latestOf(it.idx).has(checkId) || stopped(it)) continue;
        if (await this.cancelledNow(runId)) return; // cancelled (POST .../cancel): no further lookups, no rows
        if (this.deps.now() >= deadline) return this.closeOut(runId, 'TIMEOUT', 'The run ran out of its time budget before this check', false);
        const check = this.checks[checkId];
        const t0 = this.deps.now();
        let wrote: boolean;
        const snap = new Map(latestOf(it.idx)); // what this computation reads; its dependency row ids are recorded with the row
        const inputs = inputsOf(snap, checkId);
        if (!check) {
          wrote = await write(it, checkId, outcome('NOT_RUN', 'NOT_IMPLEMENTED', `The ${checkId} check is not built yet`), { source: 'auto', durationMs: 0, checkedAt: new Date(t0), listVersions: {}, inputs });
        } else {
          const lv = Object.fromEntries(check.lists.filter((n) => versions[n] !== undefined).map((n) => [n, versions[n]!]));
          const hit = await this.cached(run, values, it, checkId, lv); // never for a check with dependencies (so never for a stale row)
          if (hit) {
            wrote = await write(it, checkId, { status: hit.status, reasonCode: hit.reason_code, reason: hit.reason, fields: hit.fields, dataAsOf: hit.data_as_of, evidenceIds: hit.evidence_ids, upstreamCalls: 0 },
              { source: 'cache', durationMs: 0, checkedAt: hit.checked_at, listVersions: hit.list_versions, cachedFrom: hit.id, inputs });
          } else {
            let o: CheckOutcome;
            try {
              o = await check.run({
                db, run: runView, item: it, settings: values, settingsLabel: run.settings_label,
                latest: (c) => snap.get(c),
                ahead: () => order.slice(0, order.indexOf(it)).filter((x) => !x.input_error && !hasStatus(x, 'FAIL')).map((x) => ({ item: x, latest: (c: CheckId) => latestOf(x.idx).get(c) })),
                lists, lexicon, deps: this.deps.screening, now: this.deps.now, deadline, shared, isCancelled: () => this.cancelledHere.has(runId),
              });
            } catch (e) {
              o = outcome('UNKNOWN', 'SOURCE_ERROR', String((e as Error).message ?? e).slice(0, 200));
            }
            if (this.cancelledHere.has(runId)) return; // the result of a check that was running while the run was cancelled is dropped
            wrote = await write(it, checkId, o, { source: 'auto', durationMs: this.deps.now() - t0, checkedAt: new Date(t0), listVersions: lv, inputs });
          }
        }
        if (wrote && stopNow()) return;
      }
    }
    if (!(await this.finalize(run, 'done'))) return;
    const fresh = await loadRows(db, runId);
    if (!recomputePending(items, plan, fresh, features, run.mode === 'live')) return;
    if (!(await reopenRun(db, runId, new Date(this.deps.now()), values.run.time_budget_minutes))) {
      const st = await db.selectFrom('screening_runs').select('status').where('id', '=', runId).executeTakeFirst();
      if (st?.status !== 'running') return; // someone else reopened it (the route): carry on
    }
    deadline = (await db.selectFrom('screening_runs').select('deadline_at').where('id', '=', runId).executeTakeFirstOrThrow()).deadline_at.getTime();
    await load();
    }
    // Passes exhausted (a pathological loop): every open or stale check becomes UNKNOWN and the run ends partial, fail-closed.
    await this.closeOut(runId, 'SOURCE_ERROR', 'Dependent checks kept changing; the recompute did not settle', false);
  }

  /**
   * Newest reusable result for (domain, check): same settings label, same backtest flag, same list versions, inside the freshness window.
   * Never when this item is as of a past date (a full run with `as_of`), and never from a run that was as of a past date: a dated
   * result is not "now". Only runs without explicit as_of (live runs, full runs that sent none) are sources.
   */
  private async cached(run: RunRow, values: SelectionValuesT, it: RunItem, checkId: CheckId, lv: Record<string, number>): Promise<ResultRow | null> {
    if (DEPENDS_ON[checkId] !== undefined) return null; // a check that reads other rows of its run is never served from another run's cache
    const hours = values.freshness_hours[checkId] ?? 0;
    if (hours <= 0) return null;
    if (run.mode === 'full' && it.as_of !== undefined) return null;
    const r = await this.deps.db.selectFrom('screening_results as r').innerJoin('screening_runs as u', 'u.id', 'r.run_id').selectAll('r')
      .where('r.domain', '=', it.domain).where('r.check_id', '=', checkId).where('r.source', 'in', ['auto', 'manual'])
      .where('r.status', 'not in', ['UNKNOWN', 'NOT_RUN', 'MANUAL_REQUIRED']).where('r.settings_label', '=', run.settings_label)
      .where('u.backtest', '=', run.backtest).where('r.checked_at', '>=', new Date(this.deps.now() - hours * 3_600_000))
      .where(sql<boolean>`(u.mode = 'live' or not jsonb_path_exists(u.input, '$.names[*].as_of'))`)
      .orderBy('r.checked_at', 'desc').orderBy('r.id', 'desc').limit(1).executeTakeFirst();
    if (!r) return null;
    const row = toResultRow(r);
    return deepEqual(row.list_versions, lv) ? row : null;
  }
}
