// v5.64.0 (CR-083): the card evidence cache. Buyer and Risk Gate POST the result of their own USPTO / firm-screen checks once; both read it back with a
// `fresh` flag. The service looks nothing up (no USPTO, TSDR or firm-page client), never judges, and never touches prices, listings, bids, buys, exports or the
// ledger. Append-only in the database (`reject_mutation`); a correction is a new row with `supersedes`. Rules and test ids: docs/internal/card-evidence.md.
import { sql, type Kysely } from 'kysely';
import { ISO_WITH_OFFSET, isRealDate } from '../../core/dates.js';
import { chunks } from '../../core/chunks.js';
import type { Database } from '../../db/types.js';
import { bulkLoad, domainOf, ENGINE_MAX_REJECTS, isObj, rawDomain, textOf, type Parsed, type Reject } from '../engine/index.js';

/** A `uspto_check` is fresh for 24 hours from `checked_at` (JOINT-OPS section 9 Q2). A constant for v1 (CR-083 Q2). */
export const USPTO_TTL_HOURS = 24;
/** Kinds the cache accepts. Extensible: add a value here and to the table's CHECK in a migration. */
export const CARD_EVIDENCE_KINDS = ['uspto_check', 'firm_screen', 'other'] as const;
export const CARD_EVIDENCE_VERDICTS = ['kill', 'clear', 'flag', 'error', 'unknown'] as const;
export type CardEvidenceKind = (typeof CARD_EVIDENCE_KINDS)[number];
type Verdict = (typeof CARD_EVIDENCE_VERDICTS)[number];
export const CARD_EVIDENCE_RAW_MAX_BYTES = 8 * 1024;
const HOUR = 3_600_000;
/** `checked_at` may be this far ahead of the server clock (clock skew between a bot and the server). */
const FUTURE_SKEW_MS = 60_000;
const CHUNK = 500;

interface Row {
  domain: string | null; term: string | null; kind: CardEvidenceKind; verdict: Verdict; checked_at: Date;
  note: string | null; evidence_ref: string | null; raw: string | null; supersedes: number | null;
}
export interface CardEvidenceLoadResult {
  table: 'card_evidence'; dry_run: boolean; received_n: number; accepted_n: number; duplicate_n: number; rejected_n: number;
  rejects: Reject[]; ids: { row: number; id: number }[];
}
interface Ctx { by: string; auditId: string | null; now: number; dryRun: boolean }

function optText(v: unknown, max: number): { v: string | null } | null {
  if (v === undefined || v === null || v === '') return { v: null };
  const t = textOf(v, max);
  return t === null ? null : { v: t };
}

function parseRow(raw: unknown, now: number): Parsed<Row> {
  if (!isObj(raw)) return { ok: false, domain: null, reason: 'ROW_INVALID' };
  const shown = rawDomain(raw) ?? (typeof raw.term === 'string' ? raw.term.slice(0, 200) : null);
  const fail = (reason: string, d: string | null = shown): Parsed<Row> => ({ ok: false, domain: d, reason });
  let domain: string | null = null;
  if (raw.domain !== undefined && raw.domain !== null && raw.domain !== '') {
    const d = domainOf(raw);
    if ('reason' in d) return fail(d.reason);
    domain = d.domain;
  }
  let term: string | null = null;
  if (raw.term !== undefined && raw.term !== null && raw.term !== '') {
    const t = textOf(raw.term, 200);
    if (t === null) return fail('TERM_INVALID');
    if (t.includes('@')) return fail('TERM_PII');
    term = t.toLowerCase();
  }
  if (domain === null && term === null) return fail('SUBJECT_REQUIRED');
  const subject = domain ?? term;
  if (typeof raw.kind !== 'string' || !(CARD_EVIDENCE_KINDS as readonly string[]).includes(raw.kind)) return fail('KIND_INVALID', subject);
  if (typeof raw.verdict !== 'string' || !(CARD_EVIDENCE_VERDICTS as readonly string[]).includes(raw.verdict)) return fail('VERDICT_INVALID', subject);
  const at = raw.checked_at;
  if (typeof at !== 'string' || !ISO_WITH_OFFSET.test(at) || !isRealDate(at.slice(0, 10)) || Number.isNaN(Date.parse(at))) return fail('CHECKED_AT_INVALID', subject);
  const checked = new Date(at);
  if (checked.getTime() > now + FUTURE_SKEW_MS) return fail('CHECKED_AT_IN_FUTURE', subject);
  const note = optText(raw.note, 500); if (note === null) return fail('NOTE_INVALID', subject);
  if (note.v?.includes('@')) return fail('NOTE_PII', subject);
  const ref = optText(raw.evidence_ref, 500); if (ref === null) return fail('EVIDENCE_REF_INVALID', subject);
  if (ref.v?.includes('@')) return fail('EVIDENCE_REF_PII', subject);
  let rawJson: string | null = null;
  if (raw.raw !== undefined && raw.raw !== null) {
    if (!isObj(raw.raw)) return fail('RAW_INVALID', subject);
    rawJson = JSON.stringify(raw.raw);
    if (Buffer.byteLength(rawJson, 'utf8') > CARD_EVIDENCE_RAW_MAX_BYTES) return fail('RAW_TOO_LARGE', subject);
    if (rawJson.includes('@')) return fail('RAW_PII', subject);
  }
  let sup: number | null = null;
  if (raw.supersedes !== undefined && raw.supersedes !== null) {
    if (typeof raw.supersedes !== 'number' || !Number.isSafeInteger(raw.supersedes) || raw.supersedes < 1) return fail('SUPERSEDES_INVALID', subject);
    sup = raw.supersedes;
  }
  return { ok: true, value: { domain, term, kind: raw.kind as CardEvidenceKind, verdict: raw.verdict as Verdict, checked_at: checked, note: note.v, evidence_ref: ref.v, raw: rawJson, supersedes: sup } };
}

