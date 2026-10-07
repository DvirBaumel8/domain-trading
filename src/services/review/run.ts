// The service's one AI call: the outside review (founder rule 9, changed 7 Oct 2026). Builds and stores a packet with the existing code,
// asks Gemini through src/services/review/gemini.ts, and stores the answer as feedback (provider `gemini`).
import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { AppError } from '../../http/errors.js';
import { checkText, type BlockCategory } from '../blocklist.js';
import { storeFeedback } from './feedback.js';
import { callGemini, geminiCostUsd } from './gemini.js';
import { buildPacket, idtDay, idtIsSunday, insertPacket, latestDocument, monthSpend, newPacketId, REVIEW_MONTHLY_CAP_USD, sha256 } from './packet.js';

export interface ReviewRunDeps {
  db: Kysely<Database>;
  fetch: typeof fetch;
  apiKey: string | undefined;
  model: string | undefined;
  secretValues: string[];
  version: string;
  timeoutMs?: number;
}
export type ReviewSkip = 'NO_KEY' | 'DOCUMENT_MISSING' | 'COST_CAP' | 'ALREADY_DONE_TODAY' | 'TEXT_BLOCKED';
export type ReviewRunResult =
  | { skipped: ReviewSkip; category?: BlockCategory }
  | { packet_id: string; kind: 'daily' | 'weekly'; status: 'ok' | 'unknown'; items_n: number; new_n: number; repeat_n: number; cost_usd: number; dropped_n: number; reason?: string };

export async function runReview(deps: ReviewRunDeps, opts: { trigger: 'scheduled' | 'manual'; now: number; createdBy?: string }): Promise<ReviewRunResult> {
  const { db } = deps;
  if (!deps.apiKey) return { skipped: 'NO_KEY' };
  if (!(await latestDocument(db))) return { skipped: 'DOCUMENT_MISSING' };
  if ((await monthSpend(db, opts.now)).spentUsd >= REVIEW_MONTHLY_CAP_USD) return { skipped: 'COST_CAP' };
  if (opts.trigger === 'scheduled') {
    const today = idtDay(opts.now);
    const recent = await db.selectFrom('review_packets as p').innerJoin('review_feedback as f', 'f.packet_id', 'p.id').select('p.created_at')
      .where('p.created_at', '>', new Date(opts.now - 36 * 3_600_000)).execute();
    if (recent.some((r) => idtDay(r.created_at.getTime()) === today)) return { skipped: 'ALREADY_DONE_TODAY' };
  }
  const now = new Date(opts.now);
  const built = await buildPacket(db, now, deps.version, { forceWeekly: idtIsSunday(opts.now) });
  if (!built) return { skipped: 'DOCUMENT_MISSING' };
  const text = JSON.stringify(built.content);
  const blocked = await checkText(db, text, { secretValues: deps.secretValues });
  if (!blocked.ok) return { skipped: 'TEXT_BLOCKED', category: blocked.category };
  const createdBy = opts.createdBy ?? 'dom-review';
  const id = newPacketId();
  await insertPacket(db, { id, createdBy, now, built, text, hash: sha256(text) });

  const g = await callGemini({ fetch: deps.fetch, apiKey: deps.apiKey, model: deps.model, timeoutMs: deps.timeoutMs }, text);
  if (g.kind === 'unknown') {
    const raw = `HTTP ${g.httpStatus ?? 'none'} ${g.errorStatus ?? 'none'}: ${g.reason}`.replaceAll(deps.apiKey, '[REDACTED]').slice(0, 500);
    const blockedReason = await checkText(db, raw, { secretValues: deps.secretValues });
    const reason = blockedReason.ok ? raw : `HTTP ${g.httpStatus ?? 'none'} ${g.errorStatus ?? 'none'}: reason withheld by the block list`;
    await storeFeedback(db, { packetId: id, createdBy, now, input: { status: 'unknown', provider: 'gemini', model: deps.model || undefined, reason } });
    return { packet_id: id, kind: built.kind, status: 'unknown', items_n: 0, new_n: 0, repeat_n: 0, cost_usd: 0, dropped_n: 0, reason };
  }
  const kept: typeof g.items = [];
  let dropped = 0;
  for (const it of g.items) {
    const b = await checkText(db, `${it.category}\n${it.text}`, { secretValues: deps.secretValues });
    if (b.ok) kept.push(it); else dropped++;
  }
  const cost = geminiCostUsd(g.inputTokens, g.outputTokens);
  const stored = await storeFeedback(db, { packetId: id, createdBy, now, input: { status: 'ok', provider: 'gemini', model: g.model, cost_usd: cost, items: kept } });
  const repeat = stored.items.filter((i) => i.novelty === 'repeat').length;
  return { packet_id: id, kind: built.kind, status: 'ok', items_n: stored.items.length, new_n: stored.items.length - repeat, repeat_n: repeat, cost_usd: cost, dropped_n: dropped };
}

/** Maps a skip from a manual run to the API error. */
export function skipToError(r: { skipped: ReviewSkip; category?: BlockCategory }): AppError {
  switch (r.skipped) {
    case 'NO_KEY': return new AppError(503, 'REVIEWER_NOT_CONFIGURED', 'No outside reviewer key is configured on the server');
    case 'COST_CAP': return new AppError(409, 'REVIEW_COST_CAP', 'The monthly review cost cap is reached', { cap_usd: REVIEW_MONTHLY_CAP_USD });
    case 'DOCUMENT_MISSING': return new AppError(409, 'DOCUMENT_MISSING', 'No company document has been uploaded; POST /company/document first');
    case 'TEXT_BLOCKED': return new AppError(422, 'TEXT_BLOCKED', 'The text is refused by the block list', { category: r.category });
    default: return new AppError(409, 'ALREADY_DONE_TODAY', 'Today\'s review is already done');
  }
}
