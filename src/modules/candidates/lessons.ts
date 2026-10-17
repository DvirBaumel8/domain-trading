// v5.3.0 (CR-053): scout lessons. Logic for POST/GET/PATCH /lessons, /lessons/check and /lessons/report (routes: api/lessons.ts).
import { randomBytes } from 'node:crypto';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { addMonthsClamped, idtDayStart, toJerusalemIso } from '../../core/dates.js';
import type { Database, ScoutLessonsTable } from '../../db/types.js';
import { AppError } from '../../http/errors.js';

export const SCOUTS = ['tzofeh-geo', 'rules', 'signals', 'drops', 'other'] as const;
export const SECTORS = ['S2', 'S3', 'S4', 'S6', 'S7', 'cross'] as const;
const MAX_NOTES = 20;
const RECURRING_MIN = 3;
const RECURRING_FLAG = 'recurring – is the rule or the method wrong?';

type Row = Selectable<ScoutLessonsTable>;
interface Note { at: string; lesson: string }
export interface NewLesson {
  scout: (typeof SCOUTS)[number]; sector: (typeof SECTORS)[number]; domains: string[]; rule: string; lesson: string;
  recheck_if: string; source_file: string | null;
}
export interface Actor { by: string; auditId: string | null; now: Date }

const newId = (): string => `les_${randomBytes(8).toString('hex')}`;
const notesOf = (r: Row): Note[] => (Array.isArray(r.notes) ? (r.notes as Note[]) : []);

function lessonView(r: Row) {
  return {
    id: r.id, created_at: toJerusalemIso(r.created_at), updated_at: toJerusalemIso(r.updated_at), scout: r.scout, sector: r.sector,
    domains: r.domains, rule: r.rule, lesson: r.lesson, notes: notesOf(r), recheck_if: r.recheck_if, source_file: r.source_file,
    superseded_by: r.superseded_by, created_by: r.created_by,
  };
}