const dupKey = (r: Row): string => JSON.stringify([r.domain, r.term, r.kind, r.verdict, r.checked_at.getTime(), r.note, r.evidence_ref, r.supersedes]);

/** One transaction. Duplicate = same domain, term, kind, verdict, checked_at, note, evidence_ref and supersedes (raw is not compared). */
export function loadCardEvidence(db: Kysely<Database>, rows: unknown[], ctx: Ctx): Promise<CardEvidenceLoadResult> {
  return bulkLoad(db, rows, {
    parse: (raw) => parseRow(raw, ctx.now),
    apply: async (trx, valid, rejects) => {
      const supIds = [...new Set(valid.map((x) => x.v.supersedes).filter((x): x is number => x !== null))];
      const known = new Set<number>();
      if (supIds.length > 0) for (const r of await trx.selectFrom('card_evidence').select('id').where('id', 'in', supIds).execute()) known.add(r.id);
      const seen = new Set<string>();
      const domains = [...new Set(valid.map((x) => x.v.domain).filter((x): x is string => x !== null))];
      const terms = [...new Set(valid.map((x) => x.v.term).filter((x): x is string => x !== null))];
      for (const part of chunks(domains, 5_000)) {
        for (const f of await trx.selectFrom('card_evidence').select(['domain', 'term', 'kind', 'verdict', 'checked_at', 'note', 'evidence_ref', 'supersedes']).where('domain', 'in', part).execute()) seen.add(dupKey(f as Row));
      }
      for (const part of chunks(terms, 5_000)) {
        for (const f of await trx.selectFrom('card_evidence').select(['domain', 'term', 'kind', 'verdict', 'checked_at', 'note', 'evidence_ref', 'supersedes']).where('term', 'in', part).execute()) seen.add(dupKey(f as Row));
      }
      const accepted: { i: number; v: Row }[] = [];
      let dup = 0;
      for (const { i, v } of valid) {
        if (v.supersedes !== null && !known.has(v.supersedes)) { rejects.push({ row: i, domain: v.domain ?? v.term, reason: 'SUPERSEDES_NOT_FOUND' }); continue; }
        const k = dupKey(v);
        if (seen.has(k)) dup += 1; else { seen.add(k); accepted.push({ i, v }); }
      }
      const ids: { row: number; id: number }[] = [];
      if (!ctx.dryRun) {
        const at = new Date(ctx.now);
        for (const part of chunks(accepted, CHUNK)) {
          const got = await trx.insertInto('card_evidence').values(part.map(({ v }) => ({ ...v, by: ctx.by, audit_id: ctx.auditId, created_at: at }))).returning('id').execute();
          got.forEach((g, n) => ids.push({ row: part[n]!.i, id: g.id }));
        }
      }
      return { accepted: accepted.length, dup, ids };
    },
  }).then(({ result, rejects }) => ({
    table: 'card_evidence' as const, dry_run: ctx.dryRun, received_n: rows.length, accepted_n: result.accepted, duplicate_n: result.dup, rejected_n: rejects.length,
    rejects: rejects.slice(0, ENGINE_MAX_REJECTS), ids: result.ids,
  }));
}

// ---- reads ---------------------------------------------------------------------------------------------------------------------------------
export interface CardEvidenceQuery { domain?: string; term?: string; kind?: CardEvidenceKind; freshOnly: boolean; limit: number; offset: number; now: number }
export type StaleReason = 'superseded' | 'expired' | 'tm_kills_changed';

