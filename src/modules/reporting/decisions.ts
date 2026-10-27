// v5.63.0 (CR-084 R-7): the decisions store. One row per company decision id (D-...), append-only; a correction is a new id with `supersedes`.
// A pure record: nothing in the service reads a decision to act. The rows are kept in the nightly backup.
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { advisoryXactLock } from '../../core/locks.js';
import { toJerusalemIso } from '../../core/dates.js';
import { hasAtSign, piiError } from '../../core/validation.js';
import type { Database } from '../../db/types.js';
import { AppError } from '../../http/errors.js';

export const DECISIONS_MAX_ROWS = 500;
export const DECISION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,79}$/;

const Row = z.object({
  id: z.string().regex(DECISION_ID, 'id must be 2..80 characters of letters, digits and . _ : -'),
  decided_at: z.string().datetime({ offset: true }),
  decided_by: z.string().min(1).max(60),
  summary: z.string().min(1).max(1000),
  scope: z.string().regex(/^[a-z0-9_-]{1,40}$/, 'scope must be 1..40 characters of a-z 0-9 _ -').optional(),
  domains: z.array(z.string().min(3).max(253)).min(1).max(50).optional(),
  source_ref: z.string().min(1).max(200).optional(),
  supersedes: z.string().regex(DECISION_ID).optional(),
}).strict();
export const DecisionRow = Row;
export const DecisionsBody = z.object({ rows: z.array(Row).min(1).max(DECISIONS_MAX_ROWS), dry_run: z.boolean().optional() }).strict();
export type DecisionIn = z.infer<typeof Row>;

const iso = (d: Date) => toJerusalemIso(d);
const validation = (message: string, details?: Record<string, unknown>) => new AppError(422, 'VALIDATION_ERROR', message, details);

interface Stored { id: string; decided_at: Date; decided_by: string; summary: string; scope: string | null; domains: string[] | null; source_ref: string | null; supersedes: string | null }
const same = (a: Stored, b: Stored): boolean =>
  a.decided_at.getTime() === b.decided_at.getTime() && a.decided_by === b.decided_by && a.summary === b.summary && a.scope === b.scope
  && a.source_ref === b.source_ref && a.supersedes === b.supersedes && JSON.stringify(a.domains) === JSON.stringify(b.domains);

function normalise(r: DecisionIn): Stored {
  return {
    id: r.id, decided_at: new Date(r.decided_at), decided_by: r.decided_by, summary: r.summary, scope: r.scope ?? null,
    domains: r.domains ? r.domains.map((d) => d.trim().toLowerCase()) : null, source_ref: r.source_ref ?? null, supersedes: r.supersedes ?? null,
  };
}

