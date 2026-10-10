// v2.14.0 (CR-012 part C): scouts send names (POST /candidates/intake); the daily step `intakeScreening` screens them (with the drop-list names that are about
// to drop) in ONE full-plan run and records what it took. Nothing here calls a registrar or marketplace; the screening run does its own lookups.
import { advisoryXactLock } from '../../core/locks.js';
import { hasAtSign, piiError } from '../../core/validation.js';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { addDays, idtDay, isRealDate } from '../../core/dates.js';
import type { Database } from '../../db/types.js';
import { filterDropName, leftoverNames, namesDroppingBetween, type RemovedReason } from './drop-lists.js';
import { newAuditId } from '../../http/audit.js';
import { AppError } from '../../http/errors.js';
import { CompSchema } from '../listing/index.js';
import { createRun, currentLists, SellersList, type InputName, type ScreeningWorker } from '../selection/index.js';
import { activeSelectionSettings, laneFitter, methodApproval } from '../selection/index.js';

/** A name sent again within this many days is a duplicate (its extra source is recorded, it is not screened twice). */
export const INTAKE_DEDUPE_DAYS = 30;
/** The most names one IDT day's intake screening takes (intake names first, then drop-list names). */
export const INTAKE_DAILY_MAX = 30;
/** A drop-list name is not screened again for this many days (v3.2.0: only leftovers, names free after their drop date, are screened; a name in pending delete or redemption is not). */
export const DROP_SCREEN_WINDOW_DAYS = 7;
/** Sibling methods the intake run uses for the census, newest first; the first that is approved wins, none approved leaves the census UNKNOWN. */
export const INTAKE_CENSUS_PREFERENCE = ['bt1@v3', 'bt1@v2'] as const;
export const INTAKE_LANES = ['S2', 'S3', 'S4', 'S6', 'S7'] as const;
export const OWNED_STATUSES = ['pending_purchase', 'owned', 'listed', 'delisted'] as const;
const DAY_MS = 86_400_000;

const text = (max: number) => z.string().trim().min(1).max(max);
export const IntakeComps = z.array(CompSchema).min(2).max(3);
export const IntakeBody = z.object({
  names: z.array(z.object({
    domain: z.string().trim().min(1).max(253), lane: z.enum(INTAKE_LANES), source: text(120), note: z.string().trim().max(500).optional(), comps: IntakeComps.optional(),
    /** v3.2.0 (CR-020 B): who already chases this kind of name at scale, and why not this one. Information only: it never affects scoring. */
    who_chases: z.string().trim().max(300).optional(),
    /** v3.3.0 (CR-023 B): up to 10 firms that already sell or deploy the exact service, `{name, url}`; screening verifies each page. No personal data (NO_PII). */
    sellers: SellersList.optional(),
    /** v3.3.0 (CR-022 A): the scout's own word pieces (1 to 6, lower-case a-z0-9); they must join to the name without `.com` and replace the dictionary split for it. */
    words: z.array(z.string().regex(/^[a-z0-9]+$/, 'each word is lower-case letters or digits')).min(1).max(6).optional(),
  }).strict()).min(1).max(100),
}).strict();
export type IntakeBodyT = z.infer<typeof IntakeBody>;

export type IntakeRemoval = 'DOMAIN_INVALID' | 'NOT_COM' | 'HAS_DIGIT' | 'HAS_HYPHEN' | 'NO_SPLIT' | 'TOO_MANY_WORDS' | 'ONE_WORD' | 'OWNED' | 'DUPLICATE_IN_UPLOAD';

/** The form rules of an intake name (before ownership and duplicates): a letters-only second-level .com of at most 3 words by the bt1@v3 split (or the scout's `words`). */
export function intakeFormReason(raw: string): { domain: string; reason: IntakeRemoval | null } {
  const domain = raw.trim().toLowerCase();
  const labels = domain.split('.');
  const validLabel = (l: string) => /^[a-z0-9-]{1,63}$/.test(l) && !l.startsWith('-') && !l.endsWith('-');
  if (labels.length !== 2 || !labels.every(validLabel)) return { domain, reason: 'DOMAIN_INVALID' };
  if (labels[1] !== 'com') return { domain, reason: 'NOT_COM' };
  return { domain, reason: null };
}

