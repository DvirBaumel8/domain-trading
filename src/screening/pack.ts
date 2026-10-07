// CAP-19 screening pack: the evidence a buy decision rests on, frozen and versioned. Built only from a finished, full-plan run's non-stale
// rows (assemble drops stale ones). A pack is complete only when every required check passed (a FLAG needs a PASS verdict on the row in force),
// availability and the quote are fresh at pack time, and the three judgment calls are PASS. An incomplete pack is issued too, with what is missing.
import { createHash, randomBytes } from 'node:crypto';
import { sql, type Kysely, type Selectable } from 'kysely';
import { z } from 'zod';
import type { Database, ScreeningPacksTable } from '../db/types.js';
import { jerusalemDeep } from '../core/dates.js';
import { AppError } from '../http/errors.js';
import { canonicalJson } from '../http/canonical-json.js';
import { quoteIsStale } from './checks/quote.js';
import { latestByCheck } from './derive.js';
import { assemble, effectiveHold, fullPlanRunOrThrow, toResultRow } from './engine.js';
import { activeSelectionSettings, selectionSettingsByLabel, type SelectionValuesT } from './settings.js';
import type { CheckId, Lane, ResultRow, RunItem } from './types.js';
import { verdictsFor, type VerdictRow } from './verdicts.js';

const Verdict = z.object({ verdict: z.enum(['PASS', 'REJECT']), reason: z.string().trim().min(1).max(300) }).strict();
// No lead spot check: leads run only after the buy decision (CR-002 CAP-14/15/16, CAP-20 step 13); a body that sends one gets 422 (strict).
export const JudgmentRecord = z.object({
  van_test: Verdict, tn1: Verdict, bigco: Verdict,
  reason_not_to_buy: z.string().trim().min(1).max(300),
  judged_by: z.string().trim().min(1).max(80), judged_at: z.iso.datetime({ offset: true }),
}).strict();
export type JudgmentT = z.infer<typeof JudgmentRecord>;

export type PackRow = Selectable<ScreeningPacksTable>;
export interface PackGate {
  check: CheckId; gate: string; rule_ids: string[]; status: string; reason_code: string | null; result_id: number | null; source: string | null;
  recorded_by: string | null; checked_at: string | null; data_as_of: string | null; fields: Record<string, unknown> | null; evidence_ids: number[];
  verdict: { verdict: 'PASS' | 'REJECT'; reason: string; decided_by: string; decided_at: string } | null; decides: boolean;
}
export interface Missing { item: string; code: string; detail: string }

const HOUR_MS = 3_600_000;
const OK = ['PASS', 'PASS_WITH_NOTE'];

/** The checks that decide a pack: the plan minus pack.exclude_checks, plus pack.require_checks, tm_eu only for eu_tm.required_lanes. */
export function requiredChecks(lane: Lane, plan: CheckId[], s: SelectionValuesT): CheckId[] {
  const req = plan.filter((c) => !s.pack.exclude_checks.includes(c));
  for (const c of s.pack.require_checks) if (!req.includes(c)) req.push(c);
  const eu = s.eu_tm.required_lanes.includes(lane);
  if (eu && !req.includes('tm_eu')) req.push('tm_eu');
  return eu ? req : req.filter((c) => c !== 'tm_eu');
}

