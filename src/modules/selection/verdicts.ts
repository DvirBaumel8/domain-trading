// FLAG verdicts (v1.2.0): a human PASS or REJECT recorded against ONE specific FLAG result row. A verdict is bound to that row's id, so a
// newer record for the same check (a new row in force) does not inherit it. The table is append-only; the latest verdict of a result wins.
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../db/types.js';
import { CHECK_IDS } from './settings.js';
import type { CheckId } from './types.js';

export const VerdictBody = z.object({
  domain: z.string().trim().min(1).max(253), check: z.enum(CHECK_IDS), result_id: z.number().int().positive(),
  verdict: z.enum(['PASS', 'REJECT']), reason: z.string().trim().min(1).max(500),
  decided_by: z.string().trim().min(1).max(80), decided_at: z.iso.datetime({ offset: true }),
}).strict();

export interface VerdictRow {
  id: number; result_id: number; check_id: CheckId; item_idx: number; verdict: 'PASS' | 'REJECT'; reason: string;
  decided_by: string; decided_at: Date; recorded_by: string;
}

/** The latest verdict per result id of a run (a later row overwrites an earlier one for the same result). */
export async function verdictsFor(db: Kysely<Database>, runId: string): Promise<Map<number, VerdictRow>> {
  const rows = await db.selectFrom('screening_verdicts').selectAll().where('run_id', '=', runId).orderBy('id').execute();
  const m = new Map<number, VerdictRow>();
  for (const r of rows) {
    m.set(Number(r.result_id), {
      id: Number(r.id), result_id: Number(r.result_id), check_id: r.check_id as CheckId, item_idx: r.item_idx, verdict: r.verdict, reason: r.reason,
      decided_by: r.decided_by, decided_at: r.decided_at, recorded_by: r.recorded_by,
    });
  }
  return m;
}