/** The word rules, after the upload-duplicate test: the drop-list filter's own (digit, hyphen, no split, more than 3 words, one word). v2.16.0: one rule set for both feeds. */
function wordReason(domain: string, words: string[] | undefined, regimeTerms: ReadonlySet<string>): IntakeRemoval | null {
  // v3.3.0 (CR-022): bt1@v3 (the approved method the daily census uses), or the scout's words in its place.
  const f = filterDropName(domain, new Set(), { method: 'bt1@v3', regimeTerms, ...(words && { words }) });
  return f.kept ? null : (f.reason as RemovedReason as IntakeRemoval);
}

/** v2.16.0 (CR-015 I-1): `note` and `source` carry no personal data: the rule of /offers (no '@'), 422 NO_PII with the name's index and the field. */
export function checkIntakePii(body: IntakeBodyT): void {
  body.names.forEach((n, index) => {
    for (const field of ['note', 'source', 'who_chases'] as const) {
      const v = n[field];
      if (hasAtSign(v)) throw piiError(`names[${index}].${field} must not contain an email address or '@'`, { index, field });
    }
    (n.sellers ?? []).forEach((e, entry) => {
      if (hasAtSign(e.name) || hasAtSign(e.url)) throw piiError(`names[${index}].sellers[${entry}] must not contain an email address or '@'`, { index, field: 'sellers' });
    });
  });
}

/** v3.3.0 (CR-022 A): the scout's `words` must join back to the name without `.com` (422 VALIDATION_ERROR with the name's index and `field: words`). Nothing is stored on a mismatch. */
export function checkIntakeWords(body: IntakeBodyT): void {
  body.names.forEach((n, index) => {
    if (n.words === undefined) return;
    const d = n.domain.trim().toLowerCase();
    if (d.endsWith('.com') && n.words.join('') !== d.slice(0, -4)) {
      throw new AppError(422, 'VALIDATION_ERROR', `names[${index}].words must join to the name without .com ("${d.slice(0, -4)}")`, { index, field: 'words' });
    }
  });
}

/** Comparable sales must be real, past dates (the same rule as /buy). */
export function checkIntakeComps(body: IntakeBodyT, today: string): void {
  body.names.forEach((n, ni) => (n.comps ?? []).forEach((c, i) => {
    if (!isRealDate(c.sold_on)) throw new AppError(422, 'COMPS_INVALID', `names[${ni}].comps[${i}].sold_on is not a real date`, { index: ni, comp: i });
    if (c.sold_on > today) throw new AppError(422, 'COMPS_INVALID', `names[${ni}].comps[${i}].sold_on is in the future`, { index: ni, comp: i });
  }));
}

export const ownedDomains = async (db: Kysely<Database>, domains: string[]): Promise<Set<string>> => {
  if (domains.length === 0) return new Set();
  const rows = await db.selectFrom('domains').select('domain').where('status', 'in', [...OWNED_STATUSES]).where('domain', 'in', domains).execute();
  return new Set(rows.map((r) => r.domain));
};

export interface IntakeResult {
  accepted: { domain: string; intake_id: number }[];
  duplicates: { domain: string; first_intake_id: number }[];
  removed: { domain: string; reason: IntakeRemoval }[];
}