/** One transaction for the whole POST: the lessons are merged in order, so a duplicate inside the same call merges too. */
export async function addLessons(db: Kysely<Database>, items: NewLesson[], actor: Actor): Promise<{ id: string; merged: boolean }[]> {
  return db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtext('scout_lessons'))`.execute(trx);
    const out: { id: string; merged: boolean }[] = [];
    for (const it of items) out.push(await addOne(trx, it, actor));
    return out;
  });
}

async function addOne(trx: Transaction<Database>, it: NewLesson, actor: Actor): Promise<{ id: string; merged: boolean }> {
  if (it.domains.length > 0) {
    const hit = await trx.selectFrom('scout_lessons').selectAll()
      .where('sector', '=', it.sector).where('rule', '=', it.rule).where('superseded_by', 'is', null)
      .where(sql<boolean>`domains && ${it.domains}::text[]`)
      .orderBy('created_at').orderBy('id').limit(1).executeTakeFirst();
    if (hit) {
      let notes = notesOf(hit);
      const seen = hit.lesson === it.lesson || notes.some((n) => n.lesson === it.lesson);
      if (!seen) notes = [...notes, { at: actor.now.toISOString(), lesson: it.lesson }].slice(-MAX_NOTES);
      const domains = [...new Set([...hit.domains, ...it.domains])];
      await trx.updateTable('scout_lessons').set({
        notes: JSON.stringify(notes), domains, recheck_if: it.recheck_if, updated_at: actor.now,
        source_file: hit.source_file ?? it.source_file,
      }).where('id', '=', hit.id).execute();
      return { id: hit.id, merged: true };
    }
  }
  const id = newId();
  await trx.insertInto('scout_lessons').values({
    id, created_at: actor.now, updated_at: actor.now, scout: it.scout, sector: it.sector, domains: it.domains, rule: it.rule,
    lesson: it.lesson, notes: '[]', recheck_if: it.recheck_if, source_file: it.source_file, superseded_by: null, created_by: actor.by,
  }).execute();
  return { id, merged: false };
}

const like = (s: string): string => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function listLessons(db: Kysely<Database>, q: { sector?: string; since?: string; rule?: string; q?: string; limit: number }) {
  let sel = db.selectFrom('scout_lessons').selectAll();
  if (q.sector) sel = sel.where('sector', '=', q.sector);
  if (q.rule) sel = sel.where('rule', '=', q.rule.toLowerCase());
  if (q.since) sel = sel.where('created_at', '>=', idtDayStart(q.since));
  if (q.q) {
    const p = like(q.q);
    sel = sel.where((eb) => eb.or([
      sql<boolean>`lesson ilike ${p}`, sql<boolean>`notes::text ilike ${p}`, sql<boolean>`array_to_string(domains, ',') ilike ${p}`,
    ]));
  }
  const rows = await sel.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(q.limit).execute();
  return rows.map(lessonView);
}

export async function lessonsForDomain(db: Kysely<Database>, domain: string) {
  const rows = await db.selectFrom('scout_lessons').selectAll().where(sql<boolean>`domains @> ${[domain]}::text[]`)
    .orderBy('created_at', 'desc').orderBy('id', 'desc').execute();
  return rows.map(lessonView);
}

export interface LessonPatch { recheck_if?: string; superseded_by?: string | null; lesson?: string }

export async function patchLesson(db: Kysely<Database>, id: string, patch: LessonPatch, now: Date) {
  return db.transaction().execute(async (trx) => {
    const row = await trx.selectFrom('scout_lessons').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!row) throw new AppError(404, 'LESSON_NOT_FOUND', 'No lesson with this id', { id });
    if (patch.superseded_by) {
      if (patch.superseded_by === id) throw new AppError(422, 'VALIDATION_ERROR', 'A lesson cannot supersede itself', { issues: [{ path: 'superseded_by', message: 'must be another lesson' }] });
      const other = await trx.selectFrom('scout_lessons').select('id').where('id', '=', patch.superseded_by).executeTakeFirst();
      if (!other) throw new AppError(422, 'VALIDATION_ERROR', 'superseded_by names no lesson', { issues: [{ path: 'superseded_by', message: `no lesson ${patch.superseded_by}` }] });
    }
    const upd = await trx.updateTable('scout_lessons').set({ ...patch, updated_at: now }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    return lessonView(upd);
  });
}

interface ReportRule { rule: string; count: number; recurring: boolean; flag?: string; examples: { id: string; domains: string[]; lesson: string }[] }
interface ReportSector { sector: string; lessons_n: number; top_rules: ReportRule[] }
export interface LessonReport { month: string; lessons_n: number; sectors: ReportSector[]; recurring: { sector: string; rule: string; count: number; flag: string }[] }

export async function lessonReport(db: Kysely<Database>, month: string): Promise<LessonReport> {
  const from = idtDayStart(`${month}-01`);
  const to = idtDayStart(addMonthsClamped(`${month}-01`, 1));
  const rows = await db.selectFrom('scout_lessons').selectAll().where('created_at', '>=', from).where('created_at', '<', to)
    .orderBy('created_at').orderBy('id').execute();
  const sectors: ReportSector[] = [];
  const recurring: LessonReport['recurring'] = [];
  for (const sector of SECTORS) {
    const inSector = rows.filter((r) => r.sector === sector);
    if (inSector.length === 0) continue;
    const byRule = new Map<string, Row[]>();
    for (const r of inSector) byRule.set(r.rule, [...(byRule.get(r.rule) ?? []), r]);
    const ranked = [...byRule.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    const top_rules = ranked.slice(0, 5).map(([rule, list]): ReportRule => {
      const isRec = list.length >= RECURRING_MIN;
      return {
        rule, count: list.length, recurring: isRec, ...(isRec ? { flag: RECURRING_FLAG } : {}),
        examples: list.slice(0, 2).map((r) => ({ id: r.id, domains: r.domains, lesson: r.lesson })),
      };
    });
    for (const [rule, list] of ranked) if (list.length >= RECURRING_MIN) recurring.push({ sector, rule, count: list.length, flag: RECURRING_FLAG });
    sectors.push({ sector, lessons_n: inSector.length, top_rules });
  }
  return { month, lessons_n: rows.length, sectors, recurring };
}

export function reportMarkdown(r: LessonReport): string {
  const out = [`# Scout lessons ${r.month}`, '', `${r.lessons_n} lessons.`, ''];
  for (const s of r.sectors) {
    out.push(`## ${s.sector} (${s.lessons_n})`, '');
    for (const t of s.top_rules) {
      out.push(`- **${t.rule}**: ${t.count}${t.flag ? ` (${t.flag})` : ''}`);
      for (const e of t.examples) out.push(`  - ${e.domains.length ? `${e.domains.join(', ')}: ` : ''}${e.lesson}`);
    }
    out.push('');
  }
  if (r.recurring.length > 0) {
    out.push('## Recurring', '');
    for (const x of r.recurring) out.push(`- ${x.sector} ${x.rule}: ${x.count} (${x.flag})`);
    out.push('');
  }
  return out.join('\n');
}
