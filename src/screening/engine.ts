// CAP-20 screening run engine. A run is persisted per (item, check): Render free sleeps, so a run resumes where it stopped
// (the hourly tick and the next poll call resumeStalled/kick). Results are append-only; a check that is not built yet answers
// NOT_RUN / NOT_IMPLEMENTED; a run that outlives its time budget finishes as `partial` with every open check UNKNOWN / TIMEOUT.
import { randomUUID } from 'node:crypto';
import type { Kysely, Selectable } from 'kysely';
import type { Database, ScreeningResultsTable } from '../db/types.js';
import { normalizeDomain } from '../domain-name.js';
import { AppError } from '../http/errors.js';
import { CHECKS, GATE_OF } from './checks/index.js';
import { deriveItem, funnel, latestByCheck, type Derived, type Funnel } from './derive.js';
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
    cached_from: r.cached_from === null ? null : Number(r.cached_from), recorded_by: r.recorded_by,
  };
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
  db: Kysely<Database>, body: RunBody, ctx: { createdBy: string; auditId: string; now: Date }, registry: Partial<Record<CheckId, Check>> = CHECKS,
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
      input: JSON.stringify({ names: items, ...(body.checks && { checks: body.checks }) }), gate_plan: JSON.stringify(gate_plan),
      list_versions: JSON.stringify(list_versions), status: 'running',
      deadline_at: new Date(ctx.now.getTime() + sel.values.run.time_budget_minutes * 60_000),
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