export async function takeIntake(db: Kysely<Database>, body: IntakeBodyT, ctx: { tokenName: string; auditId: string | null; now: Date }): Promise<IntakeResult> {
  checkIntakeComps(body, idtDay(ctx.now));
  checkIntakePii(body);
  checkIntakeWords(body);
  const out: IntakeResult = { accepted: [], duplicates: [], removed: [] };
  const checked = body.names.map((n) => ({ n, ...intakeFormReason(n.domain) }));
  const owned = await ownedDomains(db, checked.map((c) => c.domain));
  const regimeTerms = new Set((await currentLists(db, ['regime'])).regime?.terms ?? []);
  const since = new Date(ctx.now.getTime() - INTAKE_DEDUPE_DAYS * DAY_MS);
  await db.transaction().execute(async (trx) => {
    const seen = new Set<string>();
    for (const c of checked) {
      const row = { lane: c.n.lane, source: c.n.source, note: c.n.note ?? null, who_chases: c.n.who_chases ?? null, sellers: c.n.sellers ? JSON.stringify(c.n.sellers) : null, words: c.n.words ?? null, comps: c.n.comps ? JSON.stringify(c.n.comps) : null, received_at: ctx.now, token_name: ctx.tokenName, audit_id: ctx.auditId };
      let reason: IntakeRemoval | null = c.reason;
      if (reason === null) {
        if (seen.has(c.domain)) reason = 'DUPLICATE_IN_UPLOAD';
        else { seen.add(c.domain); reason = wordReason(c.domain, c.n.words, regimeTerms) ?? (owned.has(c.domain) ? 'OWNED' : null); }
      }
      if (reason !== null) {
        await trx.insertInto('candidate_intake').values({ ...row, domain: c.domain, status: 'removed', reason }).execute();
        out.removed.push({ domain: c.domain, reason });
        continue;
      }
      const first = await trx.selectFrom('candidate_intake').select('id').where('domain', '=', c.domain).where('status', '=', 'queued')
        .where('received_at', '>', since).orderBy('id').limit(1).executeTakeFirst();
      if (first) {
        await trx.insertInto('candidate_intake').values({ ...row, domain: c.domain, status: 'duplicate' }).execute();
        out.duplicates.push({ domain: c.domain, first_intake_id: Number(first.id) });
        continue;
      }
      const r = await trx.insertInto('candidate_intake').values({ ...row, domain: c.domain, status: 'queued' }).returning('id').executeTakeFirstOrThrow();
      out.accepted.push({ domain: c.domain, intake_id: Number(r.id) });
    }
  });
  return out;
}

export interface IntakeScreeningSummary {
  skipped?: true; reason?: string; queued_before: number; screened: number; from_intake: number; from_drop_lists: number; left_for_next_run: number; run_id: string | null; census_list: string | null;
  /** v3.2.0: drop-list leftovers (free after their drop date) that fit no kept lane (not screened), names still in pending delete or redemption (not screened), and leftovers that fit a lane. */
  no_kept_lane: number; dropping: number; leftovers: number;
}

/** The lanes a drop-list leftover may be screened under, and how many of the day's names the drop list may take (CR-020 A). */
export function dropListQuota(share: number, budget: number): number {
  return share >= 1 ? budget : Math.min(budget, Math.floor(share * budget));
}

/** The census list of the intake run: the first APPROVED method of INTAKE_CENSUS_PREFERENCE, else none (the census is then honestly UNKNOWN). */
export async function intakeCensusList(db: Kysely<Database>): Promise<string | null> {
  for (const m of INTAKE_CENSUS_PREFERENCE) if (await methodApproval(db, m)) return m;
  return null;
}

/** v3.3.0 (CR-021): the on-demand allowance of one IDT day: names `POST /candidates/screen` may still screen. It never touches the daily run's INTAKE_DAILY_MAX. */
export interface OnDemandAllowance { daily_max: number; used_today: number; remaining: number }

/** Names already screened on demand today (distinct names; only names actually screened count). */
async function onDemandUsed(db: Kysely<Database>, today: string): Promise<number> {
  return Number((await db.selectFrom('candidate_screenings').select(sql<string>`count(distinct domain)`.as('n')).where('day', '=', today).where('on_demand', '=', true).executeTakeFirstOrThrow()).n);
}
/** Names the scheduled daily run screened today: the on-demand ones are not part of its 30. */
async function dailyUsed(db: Kysely<Database>, today: string): Promise<number> {
  return Number((await db.selectFrom('candidate_screenings').select(sql<string>`count(distinct domain)`.as('n')).where('day', '=', today).where('on_demand', '=', false).executeTakeFirstOrThrow()).n);
}
export async function onDemandAllowance(db: Kysely<Database>, nowMs: number): Promise<OnDemandAllowance> {
  const max = (await activeSelectionSettings(db)).values.intake.on_demand_screen_daily_max;
  const used = await onDemandUsed(db, idtDay(nowMs));
  return { daily_max: max, used_today: used, remaining: Math.max(0, max - used) };
}