export function assessPack(i: {
  lane: Lane; plan: CheckId[]; latest: Map<CheckId, ResultRow>; verdicts: Map<number, VerdictRow>; judgment: JudgmentT; sel: SelectionValuesT; now: number; settingsActive?: boolean;
}): { status: 'complete' | 'incomplete'; missing: Missing[]; gates: PackGate[] } {
  const required = requiredChecks(i.lane, i.plan, i.sel);
  const missing: Missing[] = [];
  const verdictOf = (r: ResultRow | undefined): VerdictRow | null => (r ? i.verdicts.get(r.id) ?? null : null);
  for (const c of required) {
    const r = i.latest.get(c);
    if (!r) {
      missing.push({ item: c, code: 'NO_RESULT', detail: i.plan.includes(c) ? `${c} has no current result in the run` : `${c} is not in this run's plan: draft a settings version whose run.gates include it` });
    } else if (OK.includes(r.status)) {
      continue;
    } else if (r.status === 'FLAG') {
      const v = verdictOf(r);
      if (!v) missing.push({ item: c, code: 'FLAG_NO_VERDICT', detail: `${c} is FLAG (${r.reason_code ?? 'no code'}) and has no verdict` });
      else if (v.verdict === 'REJECT') missing.push({ item: c, code: 'FLAG_REJECTED', detail: `${c} FLAG was rejected: ${v.reason}` });
    } else {
      missing.push({ item: c, code: r.status, detail: `${c} is ${r.status}${r.reason_code ? ` (${r.reason_code})` : ''}` });
    }
  }
  if (i.settingsActive === false) missing.push({ item: 'settings', code: 'SETTINGS_NOT_ACTIVE', detail: 'the run was screened under a settings version that is no longer the active one' });
  const av = i.latest.get('availability');
  if (av) {
    const at = Date.parse(typeof av.fields.checked_at === 'string' ? av.fields.checked_at : av.checked_at.toISOString());
    if (Number.isNaN(at) || i.now - at > i.sel.pack.availability_max_age_hours * HOUR_MS) {
      missing.push({ item: 'availability', code: 'STALE_AVAILABILITY', detail: `availability was checked more than ${i.sel.pack.availability_max_age_hours} h before the pack` });
    }
  }
  const q = i.latest.get('quote');
  if (q && OK.includes(q.status)) {
    const at = Date.parse(String(q.fields.quoted_at));
    const tooOld = !Number.isNaN(at) && q.fields.quote_source !== 'manual' && i.now - at > i.sel.pack.availability_max_age_hours * HOUR_MS;
    if (tooOld || quoteIsStale(q.fields, i.sel.quote, i.now)) missing.push({ item: 'quote', code: 'STALE_QUOTE', detail: 'the quote is too old at pack time' });
  }
  for (const k of ['van_test', 'tn1', 'bigco'] as const) {
    if (i.judgment[k].verdict === 'REJECT') missing.push({ item: k, code: 'JUDGMENT_REJECTED', detail: `${k}: ${i.judgment[k].reason}` });
  }
  const checks = [...new Set<CheckId>([...i.plan, ...required])];
  const gates: PackGate[] = checks.map((c) => {
    const r = i.latest.get(c);
    const v = verdictOf(r);
    return {
      check: c, gate: r?.gate ?? '', rule_ids: r?.rule_ids ?? [], status: r?.status ?? 'NO_RESULT', reason_code: r?.reason_code ?? null, result_id: r?.id ?? null,
      source: r?.source ?? null, recorded_by: r?.recorded_by ?? null, checked_at: r?.checked_at.toISOString() ?? null, data_as_of: r?.data_as_of?.toISOString() ?? null,
      fields: r?.fields ?? null, evidence_ids: r?.evidence_ids ?? [],
      verdict: v ? { verdict: v.verdict, reason: v.reason, decided_by: v.decided_by, decided_at: v.decided_at.toISOString() } : null,
      decides: required.includes(c),
    };
  });
  return { status: missing.length === 0 ? 'complete' : 'incomplete', missing, gates };
}

const pick = (f: Record<string, unknown> | undefined, keys: string[]): Record<string, unknown> | null =>
  f ? Object.fromEntries(keys.map((k) => [k, f[k] ?? null])) : null;

