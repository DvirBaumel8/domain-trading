// v6.4.0 (CR-101): auction_kills, the server-side store of auction names a bot already judged. POST /auctions/kills (WRITE or bots, { rows }, Idempotency-Key)
// and GET /auctions/kills (READ, bots, WRITE; a data token gets 403). Append-only in the database (`reject_mutation`); a wrong kill is undone by a row with
// kill_stage 'revoked' and `supersedes` = the id of that kill. GET /auctions/shortlist reads the table through one anti-join (shortlist.ts). Rules: docs/internal/auctions.md "Kills".
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { chunks } from '../../../core/chunks.js';
import { idtDay, ISO_WITH_OFFSET, isRealDate, toJerusalemIso } from '../../../core/dates.js';
import { piiError } from '../../../core/validation.js';
import type { Database } from '../../../db/types.js';
import { bulkLoad, dateOf, domainOf, ENGINE_MAX_REJECTS, isObj, rawDomain, textOf, type Parsed, type Reject } from '../../engine/index.js';

export const KILLS_MAX_ROWS = 2000;
/** Stages a bot may post; `revoked` is the undo row. */
export const KILL_STAGES = ['meaning_shape', 'tier_a', 'tier_b', 'card', 'prior_exclude', 'declined', 'hold', 'other', 'revoked'] as const;
export type KillStage = (typeof KILL_STAGES)[number];
/** Stages whose reason can change with the price: only these re-show a name when its price halves. */
export const PRICE_RESHOW_STAGES: readonly KillStage[] = ['tier_a', 'tier_b', 'card'];
/** `killed_at` may be this far ahead of the server clock (clock skew between a bot and the server). */
const FUTURE_SKEW_MS = 60_000;
const CHUNK = 500;

interface Row {
  domain: string; kill_stage: KillStage; kill_detail: string | null; price_cents_at_kill: number | null; data_date_at_kill: string; run_id: string; killed_at: Date; supersedes: number | null;
}
export interface KillsLoadResult {
  table: 'auction_kills'; received_n: number; accepted_n: number; duplicate_n: number; rejected_n: number; rejects: Reject[]; ids: { row: number; id: number }[];
}
interface Ctx { by: string; auditId: string | null; now: number }

/** Free text carries no '@' (the rule of /offers): the whole request is refused, not just the row, so a bot never stores an address by accident. */
function assertNoPii(rows: unknown[]): void {
  rows.forEach((raw, i) => {
    if (isObj(raw) && typeof raw.kill_detail === 'string' && raw.kill_detail.includes('@')) throw piiError("kill_detail must not contain an email address or '@'", { row: i, field: 'kill_detail' });
  });
}

function parseRow(raw: unknown, now: number): Parsed<Row> {
  if (!isObj(raw)) return { ok: false, domain: null, reason: 'ROW_INVALID' };
  const shown = rawDomain(raw);
  const fail = (reason: string): Parsed<Row> => ({ ok: false, domain: shown, reason });
  const d = domainOf(raw);
  if ('reason' in d) return fail(d.reason);
  if (typeof raw.kill_stage !== 'string' || !(KILL_STAGES as readonly string[]).includes(raw.kill_stage)) return fail('KILL_STAGE_INVALID');
  const stage = raw.kill_stage as KillStage;
  const day = dateOf(raw.data_date_at_kill, idtDay(now));
  if ('reason' in day) return fail(day.reason);
  const run = textOf(raw.run_id, 80); if (run === null) return fail('RUN_ID_INVALID');
  const at = raw.killed_at;
  if (typeof at !== 'string' || !ISO_WITH_OFFSET.test(at) || !isRealDate(at.slice(0, 10)) || Number.isNaN(Date.parse(at))) return fail('KILLED_AT_INVALID');
  const killed = new Date(at);
  if (killed.getTime() > now + FUTURE_SKEW_MS) return fail('KILLED_AT_IN_FUTURE');
  let detail: string | null = null;
  if (raw.kill_detail !== undefined && raw.kill_detail !== null && raw.kill_detail !== '') {
    detail = textOf(raw.kill_detail, 500);
    if (detail === null) return fail('KILL_DETAIL_INVALID');
  }
  let price: number | null = null;
  if (raw.price_cents_at_kill !== undefined && raw.price_cents_at_kill !== null) {
    const p = raw.price_cents_at_kill;
    if (typeof p !== 'number' || !Number.isSafeInteger(p) || p < 1 || p > 100_000_000) return fail('PRICE_INVALID');
    price = p;
  }
  let sup: number | null = null;
  if (raw.supersedes !== undefined && raw.supersedes !== null) {
    if (typeof raw.supersedes !== 'number' || !Number.isSafeInteger(raw.supersedes) || raw.supersedes < 1) return fail('SUPERSEDES_INVALID');
    sup = raw.supersedes;
  }
  if (stage === 'revoked' && sup === null) return fail('SUPERSEDES_REQUIRED');
  if (stage !== 'revoked' && sup !== null) return fail('SUPERSEDES_ONLY_FOR_REVOKED');
  return { ok: true, value: { domain: d.domain, kill_stage: stage, kill_detail: detail, price_cents_at_kill: price, data_date_at_kill: day.date, run_id: run, killed_at: killed, supersedes: sup } };
}

const dupKey = (r: { domain: string; kill_stage: string; data_date_at_kill: string; supersedes: number | null }): string => `${r.domain}|${r.kill_stage}|${r.data_date_at_kill}|${r.supersedes ?? 0}`;

