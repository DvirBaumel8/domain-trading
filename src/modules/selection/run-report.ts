// GET /screening/runs/{id}/report.csv (v3.10.0, CR-043): one row per name of a run. Cells that a spreadsheet would read as a formula are neutralised.
import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { toCsv } from '../listing/index.js';
import type { AssembledItem } from './engine.js';
import { latestByCheck } from './derive.js';
import { earlierWithTopic } from './topic.js';

export const REPORT_HEADER = [
  'domain', 'lane', 'status', 'first_fail', 'ev_cents', 'ratio', 'score', 'tier', 'lookalikes_registered', 'lookalikes_in_use', 'topic', 'topic_reused',
  'sellers_verified_n', 'comps_n', 'reason_codes',
] as const;

/** A cell starting with = + - @ (or a tab / carriage return) would run as a formula in a spreadsheet: prefix an apostrophe (OWASP CSV injection). */
export function csvSafe(cell: string): string {
  return /^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell;
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** The intake facts of each name: the newest non-removed intake row's topic and whether it was reused, and the comps count of the newest row that has any. */
async function intakeFacts(db: Kysely<Database>, domains: string[], windowDays: number): Promise<Map<string, { topic: string; reused: boolean } | null>> {
  const out = new Map<string, { topic: string; reused: boolean } | null>();
  for (const domain of domains) {
    const row = await db.selectFrom('candidate_intake').select(['id', 'topic', 'received_at']).where('domain', '=', domain).where('status', '!=', 'removed')
      .where('topic', 'is not', null).orderBy('id', 'desc').limit(1).executeTakeFirst();
    out.set(domain, row?.topic ? { topic: row.topic, reused: (await earlierWithTopic(db, { topic: row.topic, domain, at: row.received_at, windowDays, beforeId: row.id })).length > 0 } : null);
  }
  return out;
}
async function compsCounts(db: Kysely<Database>, domains: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const domain of domains) {
    const row = await db.selectFrom('candidate_intake').select('comps').where('domain', '=', domain).where('status', 'in', ['queued', 'duplicate']).where('comps', 'is not', null).orderBy('id', 'desc').limit(1).executeTakeFirst();
    out.set(domain, Array.isArray(row?.comps) ? row.comps.length : 0);
  }
  return out;
}

export async function runReportCsv(db: Kysely<Database>, items: AssembledItem[], o: { topicWindowDays: number }): Promise<string> {
  const domains = items.map((i) => i.item.domain);
  const topics = await intakeFacts(db, domains, o.topicWindowDays);
  const comps = await compsCounts(db, domains);
  const rows: string[][] = [[...REPORT_HEADER]];
  for (const i of items) {
    const latest = latestByCheck(i.rows);
    const f = (id: Parameters<typeof latest.get>[0]): Record<string, unknown> => latest.get(id)?.fields ?? {};
    const look = (f('lookalikes').lookalikes ?? {}) as { registered_n?: unknown; in_use_n?: unknown };
    const sellers = f('tier').sellers as { verified_n?: unknown } | undefined;
    const codes = [...new Set([i.derived.first_fail?.reason_code, i.derived.reason_code, ...[...latest.values()].filter((r) => r.status !== 'PASS' && r.reason_code).map((r) => r.reason_code)].filter((c): c is string => !!c))];
    const t = topics.get(i.item.domain) ?? null;
    rows.push([
      i.item.domain, i.item.lane, i.derived.final_status, i.derived.first_fail?.check ?? '', str(f('price').ev_cents), str(f('price').ratio_at_floor), str(f('price').score_0_100),
      str(f('tier').tier), str(look.registered_n), str(look.in_use_n), t?.topic ?? '', t === null ? '' : t.reused ? 'true' : 'false',
      str(sellers?.verified_n), String(comps.get(i.item.domain) ?? 0), codes.join(';'),
    ].map(csvSafe));
  }
  return toCsv(rows);
}