export async function issuePack(db: Kysely<Database>, i: { runId: string; domain: string; judgment: JudgmentT; by: string; auditId: string | null; now: Date }): Promise<{ row: PackRow; created: boolean }> {
  // Everything is read inside one transaction, after the per-domain lock and the run-row lock (a manual record and a verdict take the run-row
  // lock too), so the pack always reflects the rows and verdicts committed before it and a later one cannot slip in half-way.
  return db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${'pack:' + i.domain}))`.execute(trx);
    const run = await trx.selectFrom('screening_runs').selectAll().where('id', '=', i.runId).forUpdate().executeTakeFirst();
    if (!run) throw new AppError(404, 'RUN_NOT_FOUND', `No screening run "${i.runId}"`);
    if (run.status === 'running') throw new AppError(409, 'RUN_RUNNING', 'The run is still running; a pack is built from a finished run only', { run_id: run.id, reason: 'RUNNING' });
    const sel = (await selectionSettingsByLabel(trx, run.settings_label))!;
    fullPlanRunOrThrow(run, sel);
    const judgedAt = Date.parse(i.judgment.judged_at);
    if (judgedAt > i.now.getTime() + 60_000) throw new AppError(422, 'JUDGED_AT_INVALID', 'judged_at is in the future');
    if (judgedAt < run.created_at.getTime()) throw new AppError(422, 'JUDGED_AT_INVALID', 'judged_at is earlier than the run it judges', { run_created_at: run.created_at.toISOString() });
    const rows = (await trx.selectFrom('screening_results').selectAll().where('run_id', '=', run.id).orderBy('id').execute()).map(toResultRow);
    const hold = await effectiveHold(trx, run);
    const a = assemble((run.input as { names: RunItem[] }).names, run.gate_plan as Partial<Record<Lane, CheckId[]>>, rows, sel.values, hold, true, run.mode === 'live');
    const it = a.items.find((x) => x.item.domain === i.domain && !x.item.input_error);
    if (!it) throw new AppError(404, 'NAME_NOT_IN_RUN', `"${i.domain}" is not a screened name of run ${run.id}`);
    const latest = latestByCheck(it.rows);
    const verdicts = await verdictsFor(trx, run.id);
    const settingsActive = (await activeSelectionSettings(trx)).label === run.settings_label;
    const res = assessPack({ lane: it.item.lane, plan: it.plan, latest, verdicts, judgment: i.judgment, sel: sel.values, now: i.now.getTime(), settingsActive });
    const content = jerusalemDeep({
      domain: i.domain, lane: it.item.lane, run_id: run.id, settings_version: run.settings_label, settings_label: run.settings_label, settings_active: settingsActive,
      buy_hold_effective: hold, list_versions: run.list_versions,
      screened_at: run.created_at.toISOString(), screened_by: run.created_by, status: res.status, missing: res.missing, gates: res.gates, judgment: i.judgment,
      money: pick(latest.get('price')?.fields, ['ev_cents', 'ratio_at_bin', 'ratio_at_floor', 'bin_in_allowed_set', 'floor_cents', 'bin_cents']),
      quote: pick(latest.get('quote')?.fields, ['registrar', 'first_year_cents', 'renewal_cents', 'registrar_ft_capable', 'quoted_at', 'quote_source']),
    }); // BUG-2: frozen with the Asia/Jerusalem offset, so the stored bytes, the hash and the response agree
    const sha = createHash('sha256').update(canonicalJson(content)).digest('hex');
    const last = await trx.selectFrom('screening_packs').selectAll().where('domain', '=', i.domain).orderBy('version', 'desc').limit(1).executeTakeFirst();
    if (last && last.content_sha256 === sha) return { row: last, created: false };
    const row = await trx.insertInto('screening_packs').values({
      id: `pk_${randomBytes(6).toString('hex')}`, domain: i.domain, version: (last?.version ?? 0) + 1, run_id: run.id, item_idx: it.item.idx, status: res.status,
      missing: JSON.stringify(res.missing), content: JSON.stringify(content), content_sha256: sha, settings_label: run.settings_label,
      issued_at: i.now, issued_by: i.by, audit_id: i.auditId,
    }).returningAll().executeTakeFirstOrThrow();
    return { row, created: true };
  });
}

export async function latestPackFor(db: Kysely<Database>, domain: string): Promise<PackRow | null> {
  return (await db.selectFrom('screening_packs').selectAll().where('domain', '=', domain).orderBy('version', 'desc').limit(1).executeTakeFirst()) ?? null;
}
