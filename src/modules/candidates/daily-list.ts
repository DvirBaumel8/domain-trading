// v2.14.0 (CR-012 part B): the daily buy-ready list. Built once per IDT day by the daily step `buildDailyList` (a manual build appends a new version),
// stored append-only, read with GET /candidates/daily. It only reads the database: no registrar, no marketplace, no new lookup. It never carries the
// private walk-away, and nothing in it is an approval.
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { addDays, idtDay } from '../../core/dates.js';
import type { Database } from '../../db/types.js';
import { leftoverNames, namesDroppingBetween } from './drop-lists.js';
import { formatUsd } from '../../core/money.js';
import { priceFormula } from '../listing/index.js';
import { currentSettings } from '../listing/index.js';
import { buyBlocks } from '../buying/index.js';
import { latestByCheck } from '../selection/index.js';
import { RECORD_FRESH_DAYS, RECORD_KINDS, isFresh, freshDomainRecord, type RecordKind } from '../selection/index.js';
import { assemble, effectiveHold, fullPlanRunOrThrow, loadRows, type ScreeningWorker } from '../selection/index.js';
import { advisoryXactLock } from '../../core/locks.js';
import { OWNED_STATUSES } from './intake.js';
import { activeSelectionSettings, laneFitter, loadSplitV2, splitV2 } from '../selection/index.js';
import type { CheckId, Lane, ResultRow, RunItem } from '../selection/index.js';

export const DAILY_LIST_DEFAULT_LIMIT = 10;
export const DAILY_LIST_MAX_LIMIT = 25;
/** How long buildDailyList waits for the day's intake screening run before it builds from what is done (the list is then marked partial). */
export const DAILY_LIST_WAIT_MS = 20 * 60_000;
/** A screening run older than this is too old for the list (the /buy pack rule). */
export const DAILY_LIST_RUN_MAX_AGE_HOURS = 72;
const HOUR_MS = 3_600_000;
/** Checks that cannot answer for a name that is still registered: they wait for the drop (`upcoming` names only). */
const NEEDS_AVAILABLE: CheckId[] = ['quote', 'price'];

type Json = Record<string, unknown>;
interface Source { source: string; received_at: string; token_name: string }
interface Missing { kind: RecordKind; reason: 'NO_RECORD' | 'STALE' }

export interface DailyEntry extends Json {
  domain: string; rank: number; run_id: string; settings_version: string; lane: string; final_status: string; held: boolean; would_be_blocked: string[];
  changed_since_first?: { reason: string; changes: string[] };
}
export interface DailyList { day: string; entries: DailyEntry[]; sections: { almost_ready: Json[]; upcoming: Json[]; removed_since_first?: Json[] }; summary: Json }

/** The most names `summary.dropping` lists (the count `dropping_n` is always the whole number). */
export const DROPPING_LIST_MAX = 50;
/** The most names `summary.rejected` lists (v3.3.0; `rejected_n` is the whole number). */
export const REJECTED_LIST_MAX = 30;
const CHECK_LABEL: Record<string, string> = {
  form: 'name form', quote: 'price quote', price: 'price check', history: 'history check', tier: 'demand check', web_risk: 'web-risk check', surbl: 'blocklist check',
  same_name: 'same-name check', tm_us: 'US trademark check', tm_eu: 'EU trademark check', typo: 'typo check', census: 'census check', ext_dates: 'other-extension check',
};
const names = (n: number) => `${n} ${n === 1 ? 'name' : 'names'}`;
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

/**
 * v3.2.0 (CR-018 B): one plain sentence group from the summary facts, rebuilt with every build or rebuild (never a stored string): what was screened, what failed and why,
 * what timed out, what waits for records, what is still dropping, what fits no kept lane, what passed, what waits for tomorrow, and whether screening is still running.
 */