interface Waiting {
  sel: Awaited<ReturnType<typeof activeSelectionSettings>>;
  byDomain: Map<string, { lane: string; ids: string[]; words: string[] | null }>;
  drops: { w: Awaited<ReturnType<typeof leftoverNames>>[number]; lane: 'S2' | 'S4' | 'S6' }[];
  counts: { no_kept_lane: number; dropping: number; leftovers: number };
  /** v3.4.0 (CR-026): the run was asked for named domains. */
  named?: boolean;
  /** v3.4.0 (CR-026): named domains left out of an on-demand run (only when `domains` was asked for). */
  skipped: RescreenSkip[];
}

export type RescreenSkip = { domain: string; reason: 'NOT_CHANGED' | 'NO_INTAKE' | 'OWNED' };

/**
 * v3.4.0 (CR-026): which of the named domains an on-demand run takes. A name with a waiting (unscreened) intake row goes in as usual. A name screened before is
 * screened again only when the active settings version differs from its last screening's, or a domain record (tm_us, history, sellers) or an intake row of that name
 * was added after its last screening; else it is skipped NOT_CHANGED. No intake row (or only removed ones): NO_INTAKE. An owned name: OWNED.
 */
async function rescreenCandidates(db: Kysely<Database>, domains: string[], activeLabel: string, waiting: Map<string, { lane: string; ids: string[]; words: string[] | null }>, force = false): Promise<{ take: [string, { lane: string; ids: string[]; words: string[] | null }][]; skipped: RescreenSkip[] }> {
  const take: [string, { lane: string; ids: string[]; words: string[] | null }][] = [];
  const skipped: RescreenSkip[] = [];
  const owned = await ownedDomains(db, domains);
  for (const domain of domains) {
    const queued = waiting.get(domain);
    if (queued) { take.push([domain, queued]); continue; }
    const rows = await db.selectFrom('candidate_intake').select(['id', 'lane', 'words', 'received_at']).where('domain', '=', domain).where('status', 'in', ['queued', 'duplicate']).orderBy('id').execute();
    if (rows.length === 0) { skipped.push({ domain, reason: 'NO_INTAKE' }); continue; }
    if (owned.has(domain)) { skipped.push({ domain, reason: 'OWNED' }); continue; }
    const last = await db.selectFrom('candidate_screenings as s').innerJoin('screening_runs as r', 'r.id', 's.run_id').select(['s.at', 'r.settings_label']).where('s.domain', '=', domain).orderBy('s.at', 'desc').orderBy('s.id', 'desc').limit(1).executeTakeFirst();
    const newest = rows[rows.length - 1]!;
    let changed = !last; // never screened (all its rows were screened-less): goes in as usual
    if (last) {
      if (last.settings_label !== activeLabel) changed = true;
      else if (rows.some((r) => r.received_at.getTime() > last.at.getTime())) changed = true;
      else changed = !!(await db.selectFrom('domain_records').select('id').where('domain', '=', domain).where('created_at', '>', last.at).limit(1).executeTakeFirst());
    }
    if (!changed && !force) { skipped.push({ domain, reason: 'NOT_CHANGED' }); continue; }
    take.push([domain, { lane: newest.lane, ids: [newest.id], words: [...rows].reverse().find((r) => r.words)?.words ?? null }]);
  }
  return { take, skipped };
}

