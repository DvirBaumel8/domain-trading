// GET /screening/runs/{id}/report.csv (v3.10.0, CR-043): one row per name of a run. Cells that a spreadsheet would read as a formula are neutralised.
import { sql, type Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { toCsv } from '../listing/index.js';
import type { AssembledItem } from './engine.js';
import { latestByCheck } from './derive.js';

export const REPORT_HEADER = [
  'domain', 'lane', 'status', 'first_fail', 'ev_cents', 'ratio', 'score', 'tier', 'lookalikes_registered', 'lookalikes_in_use', 'topic', 'topic_reused',
  'sellers_verified_n', 'comps_n', 'reason_codes',
] as const;

/** A cell starting with = + - @ (or a tab / carriage return) would run as a formula in a spreadsheet: prefix an apostrophe (OWASP CSV injection). */
export function csvSafe(cell: string): string {
  return /^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell;
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** The intake facts of each name: the newest non-removed intake row's topic and whether it was reused (one statement for all names), and the comps count of the newest row that has any. */
async function intakeFacts(db: Kysely<Database>, domains: string[], windowDays: number): Promise<Map<string, { topic: string; reused: boolean } | null>> {
  const out = new Map<string, { topic: string; reused: boolean } | null>(domains.map((d) => [d, null]));
  if (domains.length === 0) return out;
  // same rule as earlierWithTopic: another non-removed name with the topic in the window before the row, from a smaller id
  const rows = await sql<{ domain: string; topic: string; reused: boolean }>`
    select t.domain, t.topic, exists (
      select 1 from candidate_intake e where e.topic = t.topic and e.domain <> t.domain and e.status <> 'removed' and e.id < t.id
        and e.received_at >= t.received_at - interval '1 second' * ${windowDays * 86_400} and e.received_at <= t.received_at) as reused
    from (select distinct on (domain) id, domain, topic, received_at from candidate_intake
          where domain = any(${domains}) and status <> 'removed' and topic is not null order by domain, id desc) t`.execute(db);
  for (const r of rows.rows) out.set(r.domain, r.topic ? { topic: r.topic, reused: r.reused } : null);
  return out;
}
async function compsCounts(db: Kysely<Database>, domains: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>(domains.map((d) => [d, 0]));
  if (domains.length === 0) return out;
  const rows = await sql<{ domain: string; n: number }>`
    select distinct on (domain) domain, case when jsonb_typeof(comps) = 'array' then jsonb_array_length(comps) else 0 end as n from candidate_intake
    where domain = any(${domains}) and status in ('queued', 'duplicate') and comps is not null order by domain, id desc`.execute(db);
  for (const r of rows.rows) out.set(r.domain, Number(r.n));
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