export function buildWhy(sm: Json): string {
  const screened = num(sm.screened_today);
  const passed = num(sm.candidates_n);
  const failed = (sm.failed_by_check ?? {}) as Record<string, number>;
  const unknown = (sm.unknown_by_reason ?? {}) as Record<string, number>;
  const out: string[] = [];
  if (screened === 0) {
    out.push('No names were screened today.');
  } else {
    const bits: string[] = [];
    if (failed.availability) bits.push(`${failed.availability} already taken`);
    // v3.3.0 (CR-023 E): the failing check per lane, e.g. "6 failed the demand check (S6: 3, S4: 2, S3: 1)".
    const byLane = (sm.failed_by_check_lane ?? {}) as Record<string, Record<string, number>>;
    const laneText = (check: string): string => {
      const l = Object.entries(byLane[check] ?? {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      return l.length === 0 ? '' : ` (${l.map(([lane, n]) => `${lane}: ${n}`).join(', ')})`;
    };
    for (const [check, n] of Object.entries(failed)) if (check !== 'availability' && n > 0) bits.push(`${n} failed the ${CHECK_LABEL[check] ?? `${check} check`}${laneText(check)}`);
    const timedOut = unknown.TIMEOUT ?? 0;
    if (timedOut > 0) bits.push(`${timedOut} timed out`);
    const manual = Object.entries(unknown).filter(([k]) => k.startsWith('MANUAL_REQUIRED')).reduce((a, [, n]) => a + n, 0);
    const other = Object.entries(unknown).filter(([k]) => k !== 'TIMEOUT' && !k.startsWith('MANUAL_REQUIRED')).reduce((a, [, n]) => a + n, 0);
    if (other > 0) bits.push(`${other} could not be checked`);
    if (manual > 0) bits.push(`${manual} need a manual check`);
    bits.push(`${passed} passed`);
    out.push(`Screened ${names(screened)} today: ${bits.join(', ')}.`);
  }
  if (num(sm.scout_screened_n) === 0 && num(sm.queued_waiting_n) === 0) {
    out.push(num(sm.drop_list_screened_n) > 0 ? 'No scout names came in, so only drop-list names were screened.' : 'Intake was empty: no scout names were waiting.');
  }
  if (num(sm.waiting_for_records) > 0) out.push(`${names(num(sm.waiting_for_records))} wait for records.`);
  if (num(sm.dropping_n) > 0) out.push(`${names(num(sm.dropping_n))} on the drop lists ${num(sm.dropping_n) === 1 ? 'is' : 'are'} still dropping and will be screened only if free after the drop.`);
  if (num(sm.no_kept_lane_n) > 0) out.push(`${names(num(sm.no_kept_lane_n))} from the drop lists ${num(sm.no_kept_lane_n) === 1 ? 'was' : 'were'} skipped because ${num(sm.no_kept_lane_n) === 1 ? 'it fits' : 'they fit'} no kept lane.`);
  const retry = (sm.timeout_retry ?? {}) as Record<string, number>;
  if (num(retry.resolved) > 0) out.push(`${num(retry.resolved)} ${num(retry.resolved) === 1 ? 'lookup' : 'lookups'} that timed out cleared on a retry.`);
  if (num(sm.left_for_tomorrow_n) > 0) out.push(`${num(sm.left_for_tomorrow_n)} more wait for tomorrow.`);
  if (sm.partial === true) out.push('Screening is still running, so this may change.');
  else if (sm.screening_ended_partial === true) out.push('The screening run ran out of time before every name was checked.');
  return out.join(' ');
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

async function waitForRuns(db: Kysely<Database>, worker: ScreeningWorker, today: string, waitMs: number): Promise<boolean> {
  const runs = await db.selectFrom('candidate_screenings').select('run_id').distinct().where('day', '=', today).execute();
  let timedOut = false;
  for (const r of runs) {
    const st = await db.selectFrom('screening_runs').select('status').where('id', '=', r.run_id).executeTakeFirst();
    if (st?.status !== 'running') continue;
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      worker.runToEnd(r.run_id).then(() => 'done' as const),
      new Promise<'timeout'>((res) => { timer = setTimeout(() => res('timeout'), waitMs); timer.unref?.(); }),
    ]);
    if (timer) clearTimeout(timer);
    if (outcome === 'timeout') timedOut = true;
  }
  return timedOut;
}

const checkLine = (r: ResultRow) => ({ check: r.check_id, status: r.status, reason_code: r.reason_code });

async function recordsFor(db: Kysely<Database>, domain: string, latest: Map<CheckId, ResultRow>, nowMs: number): Promise<{ records: Json; missing: Missing[] }> {
  const records: Json = {};
  const missing: Missing[] = [];
  for (const kind of RECORD_KINDS) {
    const row = latest.get(kind);
    const rec = await freshDomainRecord(db, domain, kind, nowMs);
    if (rec) {
      records[kind] = { result: row?.status ?? null, reason_code: row?.reason_code ?? null, checked_at: rec.checkedAt.toISOString(), checked_by: rec.checkedBy, source: 'domain_record', evidence_url: rec.evidenceUrl };
      continue;
    }
    // A record made against this run only (the per-run manual route also writes the domain record, so this is the older-data case).
    if (row && row.source === 'manual' && !['MANUAL_REQUIRED', 'NOT_RUN', 'UNKNOWN'].includes(row.status) && isFresh(kind, row.checked_at, nowMs)) {
      records[kind] = { result: row.status, reason_code: row.reason_code, checked_at: row.checked_at.toISOString(), checked_by: row.recorded_by, source: 'run_record', evidence_url: null };
      continue;
    }
    const any = await db.selectFrom('domain_records').select('id').where('domain', '=', domain).where('kind', '=', kind).limit(1).executeTakeFirst();
    missing.push({ kind, reason: any ? 'STALE' : 'NO_RECORD' });
    records[kind] = null;
  }
  return { records, missing };
}

interface PoolItem { run: { id: string; created_at: Date; settings_label: string; status: string; mode: string }; item: RunItem; plan: CheckId[]; rows: ResultRow[]; derived: ReturnType<typeof assemble>['items'][number]['derived'] }

/** Newest screening of each domain among the finished or running, non-backtest, full-plan runs of the last 72 hours on the active settings. */
async function collectPool(db: Kysely<Database>, nowMs: number): Promise<{ pool: PoolItem[]; hold: boolean; values: Awaited<ReturnType<typeof activeSelectionSettings>>['values']; label: string }> {
  const sel = await activeSelectionSettings(db);
  const runs = await db.selectFrom('screening_runs').selectAll().where('created_at', '>', new Date(nowMs - DAILY_LIST_RUN_MAX_AGE_HOURS * HOUR_MS))
    .where('backtest', '=', false).where('settings_label', '=', sel.label).where('status', '!=', 'cancelled').orderBy('created_at', 'desc').orderBy('id', 'desc').execute();
  const seen = new Set<string>();
  const pool: PoolItem[] = [];
  for (const run of runs) {
    try { fullPlanRunOrThrow(run, sel); } catch { continue; }
    const hold = await effectiveHold(db, run);
    const a = assemble((run.input as { names: RunItem[] }).names, run.gate_plan as Partial<Record<Lane, CheckId[]>>, await loadRows(db, run.id), sel.values, hold, run.status !== 'running', run.mode === 'live');
    for (const it of a.items) {
      if (it.item.input_error || seen.has(it.item.domain)) continue;
      seen.add(it.item.domain);
      pool.push({ run: { id: run.id, created_at: run.created_at, settings_label: run.settings_label, status: run.status, mode: run.mode }, item: it.item, plan: it.plan, rows: it.rows, derived: it.derived });
    }
  }
  return { pool, hold: sel.values.buy_hold, values: sel.values, label: sel.label };
}

type BuildDeps = { db: Kysely<Database>; worker: ScreeningWorker; now: () => number; waitMs?: number; noWait?: boolean; builtBy?: 'daily' | 'rebuild' | 'auto' };
type BuildResult = { id: string; day: string; entries_n: number; almost_ready_n: number; upcoming_n: number; partial: boolean; version: number };

/**
 * v3.9.0: takes the `daily_rebuild` advisory lock itself, so the daily step, a rebuild, an auto rebuild and a screen run never build at once. The wait for the day's screening
 * runs happens first, outside the lock; the read, the insert and the version count are one transaction under it. A caller that is already in a transaction (the rebuild route,
 * which counts the day's rebuilds under the same lock) passes it as `db`: the lock is then taken again by the same connection (re-entrant) and that transaction is used.
 */
export async function buildDailyList(deps: BuildDeps): Promise<BuildResult> {
  const timedOut = deps.noWait ? false : await waitForRuns(deps.db, deps.worker, idtDay(deps.now()), deps.waitMs ?? DAILY_LIST_WAIT_MS);
  if (deps.db.isTransaction) {
    await advisoryXactLock(deps.db, 'daily_rebuild');
    return buildLocked(deps, timedOut);
  }
  return deps.db.transaction().execute(async (trx) => {
    await advisoryXactLock(trx, 'daily_rebuild');
    return buildLocked({ ...deps, db: trx }, timedOut);
  });
}

async function buildLocked(deps: BuildDeps, timedOut: boolean): Promise<BuildResult> {
  const { db } = deps;
  const nowMs = deps.now();
  const today = idtDay(nowMs);
  // noWait (a manual rebuild): builds from what is done now; a run still going marks the list partial below.
  const nowAfter = deps.now();
  const { pool, hold, values, label } = await collectPool(db, nowAfter);
  const pricing = await currentSettings(db, new Date(nowAfter));
  const domains = pool.map((p) => p.item.domain);
  const owned = new Set<string>();
  if (domains.length) for (const r of await db.selectFrom('domains').select('domain').where('status', 'in', [...OWNED_STATUSES]).where('domain', 'in', domains).execute()) owned.add(r.domain);

  // Sources: scouts (every intake row of the name that is not removed) and drop lists.
  const sources = new Map<string, Source[]>();
  const comps = new Map<string, unknown>();
  const whoChases = new Map<string, string>();
  const scoutSellers = new Map<string, unknown>(); // v3.3.0 (CR-023 B): the newest intake row's sellers list
  const scoutWords = new Map<string, string[]>(); // v3.3.0 (CR-022 A): the newest intake row's own word pieces
  const firstReceived = new Map<string, number>();
  // v3.2.0 (CR-019 C-4): where a screened name came from: the scout intake or a drop list (a name that came both ways counts as intake).
  const origins = new Map<string, 'intake' | 'drop_list'>();
  const poolRuns = [...new Set(pool.map((p) => p.run.id))];
  if (poolRuns.length) {
    for (const r of await db.selectFrom('candidate_screenings').select(['run_id', 'domain', 'origin']).where('run_id', 'in', poolRuns).execute()) {
      const k = `${r.run_id}|${r.domain}`;
      if (origins.get(k) !== 'intake') origins.set(k, r.origin);
    }
  }
  if (domains.length) {
    for (const r of await db.selectFrom('candidate_intake').selectAll().where('domain', 'in', domains).where('status', 'in', ['queued', 'duplicate']).orderBy('id').execute()) {
      if (r.who_chases) whoChases.set(r.domain, r.who_chases); // the newest intake row that carries one
      if (r.words) scoutWords.set(r.domain, r.words);
      if (r.sellers) scoutSellers.set(r.domain, r.sellers);
      (sources.get(r.domain) ?? sources.set(r.domain, []).get(r.domain)!).push({ source: r.source, received_at: r.received_at.toISOString(), token_name: r.token_name });
      if (!firstReceived.has(r.domain)) firstReceived.set(r.domain, r.received_at.getTime());
      if (r.comps) comps.set(r.domain, r.comps);
    }
  }
  const dropWindow = await namesDroppingBetween(db, nowAfter, addDays(today, -60), addDays(today, 60));
  const dropOf = new Map(dropWindow.map((d) => [d.domain, d]));
  const listInfo = new Map<string, { created_at: Date; created_by: string }>();
  for (const l of await db.selectFrom('drop_lists').select(['name', 'created_at', 'created_by']).where('name', 'in', [...new Set(dropWindow.map((d) => d.list_name)), ''] ).execute()) listInfo.set(l.name, l);
  for (const d of dropWindow) {
    if (!domains.includes(d.domain)) continue;
    const li = listInfo.get(d.list_name);
    if (!li) continue;
    (sources.get(d.domain) ?? sources.set(d.domain, []).get(d.domain)!).push({ source: d.list_name, received_at: li.created_at.toISOString(), token_name: li.created_by });
    if (!firstReceived.has(d.domain)) firstReceived.set(d.domain, li.created_at.getTime());
  }

  const failed_by_check: Record<string, number> = {};
  const failed_by_check_lane: Record<string, Record<string, number>> = {};
  const rejected: Json[] = [];
  const splitV3 = loadSplitV2('bt1@v3');
  const unknown_by_reason: Record<string, number> = {};
  let screenedToday = 0;
  const retry = { timed_out_first: 0, resolved: 0, still_timeout: 0, tries: {} as Record<string, number> };
  const eligible: (DailyEntry & { _score: number; _ratio: number; _exact: boolean; _at: number })[] = [];
  const almost: Json[] = [];
  const upcoming: Json[] = [];
  const features = values.run.feature_checks as CheckId[];
  const weekEnd = addDays(today, 7);

  for (const p of pool) {
    const domain = p.item.domain;
    const latest = latestByCheck(p.rows);
    const createdToday = idtDay(p.run.created_at) === today;
    if (createdToday) {
      screenedToday++;
      // v3.2.0 (CR-019 C-2): a name whose availability lookup timed out is asked again at the end of the run; count what the retries settled.
      const tries = p.rows.filter((r) => r.check_id === 'availability');
      if (tries.some((r) => r.status === 'UNKNOWN' && r.reason_code === 'TIMEOUT')) {
        const last = latest.get('availability');
        const still = last?.status === 'UNKNOWN' && last.reason_code === 'TIMEOUT';
        retry.timed_out_first++;
        if (still) retry.still_timeout++; else retry.resolved++;
        retry.tries[String(tries.length)] = (retry.tries[String(tries.length)] ?? 0) + 1;
      }
    }
    if (owned.has(domain)) continue;
    const gating = p.plan.filter((c) => !features.includes(c));
    const fs = p.derived.final_status;
    const drop = dropOf.get(domain);
    const base = {
      domain, lane: p.item.lane, run_id: p.run.id, settings_version: p.run.settings_label, sources: sources.get(domain) ?? [],
      origin: origins.get(`${p.run.id}|${domain}`) ?? null, who_chases: whoChases.get(domain) ?? null,
      // v3.3.0 (CR-022 A): the word pieces behind the name: the scout's own, else the bt1@v3 dictionary split.
      words: scoutWords.get(domain) ?? (domain.endsWith('.com') ? splitV2(domain.slice(0, -4), splitV3) : []),
      split_source: scoutWords.has(domain) ? 'scout' : 'dictionary',
      sellers: scoutSellers.get(domain) ?? null,
      sellers_verified_n: ((latest.get('tier')?.fields?.sellers as { verified_n?: unknown } | undefined)?.verified_n as number | null | undefined) ?? null,
    };
    const needRecords = async () => recordsFor(db, domain, latest, nowAfter);

    if (fs === 'rejected') {
      const ff = p.derived.first_fail!;
      // v3.2.0 (CR-019 C-3): a name registered but in pending delete or redemption is "dropping on <date>", not taken.
      const isDropping = ff.check === 'availability' && ff.reason_code === 'REGISTERED' && !!drop && ['pending_delete', 'redemption'].includes(drop.status);
      if (createdToday && !isDropping) {
        failed_by_check[ff.check] = (failed_by_check[ff.check] ?? 0) + 1;
        const lt = (failed_by_check_lane[ff.check] ??= {});
        lt[p.item.lane] = (lt[p.item.lane] ?? 0) + 1;
        // v3.3.0 (CR-023 E): why a screened name did not make the list.
        const row = latest.get(ff.check);
        const f = row?.fields ?? {};
        rejected.push({
          domain, lane: p.item.lane, origin: base.origin, run_id: p.run.id,
          first_fail: { check: ff.check, gate: ff.gate, reason_code: ff.reason_code, reason: row?.reason ?? null },
          key_inputs: ff.check === 'tier' ? { inputs: f.inputs ?? null, clauses: f.clauses ?? null, tier: f.tier ?? null }
            : ff.check === 'price' ? { ev_cents: f.ev_cents ?? null, P_sale: f.P_sale ?? null, p_passive: f.p_passive ?? null } : {},
        });
      }
      const otherFail = gating.filter((c) => latest.get(c)?.status === 'FAIL' && c !== 'availability');
      const badUnknown = gating.filter((c) => latest.get(c)?.status === 'UNKNOWN' && !NEEDS_AVAILABLE.includes(c));
      if (ff.check === 'availability' && ff.reason_code === 'REGISTERED' && drop && drop.expected_drop_date >= today && drop.expected_drop_date <= weekEnd && otherFail.length === 0 && badUnknown.length === 0) {
        const rec = await needRecords();
        upcoming.push({ ...base, expected_drop_date: drop.expected_drop_date, drop_date_source: drop.drop_date_source, list_name: drop.list_name, missing_records: rec.missing, records: rec.records, checks: p.plan.map((c) => latest.get(c)).filter((r): r is ResultRow => !!r).map(checkLine), buyable_from: drop.expected_drop_date });
      }
      continue;
    }
    if (fs === 'unknown') {
      if (createdToday) {
        const u = gating.map((c) => latest.get(c)).find((r) => r?.status === 'UNKNOWN');
        const key = u?.reason_code ?? 'UNKNOWN';
        unknown_by_reason[key] = (unknown_by_reason[key] ?? 0) + 1;
      }
      continue;
    }
    if (fs === 'pending_manual') {
      const pm = p.derived.pending_manual;
      const partE = pm.every((c) => (RECORD_KINDS as readonly string[]).includes(c));
      if (!partE) {
        if (createdToday) { const k = `MANUAL_REQUIRED:${pm.find((c) => !(RECORD_KINDS as readonly string[]).includes(c))}`; unknown_by_reason[k] = (unknown_by_reason[k] ?? 0) + 1; }
        continue;
      }
      const rec = await needRecords();
      // v2.16.0 (CR-015 I-4): judged by the records in force NOW, not by what the run saw. A kind with a fresh record at build time is not missing; when none is missing
      // the records arrived after the screening, and the name needs a new screening to use them.
      const stillMissing = RECORD_KINDS.filter((k) => pm.includes(k)).flatMap((k) => { const m = rec.missing.find((x) => x.kind === k); return m ? [{ kind: k, reason: m.reason }] : []; });
      almost.push({ ...base, final_status: fs, missing: stillMissing, records: rec.records, note: stillMissing.length === 0 ? 'The records are in, but this screening ran before them: screen the name again' : 'Record the missing item with POST /candidates/{domain}/records, then screen the name again', checks: p.plan.map((c) => latest.get(c)).filter((r): r is ResultRow => !!r).map(checkLine) });
      continue;
    }
    if (fs !== 'buy_candidate' && fs !== 'would_buy') continue;

    const rec = await needRecords();
    if (rec.missing.length > 0) {
      almost.push({ ...base, final_status: fs, missing: rec.missing, records: rec.records, note: 'Record the missing item with POST /candidates/{domain}/records', checks: p.plan.map((c) => latest.get(c)).filter((r): r is ResultRow => !!r).map(checkLine) });
      continue;
    }
    const quote = latest.get('quote')?.fields ?? {};
    const money = latest.get('price')?.fields ?? {};
    const tier = latest.get('tier')?.fields ?? {};
    const bin = typeof money.bin_cents === 'number' ? money.bin_cents : null;
    const firstYear = typeof quote.first_year_cents === 'number' ? quote.first_year_cents : null;
    const renewal = typeof quote.renewal_cents === 'number' ? quote.renewal_cents : null;
    // The plan under the CURRENT pricing settings: geo = the grade price with no negotiation; everything else = floor by the formula, min offer from the settings. Never the walk-away.
    const plan = bin === null ? null : p.item.lane === 'S2'
      ? { bin_cents: bin, bin: formatUsd(bin), floor_cents: bin, floor: formatUsd(bin), min_offer_cents: bin, min_offer: formatUsd(bin), pricing_settings_version: pricing.version }
      : (() => { const f = priceFormula(bin, pricing); return { bin_cents: bin, bin: formatUsd(bin), floor_cents: f.floorCents, floor: formatUsd(f.floorCents), min_offer_cents: pricing.hybridMinOfferCents, min_offer: formatUsd(pricing.hybridMinOfferCents), pricing_settings_version: pricing.version }; })();
    const blocked = await buyBlocks(db, domain, nowAfter, firstYear);
    const entry = {
      ...base, rank: 0, final_status: fs, held: hold || fs === 'would_buy',
      price: firstYear === null ? null : { registrar: quote.registrar ?? null, first_year_cents: firstYear, first_year: formatUsd(firstYear), renewal_cents: renewal, renewal: renewal === null ? null : formatUsd(renewal), quoted_at: quote.quoted_at ?? null },
      plan,
      checks: p.plan.map((c) => latest.get(c)).filter((r): r is ResultRow => !!r).map(checkLine),
      flags: p.derived.flags.map((c) => ({ check: c, reason_code: latest.get(c)?.reason_code ?? null, reason: latest.get(c)?.reason ?? null })),
      records: rec.records,
      comps: comps.get(domain) ?? null,
      dates: { expiry_or_drop: drop?.expected_drop_date ?? null, buyable_from: drop && drop.expected_drop_date > today ? drop.expected_drop_date : today },
      why: { tier: tier.tier ?? null, tier_exact: tier.tier_exact !== false, clause: tier.fired ?? null, ratio_at_bin: money.ratio_at_bin ?? null, ratio_at_floor: money.ratio_at_floor ?? null, score: money.score_0_100 ?? null },
      would_be_blocked: blocked as string[],
      _score: typeof money.score_0_100 === 'number' ? money.score_0_100 : -1,
      _ratio: typeof money.ratio_at_floor === 'number' ? money.ratio_at_floor : -1,
      _exact: tier.tier_exact !== false,
      _at: firstReceived.get(domain) ?? Number.MAX_SAFE_INTEGER,
    } as DailyEntry & { _score: number; _ratio: number; _exact: boolean; _at: number };
    eligible.push(entry);
  }
  eligible.sort((a, b) => Number(b._exact) - Number(a._exact) || b._ratio - a._ratio || b._score - a._score || a._at - b._at || a.domain.localeCompare(b.domain));

  // Stable for the day (T12-12): the day's first build fixes the order; a later build keeps those names in that order, then adds new ones by rank.
  const first = await db.selectFrom('daily_candidate_lists').selectAll().where('day', '=', today).orderBy('id').limit(1).executeTakeFirst();
  const prior = (first?.entries as DailyEntry[] | undefined) ?? [];
  const priorRank = new Map(prior.map((e, i) => [e.domain, i]));
  const ordered = [...eligible].sort((a, b) => (priorRank.get(a.domain) ?? 1e9) - (priorRank.get(b.domain) ?? 1e9));
  const stateOf = (e: Json) => ({ final_status: e.final_status, held: e.held, would_be_blocked: e.would_be_blocked, price: (e.price as Json | null) ? { registrar: (e.price as Json).registrar, first_year_cents: (e.price as Json).first_year_cents } : null });
  const entries: DailyEntry[] = ordered.slice(0, DAILY_LIST_MAX_LIMIT).map((e, i) => {
    const { _score, _ratio, _exact, _at, ...rest } = e;
    void _score; void _ratio; void _exact; void _at;
    const was = prior.find((x) => x.domain === e.domain);
    const out: DailyEntry = { ...rest, rank: i + 1 };
    if (was) {
      const a = stateOf(was); const b = stateOf(out);
      const changes = (Object.keys(a) as (keyof typeof a)[]).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
      if (changes.length > 0) out.changed_since_first = { reason: 'STATE_CHANGED', changes };
    }
    return out;
  });
  const removed = prior.filter((e) => !ordered.some((x) => x.domain === e.domain)).map((e) => {
    const p = pool.find((q) => q.item.domain === e.domain);
    const reason = owned.has(e.domain) ? 'OWNED' : !p ? 'SCREENING_TOO_OLD' : p.derived.final_status === 'rejected' ? `FAILED_${p.derived.first_fail!.check}` : p.derived.final_status === 'pending_manual' ? 'RECORD_MISSING' : `NOT_ELIGIBLE_${p.derived.final_status}`;
    return { domain: e.domain, was_rank: e.rank, reason };
  });

  // v3.2.0 (CR-020 C): `partial` = a screening run of today was still running when the list was built (a rebuild reads it again); `screening_ended_partial` = a run of today
  // ended `partial` (its time budget ran out; names left TIMEOUT). The two are different facts and never share a field.
  const todayScreenings = await db.selectFrom('candidate_screenings as c').innerJoin('screening_runs as r', 'r.id', 'c.run_id').select(['c.id', 'c.run_id', 'r.status', 'c.origin', 'c.domain', 'c.on_demand']).where('c.day', '=', today).orderBy('c.id').execute();
  // v3.3.0 (CR-021 B, CR-023 E): every screening run of the day, oldest first; `screening_run_id` is the scheduled intake run (else the newest run).
  const runIds = [...new Set(todayScreenings.map((r) => r.run_id))];
  const scheduledRuns = [...new Set(todayScreenings.filter((r) => !r.on_demand).map((r) => r.run_id))];
  const statusesToday = new Set([...todayScreenings.map((r) => r.status as string), ...pool.filter((p) => idtDay(p.run.created_at) === today).map((p) => p.run.status)]);
  const partial = timedOut || statusesToday.has('running');
  const screeningEndedPartial = statusesToday.has('partial');
  const timeoutN = unknown_by_reason.TIMEOUT ?? 0;
  const waiting = new Set([...almost.map((a) => a.domain as string), ...upcoming.filter((u) => (u.missing_records as Missing[]).length > 0).map((u) => u.domain as string)]);

  // Drop-list facts (CR-019 C-3/C-4, CR-020 A): names still dropping, leftovers (free after their drop date), and the leftovers that fit no kept lane.
  const dropping = dropWindow.filter((d) => ['pending_delete', 'redemption'].includes(d.status) && d.expected_drop_date >= addDays(today, -7));
  const fit = await laneFitter(db, values);
  const leftAll = await leftoverNames(db, nowAfter, today);
  const leftOwned = new Set<string>();
  if (leftAll.length) for (const r of await db.selectFrom('domains').select('domain').where('status', 'in', [...OWNED_STATUSES]).where('domain', 'in', leftAll.map((l) => l.domain)).execute()) leftOwned.add(r.domain);
  const leftovers = leftAll.filter((l) => !leftOwned.has(l.domain));
  const noKeptLane = leftovers.filter((l) => fit(l.domain) === null).length;
  const recentlyScreened = new Set((await db.selectFrom('candidate_screenings').select('domain').where('at', '>', new Date(nowAfter - 7 * 86_400_000)).execute()).map((r) => r.domain));
  const queuedWaiting = Number((await sql<{ n: string }>`
    select count(distinct i.domain)::text as n from candidate_intake i
    where i.status = 'queued' and not exists (select 1 from candidate_screenings s where s.intake_id = i.id)
      and not exists (select 1 from domains d where d.domain = i.domain and d.status in ('pending_purchase','owned','listed','delisted'))`.execute(db)).rows[0]!.n);
  const leftForTomorrow = queuedWaiting + leftovers.filter((l) => fit(l.domain) !== null && !recentlyScreened.has(l.domain)).length;
  const scoutScreened = new Set(todayScreenings.filter((r) => r.origin === 'intake').map((r) => r.domain)).size;
  const dropScreened = new Set(todayScreenings.filter((r) => r.origin === 'drop_list').map((r) => r.domain)).size;
  const summary: Json = {
    screened_today: screenedToday, failed_by_check, waiting_for_records: waiting.size, unknown_by_reason, partial,
    screening_ended_partial: screeningEndedPartial, timeout_n: timeoutN, timeout_retry: retry,
    candidates_n: entries.length, almost_ready_n: almost.length, upcoming_n: upcoming.length,
    dropping_n: dropping.length, dropping: dropping.slice(0, DROPPING_LIST_MAX).map((d) => ({ domain: d.domain, status: d.status, expected_drop_date: d.expected_drop_date, list_name: d.list_name })),
    leftovers_n: leftovers.length, no_kept_lane_n: noKeptLane,
    scout_screened_n: scoutScreened, drop_list_screened_n: dropScreened, queued_waiting_n: queuedWaiting, left_for_tomorrow_n: leftForTomorrow,
    settings_version: label,
    screening_run_id: scheduledRuns.at(-1) ?? runIds.at(-1) ?? null, screening_run_ids: runIds,
    failed_by_check_lane, rejected_n: rejected.length, rejected: rejected.slice(0, REJECTED_LIST_MAX),
  };
  summary.why = buildWhy(summary);
  const sections = { almost_ready: almost, upcoming, ...(first ? { removed_since_first: removed } : {}) };
  const row = await db.insertInto('daily_candidate_lists').values({
    day: today, built_at: new Date(nowAfter), entries: JSON.stringify(entries), sections: JSON.stringify(sections), summary: JSON.stringify(summary), built_by: deps.builtBy ?? 'daily',
  }).returning('id').executeTakeFirstOrThrow();
  const version = Number((await db.selectFrom('daily_candidate_lists').select(sql<string>`count(*)`.as('n')).where('day', '=', today).executeTakeFirstOrThrow()).n);
  return { id: row.id, day: today, entries_n: entries.length, almost_ready_n: almost.length, upcoming_n: upcoming.length, partial, version };
}

export class BuildDailyListJob {
  private running = false;
  constructor(private readonly deps: { db: Kysely<Database>; worker: ScreeningWorker; now: () => number; waitMs?: number }) {}
  async runOnce(o: { builtBy?: 'daily' | 'rebuild' | 'auto' } = {}): Promise<unknown> {
    if (this.running) return { skipped: true, reason: 'ALREADY_RUNNING' };
    this.running = true;
    try {
      const r = await buildDailyList({ ...this.deps, ...(o.builtBy && { builtBy: o.builtBy }) });
      return r;
    } finally {
      this.running = false;
    }
  }
}

/** The newest list of an IDT day (limit applied), or an empty one with `not_built`. Never padded. */
export async function readDailyList(db: Kysely<Database>, day: string, limit: number): Promise<Json> {
  const row = await db.selectFrom('daily_candidate_lists').selectAll().where('day', '=', day).orderBy('id', 'desc').limit(1).executeTakeFirst();
  if (!row) {
    return { date: day, built_at: null, version: 0, limit, entries: [], sections: { almost_ready: [], upcoming: [] }, summary: { not_built: true }, record_freshness_days: RECORD_FRESH_DAYS };
  }
  const version = Number((await db.selectFrom('daily_candidate_lists').select(sql<string>`count(*)`.as('n')).where('day', '=', day).executeTakeFirstOrThrow()).n);
  return {
    date: day, built_at: iso(row.built_at), version, limit, entries: (row.entries as DailyEntry[]).slice(0, limit), sections: row.sections, summary: row.summary,
    record_freshness_days: RECORD_FRESH_DAYS,
  };
}

/**
 * v3.2.0 (CR-018 A): when the intake screening run of today ends, the day's list is rebuilt (the first order is kept, changes are marked; built_by `auto`, which does not count
 * toward the manual rebuilds). Nothing happens for a run that is not today's intake run, or while the daily job's own `buildDailyList` step is still to come (it builds then).
 * Returns whether a list was built.
 */
export async function autoRebuildDailyList(deps: { db: Kysely<Database>; worker: ScreeningWorker; now: () => number }, runId: string): Promise<boolean> {
  const { db } = deps;
  const today = idtDay(deps.now());
  if (!(await db.selectFrom('candidate_screenings').select('id').where('run_id', '=', runId).where('day', '=', today).limit(1).executeTakeFirst())) return false;
  if (await db.selectFrom('job_steps').select('id').where('step', '=', 'buildDailyList').where('status', 'in', ['queued', 'running']).limit(1).executeTakeFirst()) return false;
  await buildDailyList({ db, worker: deps.worker, now: deps.now, noWait: true, builtBy: 'auto' }); // takes the lock itself (v3.9.0)
  return true;
}
