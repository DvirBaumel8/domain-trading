// v2.13.0 (CR-012 part E, Q-6): records per domain. A US trademark search or a history check done by a human is kept against the NAME, not one run,
// so later runs of that name reuse it while it is fresh. Append-only (domain_records); the newest fresh row of a kind is used.
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';

export const RECORD_KINDS = ['tm_us', 'history'] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];
/** How long a record stays usable (days, counted from `checked_at`). Constants, not settings (CR-012 Q-6). */
export const RECORD_FRESH_DAYS: Record<RecordKind, number> = { tm_us: 30, history: 180 };
const DAY_MS = 86_400_000;

export const freshUntil = (kind: RecordKind, checkedAt: Date): Date => new Date(checkedAt.getTime() + RECORD_FRESH_DAYS[kind] * DAY_MS);
export const isFresh = (kind: RecordKind, checkedAt: Date, nowMs: number): boolean => checkedAt.getTime() <= nowMs + 60_000 && freshUntil(kind, checkedAt).getTime() > nowMs;

export interface FreshRecord { id: number; record: unknown; checkedAt: Date; evidenceUrl: string | null; note: string | null }

/** The newest fresh record of `kind` for a domain, or null (a stale record counts as missing). */
export async function freshDomainRecord(db: Kysely<Database>, domain: string, kind: RecordKind, nowMs: number): Promise<FreshRecord | null> {
  const r = await db.selectFrom('domain_records').selectAll().where('domain', '=', domain).where('kind', '=', kind)
    .where('checked_at', '>', new Date(nowMs - RECORD_FRESH_DAYS[kind] * DAY_MS)).where('checked_at', '<=', new Date(nowMs + 60_000))
    .orderBy('checked_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
  return r ? { id: Number(r.id), record: r.record, checkedAt: r.checked_at, evidenceUrl: r.evidence_url, note: r.note } : null;
}