/** Items with their latest results, final status and the funnel. `runDone`: no more results will come (done or partial). */
export function assemble(
  items: RunItem[], plan: Partial<Record<Lane, CheckId[]>>, rows: ResultRow[], values: SelectionValuesT, buyHold: boolean, runDone: boolean,
): AssembledRun {
  const byItem = new Map<number, ResultRow[]>();
  for (const r of rows) (byItem.get(r.item_idx) ?? byItem.set(r.item_idx, []).get(r.item_idx)!).push(r);
  const features = values.run.feature_checks as CheckId[];
  let planned = 0;
  let done = 0;
  const out: AssembledItem[] = items.map((item) => {
    const p = plan[item.lane] ?? [];
    const rs = byItem.get(item.idx) ?? [];
    const derived = deriveItem(rs, p, features, buyHold, runDone);
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
}

export class ScreeningWorker {
  /** The registry in use: a copy of CHECKS, so tests can plug a fake check in without touching the shared one. */
  readonly checks: Partial<Record<CheckId, Check>> = { ...CHECKS };
  /** Test hook: stop (as if the process died) after this many results written by one execution; cleared when it fires. */
  stopAfterResults: number | undefined;
  private readonly active = new Map<string, Promise<void>>();

  constructor(private readonly deps: ScreeningWorkerDeps) {}

  /** Starts the run in this process unless it is already running here. Returns at once. */
  kick(runId: string): void {
    if (this.active.has(runId)) return;
    const p: Promise<void> = this.execute(runId)
      .catch((e) => this.deps.log.error({ err: (e as Error).message, runId }, 'screening run failed'))
      .finally(() => { if (this.active.get(runId) === p) this.active.delete(runId); });
    this.active.set(runId, p);
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
   * heartbeat is missing or older than HEARTBEAT_STALE_MS. Called by the hourly tick.
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
        finalized.push(r.id);
      } else if (!r.heartbeat_at || now - r.heartbeat_at.getTime() > HEARTBEAT_STALE_MS) {
        this.kick(r.id);
        resumed.push(r.id);
      }
    }
    return { resumed, finalized };
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
    const runView: RunView = { id: run.id, mode: run.mode, backtest: run.backtest, buyHold: run.buy_hold, trancheId: run.tranche_id, createdAt: run.created_at };
    const deadline = run.deadline_at.getTime();
    const features = values.run.feature_checks;
    const order = [...items].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.idx - b.idx);

    const state = new Map<number, Map<CheckId, ResultRow>>();
    const load = async () => {
      state.clear();
      const rows = (await db.selectFrom('screening_results').selectAll().where('run_id', '=', runId).orderBy('id').execute()).map(toResultRow);
      const by = new Map<number, ResultRow[]>();
      for (const r of rows) (by.get(r.item_idx) ?? by.set(r.item_idx, []).get(r.item_idx)!).push(r);
      for (const [idx, m] of by) state.set(idx, latestByCheck(m));
    };
    await load();
    const latestOf = (idx: number) => state.get(idx) ?? state.set(idx, new Map()).get(idx)!;
    const gating = (it: RunItem) => (plan[it.lane] ?? []).filter((c) => !isFeature(c, features));
    const hasStatus = (it: RunItem, ...st: Status[]) => gating(it).some((c) => { const r = latestOf(it.idx).get(c); return !!r && st.includes(r.status); });
    const stopped = (it: RunItem) => run.mode === 'live' && hasStatus(it, 'FAIL', 'UNKNOWN');
    const shared = new Map<string, unknown>();
    const rowsWritten = { n: 0 };

    const write = async (it: RunItem, checkId: CheckId, o: CheckOutcome, meta: { source: 'auto' | 'cache'; durationMs: number; checkedAt: Date; listVersions: Record<string, number>; cachedFrom?: number }): Promise<boolean> => {
      try {
        const r = await db.insertInto('screening_results').values({
          run_id: runId, item_idx: it.idx, domain: it.domain, lane: it.lane, check_id: checkId, gate: GATE_OF[checkId],
          rule_ids: this.checks[checkId]?.ruleIds ?? [], status: o.status, reason_code: o.reasonCode, reason: o.reason,
          fields: JSON.stringify(o.fields), data_as_of: o.dataAsOf, checked_at: meta.checkedAt, settings_label: run.settings_label,
          list_versions: JSON.stringify(meta.listVersions), duration_ms: Math.max(0, Math.round(meta.durationMs)), upstream_calls: o.upstreamCalls,
          evidence_ids: o.evidenceIds.map(String), source: meta.source, cached_from: meta.cachedFrom === undefined ? null : String(meta.cachedFrom),
        }).returningAll().executeTakeFirstOrThrow();
        latestOf(it.idx).set(checkId, toResultRow(r));
        await db.updateTable('screening_runs').set({ heartbeat_at: new Date(this.deps.now()) }).where('id', '=', runId).execute();
        rowsWritten.n++;
        return true;
      } catch (e) {
        if ((e as { code?: string }).code !== '23505') throw e;
        await load(); // another worker wrote this (item, check): take its row, write nothing
        return false;
      }
    };
    const stopNow = () => {
      if (this.stopAfterResults !== undefined && rowsWritten.n >= this.stopAfterResults) { this.stopAfterResults = undefined; return true; }
      return false;
    };

    const finalize = async (status: 'done' | 'partial') => {
      const rows = (await db.selectFrom('screening_results').selectAll().where('run_id', '=', runId).orderBy('id').execute()).map(toResultRow);
      const a = assemble(items, plan, rows, values, run.buy_hold, true);
      await db.updateTable('screening_runs').set({ status, finished_at: new Date(this.deps.now()), summary: JSON.stringify({ ...a.funnel, progress: a.progress }) }).where('id', '=', runId).execute();
    };

    const timeoutRest = async () => {
      for (const it of order) {
        if (it.input_error || stopped(it)) continue;
        for (const c of plan[it.lane] ?? []) {
          if (latestOf(it.idx).has(c)) continue;
          await write(it, c, outcome('UNKNOWN', 'TIMEOUT', 'The run ran out of its time budget before this check', {}), {
            source: 'auto', durationMs: 0, checkedAt: new Date(this.deps.now()), listVersions: {},
          });
        }
      }
      await finalize('partial');
    };

    const merged = [...new Set(Object.values(plan).flat() as CheckId[])];
    for (const checkId of merged) {
      for (const it of order) {
        if (it.input_error || !(plan[it.lane] ?? []).includes(checkId) || latestOf(it.idx).has(checkId) || stopped(it)) continue;
        if (this.deps.now() > deadline) return timeoutRest();
        const check = this.checks[checkId];
        const t0 = this.deps.now();
        let wrote: boolean;
        if (!check) {
          wrote = await write(it, checkId, outcome('NOT_RUN', 'NOT_IMPLEMENTED', `The ${checkId} check is not built yet`), { source: 'auto', durationMs: 0, checkedAt: new Date(t0), listVersions: {} });
        } else {
          const lv = Object.fromEntries(check.lists.filter((n) => versions[n] !== undefined).map((n) => [n, versions[n]!]));
          const hit = await this.cached(run, values, it, checkId, lv);
          if (hit) {
            wrote = await write(it, checkId, { status: hit.status, reasonCode: hit.reason_code, reason: hit.reason, fields: hit.fields, dataAsOf: hit.data_as_of, evidenceIds: hit.evidence_ids, upstreamCalls: 0 },
              { source: 'cache', durationMs: 0, checkedAt: hit.checked_at, listVersions: hit.list_versions, cachedFrom: hit.id });
          } else {
            let o: CheckOutcome;
            try {
              o = await check.run({
                db, run: runView, item: it, settings: values, settingsLabel: run.settings_label,
                latest: (c) => latestOf(it.idx).get(c),
                ahead: () => order.slice(0, order.indexOf(it)).filter((x) => !x.input_error && !hasStatus(x, 'FAIL')).map((x) => ({ item: x, latest: (c: CheckId) => latestOf(x.idx).get(c) })),
                lists, lexicon, deps: this.deps.screening, now: this.deps.now, deadline, shared,
              });
            } catch (e) {
              o = outcome('UNKNOWN', 'SOURCE_ERROR', String((e as Error).message ?? e).slice(0, 200));
            }
            wrote = await write(it, checkId, o, { source: 'auto', durationMs: this.deps.now() - t0, checkedAt: new Date(t0), listVersions: lv });
          }
        }
        if (wrote && stopNow()) return;
      }
    }
    await finalize('done');
  }

  /** Newest reusable result for (domain, check): same settings label, same backtest flag, same list versions, inside the freshness window. */
  private async cached(run: { settings_label: string; backtest: boolean }, values: SelectionValuesT, it: RunItem, checkId: CheckId, lv: Record<string, number>): Promise<ResultRow | null> {
    const hours = values.freshness_hours[checkId] ?? 0;
    if (hours <= 0) return null;
    const r = await this.deps.db.selectFrom('screening_results as r').innerJoin('screening_runs as u', 'u.id', 'r.run_id').selectAll('r')
      .where('r.domain', '=', it.domain).where('r.check_id', '=', checkId).where('r.source', 'in', ['auto', 'manual'])
      .where('r.status', 'not in', ['UNKNOWN', 'NOT_RUN', 'MANUAL_REQUIRED']).where('r.settings_label', '=', run.settings_label)
      .where('u.backtest', '=', run.backtest).where('r.checked_at', '>=', new Date(this.deps.now() - hours * 3_600_000))
      .orderBy('r.checked_at', 'desc').orderBy('r.id', 'desc').limit(1).executeTakeFirst();
    if (!r) return null;
    const row = toResultRow(r);
    return deepEqual(row.list_versions, lv) ? row : null;
  }
}