/** The names waiting to be screened (scout names not yet screened, drop-list leftovers that fit a kept lane). Read-only; the daily run and the on-demand run share it. */
async function gatherWaiting(db: Kysely<Database>, nowMs: number, today: string, only?: string[], force = false): Promise<Waiting> {
  // Queued intake rows not yet screened, oldest first; one name per domain, an owned name is never screened.
  const queued = (await sql<{ id: string; domain: string; lane: string; words: string[] | null }>`
    select i.id, i.domain, i.lane, i.words from candidate_intake i
    where i.status = 'queued' and not exists (select 1 from candidate_screenings s where s.intake_id = i.id)
      and not exists (select 1 from domains d where d.domain = i.domain and d.status in ('pending_purchase','owned','listed','delisted'))
    order by i.id`.execute(db)).rows;
  const byDomain = new Map<string, { lane: string; ids: string[]; words: string[] | null }>();
  for (const q of queued) {
    const e = byDomain.get(q.domain) ?? byDomain.set(q.domain, { lane: q.lane, ids: [], words: null }).get(q.domain)!;
    e.ids.push(q.id);
    if (e.words === null && q.words) e.words = q.words;
  }
  if (only) {
    // v3.4.0 (CR-026): the named domains only (no drop-list names): the waiting ones as usual, screened ones again when something changed.
    const sel = await activeSelectionSettings(db);
    const r = await rescreenCandidates(db, only, sel.label, byDomain, force);
    return { sel, byDomain: new Map(r.take), drops: [], counts: { no_kept_lane: 0, dropping: 0, leftovers: 0 }, skipped: r.skipped, named: true };
  }
  // v3.2.0 (CR-019 C-3/C-4, CR-020 A): drop-list names are screened only as leftovers (free at the registry after their drop date, never in pending delete or redemption),
  // not screened in the last 7 days, not owned, and only when they fit a kept lane (S2, S4 or S6). The rest stay on their list (NO_KEPT_LANE) and are counted.
  const sel = await activeSelectionSettings(db);
  const fit = await laneFitter(db, sel.values);
  const dropping = (await namesDroppingBetween(db, nowMs, addDays(today, -DROP_SCREEN_WINDOW_DAYS), addDays(today, 60))).filter((w) => ['pending_delete', 'redemption'].includes(w.status)).length;
  const left = await leftoverNames(db, nowMs, today);
  const recent = new Set((await db.selectFrom('candidate_screenings').select('domain').where('at', '>', new Date(nowMs - DROP_SCREEN_WINDOW_DAYS * DAY_MS)).execute()).map((r) => r.domain));
  const ownedAll = await ownedDomains(db, left.map((w) => w.domain));
  const fresh = left.filter((w) => !recent.has(w.domain) && !ownedAll.has(w.domain) && !byDomain.has(w.domain)); // kept rows only: the form filter ran at upload (leftoverNames reads kept rows)
  const laned = fresh.map((w) => ({ w, lane: fit(w.domain) }));
  const drops = laned.filter((x): x is { w: typeof x.w; lane: 'S2' | 'S4' | 'S6' } => x.lane !== null);
  return { sel, byDomain, drops, counts: { no_kept_lane: laned.length - drops.length, dropping, leftovers: drops.length }, skipped: [] };
}

/** Scout names first (oldest first). With the default share (1) drop-list names only fill what is left; a smaller share reserves up to that share of the budget for them
 * (the most they may take), and scout names take the rest. The daily run and the on-demand run order names the same way. */
function chooseNames(w: Waiting, budget: number): { takenIntake: [string, Waiting['byDomain'] extends Map<string, infer V> ? V : never][]; takenDrops: Waiting['drops'] } {
  const queuedBefore = w.byDomain.size;
  const share = w.sel.values.intake.drop_list_max_share;
  const nDrops = share >= 1 ? Math.min(w.drops.length, Math.max(0, budget - queuedBefore)) : Math.min(w.drops.length, dropListQuota(share, budget));
  return { takenIntake: [...w.byDomain.entries()].slice(0, Math.max(0, budget - nDrops)), takenDrops: w.drops.slice(0, nDrops) };
}

/**
 * The names an on-demand run takes. A named run (CR-026) counts distinct names per IDT day: a name already screened on demand today is free, a new one takes one
 * place of what is left of the allowance. Else the daily rules of chooseNames.
 */
