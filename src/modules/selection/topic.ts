// CR-043 topic reuse (v3.10.0): a shared topic per name. The scout's `topic` (free text, lower-cased) or, when absent, `<lane>:<first two content words>` of the name's split.
// A topic seen on another name's intake row within `intake.topic_window_days` is flagged TOPIC_REUSED (information; it never rejects).
import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';

export const TOPIC_MAX_CHARS = 60;
const DAY_MS = 86_400_000;
/** A word of fewer letters than this is a fragment of the split (it, os, ad), not a content word. */
const CONTENT_MIN_CHARS = 3;

/** The scout's topic as stored: trimmed and lower-cased (the intake schema already bounds the length). */
export const normalizeTopic = (raw: string): string => raw.trim().toLowerCase();

/** The topic of a name: the given one, else `<lane>:<first two content words>`; null when the split has no content word. */
export function topicFor(lane: string, tokens: readonly string[] | null | undefined, given?: string | null): string | null {
  if (given) return normalizeTopic(given).slice(0, TOPIC_MAX_CHARS);
  const content = (tokens ?? []).filter((t) => t.length >= CONTENT_MIN_CHARS).slice(0, 2);
  return content.length === 0 ? null : `${lane.toLowerCase()}:${content.join(' ')}`.slice(0, TOPIC_MAX_CHARS);
}

export interface TopicEarlier { intake_id: number; domain: string; received_at: string }

/**
 * Other names (not removed) that carried `topic` in the `windowDays` before `at`. With `beforeId` only rows with a smaller id count (a row never reuses itself or a later row).
 * A name re-sent under its own domain never reuses its own topic.
 */
export async function earlierWithTopic(db: Kysely<Database>, o: { topic: string; domain: string; at: Date; windowDays: number; beforeId?: string | number }): Promise<TopicEarlier[]> {
  let q = db.selectFrom('candidate_intake').select(['id', 'domain', 'received_at']).where('topic', '=', o.topic).where('domain', '!=', o.domain).where('status', '!=', 'removed')
    .where('received_at', '>=', new Date(o.at.getTime() - o.windowDays * DAY_MS)).where('received_at', '<=', o.at);
  if (o.beforeId !== undefined) q = q.where('id', '<', String(o.beforeId));
  const rows = await q.orderBy('id').execute();
  const seen = new Set<string>();
  const out: TopicEarlier[] = [];
  for (const r of rows) {
    if (seen.has(r.domain)) continue; // one entry per earlier name (its first row in the window)
    seen.add(r.domain);
    out.push({ intake_id: Number(r.id), domain: r.domain, received_at: r.received_at.toISOString() });
  }
  return out;
}
