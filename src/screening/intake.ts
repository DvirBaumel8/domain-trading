// v2.14.0 (CR-012 part C): scouts send names (POST /candidates/intake); the daily step `intakeScreening` screens them (with the drop-list names that are about
// to drop) in ONE full-plan run and records what it took. Nothing here calls a registrar or marketplace; the screening run does its own lookups.
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { jerusalemDate } from '../dates.js';
import type { Database } from '../db/types.js';
import { filterDropName, namesDroppingBetween, addDays, todayIdt, type RemovedReason } from '../drops/drop-lists.js';
import { newAuditId } from '../http/audit.js';
import { AppError } from '../http/errors.js';
import { CompSchema } from '../services/listing-v2.js';
import { createRun, type InputName, type ScreeningWorker } from './engine.js';
import { methodApproval } from './sibling-methods.js';

/** A name sent again within this many days is a duplicate (its extra source is recorded, it is not screened twice). */
export const INTAKE_DEDUPE_DAYS = 30;
/** The most names one IDT day's intake screening takes (intake names first, then drop-list names). */
export const INTAKE_DAILY_MAX = 30;
/** A drop-list name is screened when its expected drop date is within this many days, and not screened again for this many days. */
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
  }).strict()).min(1).max(100),
}).strict();
export type IntakeBodyT = z.infer<typeof IntakeBody>;

export type IntakeRemoval = 'DOMAIN_INVALID' | 'NOT_COM' | 'HAS_DIGIT' | 'HAS_HYPHEN' | 'NO_SPLIT' | 'TOO_MANY_WORDS' | 'ONE_WORD' | 'OWNED' | 'DUPLICATE_IN_UPLOAD';

/** The form rules of an intake name (before ownership and duplicates): a letters-only second-level .com of at most 3 words by the bt1@v2 split. */
export function intakeFormReason(raw: string): { domain: string; reason: IntakeRemoval | null } {
  const domain = raw.trim().toLowerCase();
  const labels = domain.split('.');
  const validLabel = (l: string) => /^[a-z0-9-]{1,63}$/.test(l) && !l.startsWith('-') && !l.endsWith('-');
  if (labels.length !== 2 || !labels.every(validLabel)) return { domain, reason: 'DOMAIN_INVALID' };
  if (labels[1] !== 'com') return { domain, reason: 'NOT_COM' };
  return { domain, reason: null };
}

/** The word rules, after the upload-duplicate test: the drop-list filter's own (digit, hyphen, no split, more than 3 words, one word). v2.16.0: one rule set for both feeds. */
function wordReason(domain: string): IntakeRemoval | null {
  const f = filterDropName(domain, new Set());
  return f.kept ? null : (f.reason as RemovedReason as IntakeRemoval);
}

/** v2.16.0 (CR-015 I-1): `note` and `source` carry no personal data: the rule of /offers (no '@'), 422 NO_PII with the name's index and the field. */
export function checkIntakePii(body: IntakeBodyT): void {
  body.names.forEach((n, index) => {
    for (const field of ['note', 'source'] as const) {
      const v = n[field];
      if (v != null && v.includes('@')) throw new AppError(422, 'NO_PII', `names[${index}].${field} must not contain an email address or '@'`, { index, field });
    }
  });
}