interface DbRow {
  id: string | number; domain: string | null; term: string | null; kind: CardEvidenceKind; verdict: Verdict; checked_at: Date; note: string | null;
  evidence_ref: string | null; raw: unknown; supersedes: string | number | null; by: string; created_at: Date; superseded_by: string | number | null;
}

/**
 * Freshness of a row (CR-083 R-3). Only `uspto_check` has a clock: fresh = not superseded, within USPTO_TTL_HOURS of `checked_at`, and no `/data/tm-kills` row
 * added after `checked_at`. The kill-list rule is an approximation (CR-083 Q3): ANY new tm_kills row counts, not only one that matches this row's subject.
 * Other kinds: `fresh` is null (no TTL), `stale_reason` is `superseded` for a replaced row, else null.
 */
export function freshness(kind: CardEvidenceKind, checkedAt: Date, superseded: boolean, now: number, tmKillsMax: Date | null): { fresh: boolean | null; stale_reason: StaleReason | null } {
  if (superseded) return { fresh: kind === 'uspto_check' ? false : null, stale_reason: 'superseded' };
  if (kind !== 'uspto_check') return { fresh: null, stale_reason: null };
  if (now - checkedAt.getTime() > USPTO_TTL_HOURS * HOUR) return { fresh: false, stale_reason: 'expired' };
  if (tmKillsMax !== null && tmKillsMax.getTime() > checkedAt.getTime()) return { fresh: false, stale_reason: 'tm_kills_changed' };
  return { fresh: true, stale_reason: null };
}

const present = (r: DbRow, now: number, tmMax: Date | null) => ({
  id: Number(r.id), domain: r.domain, term: r.term, kind: r.kind, verdict: r.verdict, checked_at: r.checked_at.toISOString(), note: r.note, evidence_ref: r.evidence_ref, raw: r.raw,
  ...freshness(r.kind, r.checked_at, r.superseded_by !== null, now, tmMax),
  supersedes: r.supersedes === null ? null : Number(r.supersedes), superseded_by: r.superseded_by === null ? null : Number(r.superseded_by), by: r.by, created_at: r.created_at.toISOString(),
});
export type CardEvidenceView = ReturnType<typeof present>;

const SELECT = sql`select c.id, c.domain, c.term, c.kind, c.verdict, c.checked_at, c.note, c.evidence_ref, c.raw, c.supersedes, c.by, c.created_at,
  (select max(s.id) from card_evidence s where s.supersedes = c.id) as superseded_by from card_evidence c`;

const tmKillsMax = async (db: Kysely<Database>): Promise<Date | null> =>
  (await db.selectFrom('tm_kills').select((eb) => eb.fn.max('created_at').as('m')).executeTakeFirst())?.m ?? null;

export async function readCardEvidence(db: Kysely<Database>, q: CardEvidenceQuery): Promise<{ ttl_hours: number; total: number; count: number; limit: number; offset: number; rows: CardEvidenceView[] }> {
  const tmMax = await tmKillsMax(db);
  const where = [sql`true`];
  if (q.domain) where.push(sql`c.domain = ${q.domain}`);
  if (q.term) where.push(sql`c.term = ${q.term}`);
  if (q.kind) where.push(sql`c.kind = ${q.kind}`);
  if (q.freshOnly) {
    where.push(sql`not exists (select 1 from card_evidence s where s.supersedes = c.id)`);
    where.push(sql`(c.kind <> 'uspto_check' or (c.checked_at >= ${new Date(q.now - USPTO_TTL_HOURS * HOUR)}${tmMax === null ? sql`` : sql` and c.checked_at >= ${tmMax}`}))`);
  }
  const cond = sql.join(where, sql` and `);
  const total = Number((await sql<{ n: string }>`select count(*)::text as n from card_evidence c where ${cond}`.execute(db)).rows[0]!.n);
  const got = await sql<DbRow>`${SELECT} where ${cond} order by c.id desc limit ${q.limit} offset ${q.offset}`.execute(db);
  const rows = got.rows.map((r) => present(r, q.now, tmMax));
  return { ttl_hours: USPTO_TTL_HOURS, total, count: rows.length, limit: q.limit, offset: q.offset, rows };
}

export async function getCardEvidence(db: Kysely<Database>, id: number, now: number): Promise<CardEvidenceView | null> {
  const got = await sql<DbRow>`${SELECT} where c.id = ${id}`.execute(db);
  return got.rows[0] ? present(got.rows[0], now, await tmKillsMax(db)) : null;
}
