// v2.14.0 (CR-012 part B): the daily buy-ready list. Built once per IDT day by the daily step `buildDailyList` (a manual build appends a new version),
// stored append-only, read with GET /candidates/daily. It only reads the database: no registrar, no marketplace, no new lookup. It never carries the
// private walk-away, and nothing in it is an approval.
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { jerusalemDate } from '../dates.js';
import type { Database } from '../db/types.js';
import { addDays, namesDroppingBetween, todayIdt } from '../drops/drop-lists.js';
import { formatUsd } from '../money.js';
import { priceFormula } from '../pricing/plan.js';
import { currentSettings } from '../pricing/settings.js';
import { buyBlocks } from '../services/buy-gates.js';
import { latestByCheck } from './derive.js';
import { RECORD_FRESH_DAYS, RECORD_KINDS, isFresh, freshDomainRecord, type RecordKind } from './domain-records.js';
import { assemble, effectiveHold, fullPlanRunOrThrow, loadRows, type ScreeningWorker } from './engine.js';
import { OWNED_STATUSES } from './intake.js';
import { activeSelectionSettings } from './settings.js';
import type { CheckId, Lane, ResultRow, RunItem } from './types.js';

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

export async function buildDailyList(deps: { db: Kysely<Database>; worker: ScreeningWorker; now: () => number; waitMs?: number; noWait?: boolean; builtBy?: 'daily' | 'rebuild' }): Promise<{ id: string; day: string; entries_n: number; almost_ready_n: number; upcoming_n: number; partial: boolean; version: number }> {
  const { db } = deps;
  const nowMs = deps.now();
  const today = todayIdt(nowMs);
  // noWait (a manual rebuild): build from what is done now; a run still going marks the list partial below.
  const timedOut = deps.noWait ? false : await waitForRuns(db, deps.worker, today, deps.waitMs ?? DAILY_LIST_WAIT_MS);
  const nowAfter = deps.now();
  const { pool, hold, values, label } = await collectPool(db, nowAfter);
  const pricing = await currentSettings(db, new Date(nowAfter));
  const domains = pool.map((p) => p.item.domain);
  const owned = new Set<string>();
  if (domains.length) for (const r of await db.selectFrom('domains').select('domain').where('status', 'in', [...OWNED_STATUSES]).where('domain', 'in', domains).execute()) owned.add(r.domain);

  // Sources: scouts (every intake row of the name that is not removed) and drop lists.
  const sources = new Map<string, Source[]>();
  const comps = new Map<string, unknown>();
  const firstReceived = new Map<string, number>();
  if (domains.length) {
    for (const r of await db.selectFrom('candidate_intake').selectAll().where('domain', 'in', domains).where('status', 'in', ['queued', 'duplicate']).orderBy('id').execute()) {
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
  const unknown_by_reason: Record<string, number> = {};
  let screenedToday = 0;
  const eligible: (DailyEntry & { _score: number; _ratio: number; _exact: boolean; _at: number })[] = [];
  const almost: Json[] = [];
  const upcoming: Json[] = [];
  const features = values.run.feature_checks as CheckId[];
  const weekEnd = addDays(today, 7);

  for (const p of pool) {
    const domain = p.item.domain;
    const latest = latestByCheck(p.rows);
    const createdToday = jerusalemDate(p.run.created_at) === today;
    if (createdToday) screenedToday++;
    if (owned.has(domain)) continue;
    const gating = p.plan.filter((c) => !features.includes(c));
    const fs = p.derived.final_status;
    const drop = dropOf.get(domain);
    const base = {
      domain, lane: p.item.lane, run_id: p.run.id, settings_version: p.run.settings_label, sources: sources.get(domain) ?? [],
    };
    const needRecords = async () => recordsFor(db, domain, latest, nowAfter);

    if (fs === 'rejected') {
      const ff = p.derived.first_fail!;
      if (createdToday) failed_by_check[ff.check] = (failed_by_check[ff.check] ?? 0) + 1;
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

  const partial = timedOut || pool.some((p) => p.run.status !== 'done' && jerusalemDate(p.run.created_at) === today);
  const waiting = new Set([...almost.map((a) => a.domain as string), ...upcoming.filter((u) => (u.missing_records as Missing[]).length > 0).map((u) => u.domain as string)]);
  const summary: Json = {
    screened_today: screenedToday, failed_by_check, waiting_for_records: waiting.size, unknown_by_reason, partial,
    candidates_n: entries.length, almost_ready_n: almost.length, upcoming_n: upcoming.length, settings_version: label,
  };
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
  async runOnce(): Promise<unknown> {
    if (this.running) return { skipped: true, reason: 'ALREADY_RUNNING' };
    this.running = true;
    try {
      const r = await buildDailyList(this.deps);
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