/** Comparable sales must be real, past dates (the same rule as /buy). */
export function checkIntakeComps(body: IntakeBodyT, today: string): void {
  body.names.forEach((n, ni) => (n.comps ?? []).forEach((c, i) => {
    const t = new Date(`${c.sold_on}T00:00:00Z`);
    if (Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== c.sold_on) throw new AppError(422, 'COMPS_INVALID', `names[${ni}].comps[${i}].sold_on is not a real date`, { index: ni, comp: i });
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
  checkIntakeComps(body, jerusalemDate(ctx.now));
  checkIntakePii(body);
  const out: IntakeResult = { accepted: [], duplicates: [], removed: [] };
  const checked = body.names.map((n) => ({ n, ...intakeFormReason(n.domain) }));
  const owned = await ownedDomains(db, checked.map((c) => c.domain));
  const since = new Date(ctx.now.getTime() - INTAKE_DEDUPE_DAYS * DAY_MS);
  await db.transaction().execute(async (trx) => {
    const seen = new Set<string>();
    for (const c of checked) {
      const row = { lane: c.n.lane, source: c.n.source, note: c.n.note ?? null, comps: c.n.comps ? JSON.stringify(c.n.comps) : null, received_at: ctx.now, token_name: ctx.tokenName, audit_id: ctx.auditId };
      let reason: IntakeRemoval | null = c.reason;
      if (reason === null) {
        if (seen.has(c.domain)) reason = 'DUPLICATE_IN_UPLOAD';
        else { seen.add(c.domain); reason = wordReason(c.domain) ?? (owned.has(c.domain) ? 'OWNED' : null); }
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
}

/** The census list of the intake run: the first APPROVED method of INTAKE_CENSUS_PREFERENCE, else none (the census is then honestly UNKNOWN). */
export async function intakeCensusList(db: Kysely<Database>): Promise<string | null> {
  for (const m of INTAKE_CENSUS_PREFERENCE) if (await methodApproval(db, m)) return m;
  return null;
}

export class IntakeScreeningJob {
  private running = false;
  constructor(private readonly deps: { db: Kysely<Database>; worker: ScreeningWorker; now: () => number }) {}

  async runOnce(): Promise<IntakeScreeningSummary> {
    const none = (reason: string, over: Partial<IntakeScreeningSummary> = {}): IntakeScreeningSummary =>
      ({ skipped: true, reason, queued_before: 0, screened: 0, from_intake: 0, from_drop_lists: 0, left_for_next_run: 0, run_id: null, census_list: null, ...over });
    if (this.running) return none('ALREADY_RUNNING');
    this.running = true;
    try {
      const { worker } = this.deps;
      const nowMs = this.deps.now();
      const now = new Date(nowMs);
      const today = todayIdt(nowMs);
      // v2.16.0: one transaction, serialised by an advisory lock, from the queue read to the bookkeeping rows, so two instances (or a retried trigger)
      // cannot screen the same names. The run itself is created on its own connection (createRun opens its own transaction); if anything after it
      // fails, the run is cancelled (it must not run with no bookkeeping) and the error is rethrown.
      const started: { runId: string | null } = { runId: null };
      try {
      const summary = await this.deps.db.transaction().execute(async (db) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext('intake_screening'))`.execute(db);
      const doneToday = Number((await db.selectFrom('candidate_screenings').select(sql<string>`count(distinct domain)`.as('n')).where('day', '=', today).executeTakeFirstOrThrow()).n);

      // Queued intake rows not yet screened, oldest first; one name per domain, an owned name is never screened.
      const queued = (await sql<{ id: string; domain: string; lane: string }>`
        select i.id, i.domain, i.lane from candidate_intake i
        where i.status = 'queued' and not exists (select 1 from candidate_screenings s where s.intake_id = i.id)
          and not exists (select 1 from domains d where d.domain = i.domain and d.status in ('pending_purchase','owned','listed','delisted'))
        order by i.id`.execute(db)).rows;
      const byDomain = new Map<string, { lane: string; ids: string[] }>();
      for (const q of queued) (byDomain.get(q.domain) ?? byDomain.set(q.domain, { lane: q.lane, ids: [] }).get(q.domain)!).ids.push(q.id);

      // Drop-list names about to drop: latest check pending delete or redemption, expected drop within the window, not screened in the last 7 days, not owned.
      const window = await namesDroppingBetween(db, nowMs, today, addDays(today, DROP_SCREEN_WINDOW_DAYS));
      const recent = new Set((await db.selectFrom('candidate_screenings').select('domain').where('at', '>', new Date(nowMs - DROP_SCREEN_WINDOW_DAYS * DAY_MS)).execute()).map((r) => r.domain));
      const ownedAll = await ownedDomains(db, window.map((w) => w.domain));
      const drops = window.filter((w) => ['pending_delete', 'redemption'].includes(w.status) && !recent.has(w.domain) && !ownedAll.has(w.domain) && !byDomain.has(w.domain));

      const queuedBefore = byDomain.size;
      const budget = INTAKE_DAILY_MAX - doneToday;
      if (queuedBefore + drops.length === 0) return none('NO_NAMES');
      if (budget <= 0) return none('DAILY_MAX_REACHED', { queued_before: queuedBefore, left_for_next_run: queuedBefore + drops.length });

      const takenIntake = [...byDomain.entries()].slice(0, budget);
      const takenDrops = drops.slice(0, budget - takenIntake.length);
      const census = await intakeCensusList(db);
      const names: InputName[] = [
        ...takenIntake.map(([domain, v]) => ({ domain, lane: v.lane as InputName['lane'], ...(census && { census_list: census }) })),
        // A drop-list name has no scout lane: S7 (the general lane of the test sets).
        ...takenDrops.map((d) => ({ domain: d.domain, lane: 'S7' as const, ...(census && { census_list: census }) })),
      ];
      const auditId = newAuditId();
      // on the pool, not the locked transaction: the run row (made on its own connection) refers to this audit row
      await this.deps.db.insertInto('audit_log').values({
        id: auditId, at: now, scope: 'job', method: 'JOB', path: 'intake-screening', request: JSON.stringify({ names: names.length }), status_code: 200,
        result_summary: `intake ${takenIntake.length}; drop lists ${takenDrops.length}; left ${queuedBefore + drops.length - names.length}`,
      }).execute();
      const run = await createRun(this.deps.db, { mode: 'full', names }, { createdBy: 'intakeScreening', auditId, now }, worker.checks);
      started.runId = run.id;
      for (const [domain, v] of takenIntake) {
        for (const id of v.ids) await db.insertInto('candidate_screenings').values({ intake_id: id, domain, origin: 'intake', run_id: run.id, day: today, at: now }).execute();
      }
      for (const d of takenDrops) await db.insertInto('candidate_screenings').values({ intake_id: null, domain: d.domain, origin: 'drop_list', run_id: run.id, day: today, at: now }).execute();
      return {
        queued_before: queuedBefore, screened: names.length, from_intake: takenIntake.length, from_drop_lists: takenDrops.length,
        left_for_next_run: queuedBefore + drops.length - names.length, run_id: run.id, census_list: census,
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
