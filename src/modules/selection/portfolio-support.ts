// v4.0.0 (CR-044 item 6, CR-045 item 1): two reads the portfolio jobs need from the selection module: the screened-but-not-judged names of recent runs (the monthly holdout
// pool) and a re-run of the lookalike check (CR-043) for one name, outside any screening run. Nothing here writes a screening row.
import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { lookalikesCheck } from './checks/lookalikes.js';
import { assemble, effectiveHold, fullPlanRunOrThrow, loadRows } from './engine.js';
import { currentLists } from './lists.js';
import { activeSelectionSettings } from './settings.js';
import type { CheckContext, CheckId, Lane, RunItem, ScreeningDeps } from './types.js';

export interface ScreenedName { domain: string; run_id: string; passed: boolean }

/** Newest screening of each domain among the finished, non-backtest, full-plan runs created since `since` on the active settings: passed (buy candidate) or failed (rejected). Other statuses are left out. */
export async function screenedNames(db: Kysely<Database>, since: Date): Promise<ScreenedName[]> {
  const sel = await activeSelectionSettings(db);
  const runs = await db.selectFrom('screening_runs').selectAll().where('created_at', '>=', since).where('backtest', '=', false).where('status', '=', 'done')
    .where('settings_label', '=', sel.label).orderBy('created_at', 'desc').orderBy('id', 'desc').execute();
  const seen = new Set<string>();
  const out: ScreenedName[] = [];
  for (const run of runs) {
    try { fullPlanRunOrThrow(run, sel); } catch { continue; }
    const hold = await effectiveHold(db, run);
    const a = assemble((run.input as { names: RunItem[] }).names, run.gate_plan as Partial<Record<Lane, CheckId[]>>, await loadRows(db, run.id), sel.values, hold, true, run.mode === 'live');
    for (const it of a.items) {
      if (it.item.input_error || seen.has(it.item.domain)) continue;
      seen.add(it.item.domain);
      const st = it.derived.final_status;
      if (st === 'buy_candidate' || st === 'would_buy') out.push({ domain: it.item.domain, run_id: run.id, passed: true });
      else if (st === 'rejected') out.push({ domain: it.item.domain, run_id: run.id, passed: false });
    }
  }
  return out;
}

export interface LookalikeCounts { registered_n: number | null; in_use_n: number | null; unknown_n: number | null }

/** The CR-043 lookalike check for one name, today. The word split comes from the name's newest stored `form` result (else the whole SLD). Returns null when the check cannot run. */
export async function rerunLookalikes(db: Kysely<Database>, deps: ScreeningDeps, domain: string, now: () => number, timeBudgetMs = 120_000): Promise<LookalikeCounts | null> {
  const values = (await activeSelectionSettings(db)).values;
  if (!values.lookalikes.enabled) return null;
  const form = await db.selectFrom('screening_results').select('fields').where('domain', '=', domain).where('check_id', '=', 'form').orderBy('checked_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
  const tokens = Array.isArray((form?.fields as { tokens?: unknown } | undefined)?.tokens) ? (form!.fields as { tokens: string[] }).tokens : [domain.replace(/\.com$/, '')];
  const lists = await currentLists(db, ['sig_parked', 'sig_forsale']);
  const ctx = {
    db, run: { id: 'portfolio', mode: 'live', backtest: false, buyHold: false, trancheId: null, createdAt: new Date(now()) }, item: { idx: 0, domain, lane: 'S3', leads_ab: 0 },
    settings: values, settingsLabel: 'portfolio-lookalikes',
    latest: (c: CheckId) => (c === 'form' ? ({ fields: { tokens } } as never) : undefined), ahead: () => [], lists,
    lexicon: { types: new Map(), versions: {} }, deps, now, deadline: now() + timeBudgetMs, shared: new Map<string, unknown>(),
  } as unknown as CheckContext;
  const r = await lookalikesCheck.run(ctx);
  if (r.status !== 'PASS') return null;
  const l = (r.fields as { lookalikes?: LookalikeCounts }).lookalikes;
  return l ? { registered_n: l.registered_n, in_use_n: l.in_use_n, unknown_n: l.unknown_n } : null;
}