async function chooseOnDemand(db: Kysely<Database>, w: Waiting, today: string, remaining: number, maxNames: number | null): Promise<ReturnType<typeof chooseNames> & { counted: Set<string> }> {
  const counted = new Set((await db.selectFrom('candidate_screenings').select('domain').where('day', '=', today).where('on_demand', '=', true).execute()).map((r) => r.domain));
  if (!w.named) return { ...chooseNames(w, Math.min(remaining, maxNames ?? Number.MAX_SAFE_INTEGER)), counted };
  const takenIntake: ReturnType<typeof chooseNames>['takenIntake'] = [];
  let left = remaining;
  for (const e of w.byDomain.entries()) {
    if (maxNames !== null && takenIntake.length >= maxNames) break;
    if (!counted.has(e[0])) { if (left <= 0) continue; left--; }
    takenIntake.push(e);
  }
  return { takenIntake, takenDrops: [], counted };
}

/**
 * v3.3.0 (CR-021): what an on-demand screening would take right now (read-only): its allowance and how many names (at most `maxNames`, at most what is left of the allowance).
 */
export async function planOnDemand(db: Kysely<Database>, nowMs: number, maxNames: number | null, domains?: string[], force = false): Promise<{ allowance: OnDemandAllowance; names_n: number; /** Of those, names not yet counted in today's allowance (a re-screen of a name already screened on demand today is free). */ new_n: number; skipped: RescreenSkip[] }> {
  const today = idtDay(nowMs);
  const w = await gatherWaiting(db, nowMs, today, domains, force);
  const max = w.sel.values.intake.on_demand_screen_daily_max;
  const used = await onDemandUsed(db, today);
  const allowance = { daily_max: max, used_today: used, remaining: Math.max(0, max - used) };
  const { counted, ...t } = await chooseOnDemand(db, w, today, allowance.remaining, maxNames);
  const taken = [...t.takenIntake.map(([d]) => d), ...t.takenDrops.map((d) => d.w.domain)];
  return { allowance, names_n: taken.length, new_n: taken.filter((d) => !counted.has(d)).length, skipped: w.skipped };
}

export interface IntakeRunOptions {
  /** On demand (POST /candidates/screen): screens against its own allowance, at most `maxNames` names (null = the allowance). */
  onDemand?: { maxNames: number | null; /** v3.4.0 (CR-026): screen only these names (re-screens allowed when something changed). */ domains?: string[]; /** v3.4.1 (CR-028): re-screen the named names even when nothing changed (NO_INTAKE and OWNED still skip). */ force?: boolean };
}

export class IntakeScreeningJob {
  private running = false;
  constructor(private readonly deps: { db: Kysely<Database>; worker: ScreeningWorker; now: () => number }) {}

  /** The `onDemandScreen` step: the run, with the allowance as it stands after it. */
  async runOnDemand(maxNames: number | null, domains?: string[], force = false): Promise<IntakeScreeningSummary & { on_demand: true; allowance: OnDemandAllowance }> {
    const s = await this.runOnce({ onDemand: { maxNames, ...(domains && { domains }), ...(domains && force && { force }) } });
    return { ...s, on_demand: true, allowance: await onDemandAllowance(this.deps.db, this.deps.now()) };
  }