/** Validates (no '@', real references), then appends the new rows in one transaction. A repeat of the same id with the same content is a duplicate; other content is 409 DECISION_EXISTS (nothing stored). */
export async function postDecisions(db: Kysely<Database>, body: z.infer<typeof DecisionsBody>, ctx: { by: string; auditId: string | null }) {
  const rows = body.rows.map(normalise);
  rows.forEach((r, index) => {
    for (const [field, v] of [['id', r.id], ['decided_by', r.decided_by], ['summary', r.summary], ['scope', r.scope], ['source_ref', r.source_ref], ...(r.domains ?? []).map((d) => ['domains', d] as const)] as [string, string | null][]) {
      if (hasAtSign(v)) throw piiError(`rows[${index}].${field} must not contain an email address or '@'`, { index, field });
    }
  });
  const dryRun = body.dry_run === true;
  return db.transaction().execute(async (trx) => {
    await advisoryXactLock(trx, 'decisions_write');
    const ids = [...new Set([...rows.map((r) => r.id), ...rows.flatMap((r) => (r.supersedes ? [r.supersedes] : []))])];
    const existing = new Map((await trx.selectFrom('decisions').select(['id', 'decided_at', 'decided_by', 'summary', 'scope', 'domains', 'source_ref', 'supersedes']).where('id', 'in', ids).execute()).map((e) => [e.id, e as Stored]));
    const seen = new Map<string, Stored>();
    const fresh: Stored[] = [];
    const conflicts: string[] = [];
    let duplicate = 0;
    rows.forEach((r, index) => {
      const prior = existing.get(r.id) ?? seen.get(r.id);
      if (prior) {
        if (same(prior, r)) duplicate += 1;
        else conflicts.push(r.id);
        return;
      }
      if (r.supersedes !== null) {
        if (r.supersedes === r.id) throw validation(`rows[${index}].supersedes must name another decision`, { index, field: 'supersedes' });
        if (!existing.has(r.supersedes) && !seen.has(r.supersedes)) throw validation(`rows[${index}].supersedes names an unknown decision "${r.supersedes}" (record it first, or earlier in the same batch)`, { index, field: 'supersedes' });
      }
      seen.set(r.id, r);
      fresh.push(r);
    });
    if (conflicts.length > 0) {
      throw new AppError(409, 'DECISION_EXISTS', `${[...new Set(conflicts)].length} decision id(s) already exist with different content; nothing was stored. A correction is a new id with "supersedes".`, { ids: [...new Set(conflicts)].slice(0, 50) });
    }
    if (!dryRun && fresh.length > 0) {
      await trx.insertInto('decisions').values(fresh.map((r) => ({ ...r, recorded_by: ctx.by, audit_id: ctx.auditId }))).execute();
    }
    return { dry_run: dryRun, received_n: rows.length, accepted_n: fresh.length, duplicate_n: duplicate, ids: fresh.map((r) => r.id) };
  });
}

interface DbRow extends Stored { recorded_by: string; recorded_at: Date; superseded_by: string | null }
const view = (r: DbRow) => ({
  id: r.id, decided_at: iso(r.decided_at), decided_by: r.decided_by, summary: r.summary, scope: r.scope, domains: r.domains, source_ref: r.source_ref,
  supersedes: r.supersedes, superseded_by: r.superseded_by, recorded_by: r.recorded_by, recorded_at: iso(r.recorded_at),
});

export const DecisionsQuery = z.object({
  q: z.string().min(1).max(200).optional(),
  scope: z.string().regex(/^[a-z0-9_-]{1,40}$/).optional(),
  domain: z.string().min(3).max(253).optional(),
  since: z.string().refine((v) => !Number.isNaN(new Date(v).getTime()), 'since must be a date or an ISO 8601 time').optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
}).strict();

const SELECT = sql`d.id, d.decided_at, d.decided_by, d.summary, d.scope, d.domains, d.source_ref, d.supersedes, d.recorded_by, d.recorded_at,
  (select s.id from decisions s where s.supersedes = d.id order by s.recorded_at, s.id limit 1) as superseded_by`;

export async function listDecisions(db: Kysely<Database>, q: z.infer<typeof DecisionsQuery>) {
  const like = q.q ? `%${q.q.replace(/[\\%_]/g, '\\$&')}%` : null;
  const where = sql`true
    ${like ? sql`and (d.id ilike ${like} or d.summary ilike ${like})` : sql``}
    ${q.scope ? sql`and d.scope = ${q.scope}` : sql``}
    ${q.domain ? sql`and ${q.domain.trim().toLowerCase()} = any(d.domains)` : sql``}
    ${q.since ? sql`and d.decided_at >= ${new Date(q.since)}` : sql``}`;
  const [rows, total] = await Promise.all([
    sql<DbRow>`select ${SELECT} from decisions d where ${where} order by d.decided_at desc, d.id limit ${q.limit} offset ${q.offset}`.execute(db),
    sql<{ n: number }>`select count(*)::int as n from decisions d where ${where}`.execute(db),
  ]);
  return { decisions: rows.rows.map(view), total_n: total.rows[0]!.n, limit: q.limit, offset: q.offset };
}

export async function getDecision(db: Kysely<Database>, id: string) {
  const r = await sql<DbRow>`select ${SELECT} from decisions d where d.id = ${id}`.execute(db);
  if (!r.rows[0]) throw new AppError(404, 'DECISION_NOT_FOUND', `No decision "${id.slice(0, 80)}"`);
  return view(r.rows[0]);
}
