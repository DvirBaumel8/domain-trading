// Stores one packet's feedback and its items with novelty (CR-011 part B). Shared by POST /reviews/{id}/feedback and the service's own review run.
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types.js';
import { AppError } from '../../../http/errors.js';
import { jaccard, noveltyTokens, REPEAT_JACCARD } from './novelty.js';

export interface FeedbackItemInput { category: string; severity: 'low' | 'medium' | 'high'; text: string }
export type FeedbackInput =
  | { status: 'ok'; provider: string; model: string; cost_usd: number; items: FeedbackItemInput[] }
  | { status: 'unknown'; provider: string; model?: string | undefined; cost_usd?: number | undefined; reason: string };

export interface StoredFeedback {
  feedback_id: number;
  items: { id: number; category: string; severity: string; novelty: 'new' | 'repeat'; repeats_item_id: number | null }[];
}

/** Throws 404 PACKET_NOT_FOUND / 409 FEEDBACK_EXISTS. The caller has already run the block list on the texts. */
export async function storeFeedback(
  db: Kysely<Database>,
  args: { packetId: string; createdBy: string; now: Date; input: FeedbackInput },
): Promise<StoredFeedback> {
  const { packetId, input: b, now: nowDate } = args;
  const packet = await db.selectFrom('review_packets').select('id').where('id', '=', packetId).executeTakeFirst();
  if (!packet) throw new AppError(404, 'PACKET_NOT_FOUND', 'No such review packet', { packet_id: packetId });
  const exists = () => new AppError(409, 'FEEDBACK_EXISTS', 'Feedback is already recorded for this packet', { packet_id: packetId });
  if (await db.selectFrom('review_feedback').select('id').where('packet_id', '=', packetId).executeTakeFirst()) throw exists();
  const items = b.status === 'ok' ? b.items : [];
  try {
    return await db.transaction().execute(async (trx) => {
      const fb = await trx.insertInto('review_feedback').values({
        packet_id: packetId, created_by: args.createdBy, created_at: nowDate, status: b.status, provider: b.provider,
        model: b.model ?? null, cost_usd: b.cost_usd ?? 0, reason: b.status === 'unknown' ? b.reason : null,
      }).returning('id').executeTakeFirstOrThrow();
      const earlier = new Map<string, { id: number; tokens: Set<string>; original: number }[]>();
      const out: StoredFeedback['items'] = [];
      for (const it of items) {
        if (!earlier.has(it.category)) {
          const rows = await trx.selectFrom('review_items').select(['id', 'text', 'repeats_item_id']).where('category', '=', it.category).orderBy('id').execute();
          earlier.set(it.category, rows.map((r) => ({ id: r.id, tokens: noveltyTokens(r.text), original: r.repeats_item_id ?? r.id })));
        }
        const pool = earlier.get(it.category)!;
        const tokens = noveltyTokens(it.text);
        let best: { id: number; original: number } | null = null;
        let bestScore = 0;
        for (const e of pool) {
          const s = jaccard(tokens, e.tokens);
          if (s > bestScore) { bestScore = s; best = e; }
        }
        const repeat = best !== null && bestScore >= REPEAT_JACCARD;
        const row = await trx.insertInto('review_items').values({
          packet_id: packetId, created_at: nowDate, category: it.category, severity: it.severity, text: it.text,
          novelty: repeat ? 'repeat' : 'new', repeats_item_id: repeat ? best!.original : null,
        }).returning(['id', 'category', 'severity', 'novelty', 'repeats_item_id']).executeTakeFirstOrThrow();
        pool.push({ id: row.id, tokens, original: row.repeats_item_id ?? row.id });
        out.push(row);
      }
      return { feedback_id: fb.id, items: out };
    });
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw exists();
    throw e;
  }
}