  async runOnce(opts: IntakeRunOptions = {}): Promise<IntakeScreeningSummary> {
    const onDemand = opts.onDemand;
    const none = (reason: string, over: Partial<IntakeScreeningSummary> = {}): IntakeScreeningSummary =>
      ({ skipped: true, reason, queued_before: 0, screened: 0, from_intake: 0, from_drop_lists: 0, left_for_next_run: 0, run_id: null, census_list: null, no_kept_lane: 0, dropping: 0, leftovers: 0, ...over });
    if (this.running) return none('ALREADY_RUNNING');
    this.running = true;
    try {
      const { worker } = this.deps;
      const nowMs = this.deps.now();
      const now = new Date(nowMs);
      const today = idtDay(nowMs);
      // v2.16.0: one transaction, serialised by an advisory lock, from the queue read to the bookkeeping rows, so two instances (or a retried trigger)
      // cannot screen the same names. The run itself is created on its own connection (createRun opens its own transaction); if anything after it
      // fails, the run is cancelled (it must not run with no bookkeeping) and the error is rethrown.
      const started: { runId: string | null } = { runId: null };
      try {
      const summary = await this.deps.db.transaction().execute(async (db) => {
      await advisoryXactLock(db, 'intake_screening');
      const w = await gatherWaiting(db, nowMs, today, onDemand?.domains, onDemand?.force);
      const { sel, byDomain, drops, counts } = w;
      const queuedBefore = byDomain.size;
      // The daily run's 30 count only the names it screened itself; the on-demand allowance counts only on-demand names (CR-021).
      const budget = onDemand
        ? Math.min(sel.values.intake.on_demand_screen_daily_max - await onDemandUsed(db, today), onDemand.maxNames ?? Number.MAX_SAFE_INTEGER)
        : INTAKE_DAILY_MAX - await dailyUsed(db, today);
      if (queuedBefore + drops.length === 0) return none('NO_NAMES', counts);
      if (budget <= 0) return none(onDemand ? 'ON_DEMAND_SCREEN_CAP' : 'DAILY_MAX_REACHED', { ...counts, queued_before: queuedBefore, left_for_next_run: queuedBefore + drops.length });

      const { takenIntake, takenDrops } = onDemand ? await chooseOnDemand(db, w, today, Math.max(0, sel.values.intake.on_demand_screen_daily_max - await onDemandUsed(db, today)), onDemand.maxNames) : chooseNames(w, budget);
      const census = await intakeCensusList(db);
      const names: InputName[] = [
        ...takenIntake.map(([domain, v]) => ({ domain, lane: v.lane as InputName['lane'], ...(v.words && { words: v.words }), ...(census && { census_list: census }) })),
        // A drop-list leftover is screened under the kept lane it fits (S2, S4 or S6).
        ...takenDrops.map((d) => ({ domain: d.w.domain, lane: d.lane, ...(census && { census_list: census }) })),
      ];
      const auditId = newAuditId();
      // on the pool, not the locked transaction: the run row (made on its own connection) refers to this audit row
      await this.deps.db.insertInto('audit_log').values({
        id: auditId, at: now, scope: 'job', method: 'JOB', path: onDemand ? 'on-demand-screen' : 'intake-screening', request: JSON.stringify({ names: names.length, ...(onDemand?.force && { force: true }) }), status_code: 200,
        result_summary: `intake ${takenIntake.length}; drop lists ${takenDrops.length}; left ${queuedBefore + drops.length - names.length}`,
      }).execute();
      const run = await createRun(this.deps.db, { mode: 'full', names }, { createdBy: onDemand ? 'onDemandScreen' : 'intakeScreening', auditId, now }, worker.checks);
      started.runId = run.id;
      for (const [domain, v] of takenIntake) {
        for (const id of v.ids) await db.insertInto('candidate_screenings').values({ intake_id: id, domain, origin: 'intake', run_id: run.id, day: today, at: now, on_demand: !!onDemand }).execute();
      }
      for (const d of takenDrops) await db.insertInto('candidate_screenings').values({ intake_id: null, domain: d.w.domain, origin: 'drop_list', run_id: run.id, day: today, at: now, on_demand: !!onDemand }).execute();
      return {
        queued_before: queuedBefore, screened: names.length, from_intake: takenIntake.length, from_drop_lists: takenDrops.length,
        left_for_next_run: queuedBefore + drops.length - names.length, run_id: run.id, census_list: census, ...counts,
      };
      });
      if (summary.run_id) worker.kick(summary.run_id);
      return summary;
      } catch (e) {
        if (started.runId !== null) await worker.cancel(started.runId, 'system', 'intake bookkeeping failed').catch(() => null);
        throw e;
      }
    } finally {
      this.running = false;
    }
  }
}