/** One transaction under the engine_upload lock. Duplicate = same domain, kill_stage and data_date_at_kill (a revoke row also compares what it revokes): counted, not stored. */
export function loadKills(db: Kysely<Database>, rows: unknown[], ctx: Ctx): Promise<KillsLoadResult> {
  assertNoPii(rows);
  return bulkLoad(db, rows, {
    parse: (raw) => parseRow(raw, ctx.now),
    apply: async (trx, valid, rejects) => {
      const supIds = [...new Set(valid.map((x) => x.v.supersedes).filter((x): x is number => x !== null))];
      const target = new Map<number, { domain: string; kill_stage: string }>();
      for (const part of chunks(supIds, 5_000)) for (const r of await trx.selectFrom('auction_kills').select(['id', 'domain', 'kill_stage']).where('id', 'in', part).execute()) target.set(Number(r.id), r);
      const seen = new Set<string>();
      const domains = [...new Set(valid.map((x) => x.v.domain))];
      for (const part of chunks(domains, 5_000)) {
        for (const f of await trx.selectFrom('auction_kills').select(['domain', 'kill_stage', 'data_date_at_kill', 'supersedes']).where('domain', 'in', part).execute()) {
          seen.add(dupKey({ ...f, data_date_at_kill: String(f.data_date_at_kill).slice(0, 10), supersedes: f.supersedes === null ? null : Number(f.supersedes) }));
        }
      }
      const accepted: { i: number; v: Row }[] = [];
      let dup = 0;
      for (const { i, v } of valid) {
        if (v.supersedes !== null) {
          const t = target.get(v.supersedes);
          if (!t) { rejects.push({ row: i, domain: v.domain, reason: 'SUPERSEDES_NOT_FOUND' }); continue; }
          if (t.kill_stage === 'revoked') { rejects.push({ row: i, domain: v.domain, reason: 'SUPERSEDES_NOT_A_KILL' }); continue; }
          if (t.domain !== v.domain) { rejects.push({ row: i, domain: v.domain, reason: 'SUPERSEDES_DOMAIN_MISMATCH' }); continue; }
        }
        const k = dupKey(v);
        if (seen.has(k)) dup += 1; else { seen.add(k); accepted.push({ i, v }); }
      }
      const ids: { row: number; id: number }[] = [];
      const at = new Date(ctx.now);
      for (const part of chunks(accepted, CHUNK)) {
        const got = await trx.insertInto('auction_kills').values(part.map(({ v }) => ({ ...v, by: ctx.by, audit_id: ctx.auditId, created_at: at }))).returning('id').execute();
        got.forEach((g, n) => ids.push({ row: part[n]!.i, id: Number(g.id) }));
      }
      return { accepted: accepted.length, dup, ids };
    },
  }).then(({ result, rejects }) => ({
    table: 'auction_kills' as const, received_n: rows.length, accepted_n: result.accepted, duplicate_n: result.dup, rejected_n: rejects.length,
    rejects: rejects.slice(0, ENGINE_MAX_REJECTS), ids: result.ids,
  }));
}

// ---- GET /auctions/kills -------------------------------------------------------------------------------------------------------------------
export const KillsQuery = z.object({
  domain: z.string().min(1).max(253).optional(),
  since: z.union([z.string().refine(isRealDate, 'must be a real date (YYYY-MM-DD)'), z.string().regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/)]).optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
  offset: z.coerce.number().int().min(0).max(10_000_000).default(0),
}).strict();

interface DbRow {
  id: string | number; domain: string; kill_stage: KillStage; kill_detail: string | null; price_cents_at_kill: number | null; data_date_at_kill: string | Date; run_id: string;
  killed_at: Date; supersedes: string | number | null; by: string; created_at: Date; revoked_by: string | number | null;
}

/** Newest first (by killed_at, then id). `revoked_by` is the id of the revoke row that undid a kill, so a bot sees which kills are still active. `since` compares killed_at. */
export async function listKills(db: Kysely<Database>, q: z.infer<typeof KillsQuery>, nowMs: number) {
  const where = [sql`true`];
  if (q.domain) where.push(sql`k.domain = ${q.domain.trim().toLowerCase()}`);
  if (q.since) where.push(sql`k.killed_at >= ${new Date(q.since.length === 10 ? `${q.since}T00:00:00Z` : q.since)}`);
  const cond = sql.join(where, sql` and `);
  const total = Number((await sql<{ n: string }>`select count(*)::text as n from auction_kills k where ${cond}`.execute(db)).rows[0]!.n);
  const got = await sql<DbRow>`select k.id, k.domain, k.kill_stage, k.kill_detail, k.price_cents_at_kill, k.data_date_at_kill::text as data_date_at_kill, k.run_id, k.killed_at, k.supersedes, k.by, k.created_at,
      (select min(r.id) from auction_kills r where r.supersedes = k.id) as revoked_by
    from auction_kills k where ${cond} order by k.killed_at desc, k.id desc limit ${q.limit} offset ${q.offset}`.execute(db);
  return {
    table: 'auction_kills', as_of: toJerusalemIso(new Date(nowMs)), total, count: got.rows.length, limit: q.limit, offset: q.offset,
    rows: got.rows.map((r) => ({
      id: Number(r.id), domain: r.domain, kill_stage: r.kill_stage, kill_detail: r.kill_detail, price_cents_at_kill: r.price_cents_at_kill, data_date_at_kill: String(r.data_date_at_kill).slice(0, 10), run_id: r.run_id,
      killed_at: toJerusalemIso(new Date(r.killed_at)), supersedes: r.supersedes === null ? null : Number(r.supersedes), revoked_by: r.revoked_by === null ? null : Number(r.revoked_by), by: r.by, created_at: toJerusalemIso(new Date(r.created_at)),
    })),
  };
}
