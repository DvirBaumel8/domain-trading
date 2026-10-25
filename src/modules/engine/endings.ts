// Daily step `engineEndings` (v5.4.0, CR-056 part 1): for every name in the uploaded sold and unsold sets, asks the registry (RDAP only, never DNS)
// whether the same name is registered on .net, .co, .org, .io and .ai, and when it was created. Since v5.5.0 it also asks .com itself (Verisign), for the
// acquisition feature: the .com's registry creation date. POST /score reuses the same asking code (askRdap, saveAnswer) for names it has no answer for. The answers go to engine_endings and are kept for good.
// A run works through at most ENDINGS_MAX_PAIRS_PER_RUN (name, ending) pairs inside ENDINGS_TIME_BUDGET_MS, never-asked pairs first, then the oldest answers;
// the next night continues, so the first full fill takes a day or more. Per registry host: 4 in flight, 250 ms between starts (the shared host pacer), slower
// after a refusal. It calls no registrar, marketplace or outside service besides the registries' RDAP servers, and sends nothing.
// It does not go through lookupCached: that would write a screening_evidence row and an rdap_lookups row for each of ~160,000 asks (free-plan size);
// the compact answer in engine_endings is the permanent record.
import { sql, type Kysely } from 'kysely';
import { chunks } from '../../core/chunks.js';
import { toJerusalemIso } from '../../core/dates.js';
import { trySessionLock } from '../../core/locks.js';
import { RDAP_FALLBACK_BASES, type RdapLookup } from '../../core/rdap.js';
import type { Database } from '../../db/types.js';
import { newAuditId } from '../../http/audit.js';
import { hostPacer, rdapBaseFor, type ScreeningDeps } from '../selection/index.js';

const ENDING_TLDS = ['net', 'co', 'org', 'io', 'ai'] as const;
/** The five other endings plus the name's own .com (v5.5.0). */
export const ENGINE_TLDS = [...ENDING_TLDS, 'com'] as const;
export type EndingTld = (typeof ENGINE_TLDS)[number];
/** About 3,300 names x 6 endings; at 4 requests a second per registry host (net and com share one) that is a little under 20 minutes. */
const ENDINGS_MAX_PAIRS_PER_RUN = 20_000;
const ENDINGS_TIME_BUDGET_MS = 20 * 60_000;
/** An answer older than this is asked again (and a new row is appended). */
const ENDINGS_RECHECK_DAYS = 30;
/** An unanswered ask (timeout, error, refusal) is asked again once it is this old, so a run never asks one name twice. */
const ENDINGS_UNKNOWN_RETRY_HOURS = 6;
const CONCURRENCY = 4;
const LOOKUP_TIMEOUT_MS = 8_000;
const MAX_RETRY_AFTER_MS = 10_000;
const DAY = 86_400_000;
/** v5.7.0 (CR-058): an owned name's five endings are asked again once the newest answer is this old. */
const OWNED_RECHECK_DAYS = 7;
const OWNED_STATUSES = ['owned', 'listed', 'delisted'] as const;

/** The pairs of the uploaded names and the current (newest) row of each; shared by the job's pick and the health counts. */
function pairsCte() {
  return sql`
    names as (select split_part(domain, '.', 1) as name from engine_sales union select split_part(domain, '.', 1) from engine_unsold),
    tlds(tld) as (values ('net'), ('co'), ('org'), ('io'), ('ai'), ('com')),
    cur as (select distinct on (name, tld) id, name, tld, registered, checked_at from engine_endings order by name, tld, checked_at desc, id desc),
    pairs as (select n.name, t.tld, c.id, c.registered, c.checked_at from names n cross join tlds t left join cur c on c.name = n.name and c.tld = t.tld)`;
}

const dueCutoffs = (nowMs: number) => ({ unknown: new Date(nowMs - ENDINGS_UNKNOWN_RETRY_HOURS * 3_600_000), recheck: new Date(nowMs - ENDINGS_RECHECK_DAYS * DAY) });

export interface EndingsSummary {
  skipped: boolean;
  /** Pairs that were due when the run started. */
  due: number;
  asked: number;
  registered: number;
  not_registered: number;
  unknown: number;
  /** Rows inserted / rows updated in place (an unanswered row, or an answer that did not change). */
  inserted: number;
  updated: number;
  left_for_next_run: number;
  /** True when the time budget ran out or a registry host stopped answering before every picked pair was asked. */
  partial: boolean;
  by_tld: Record<string, { asked: number; registered: number; not_registered: number; unknown: number }>;
  skipped_tlds: string[];
}

export interface Pair { name: string; tld: EndingTld; prevId: number | null; prevRegistered: boolean | null; /** v5.7.0: set for the pairs of an owned name (the owned .com and its buy date). */ owned?: { domain: string; buyDate: string | null } }
export interface Answer { registered: boolean | null; createdAt: Date | null; httpStatus: number | null; reason: string | null; evidence: unknown }

const refused = (x: RdapLookup): boolean => x.reasonCode === 'RATE_LIMITED' || x.httpStatus === 429 || x.httpStatus === 403;

/** The RDAP base of an ending: the fixed fallback for .co and .io (IANA's file lacks them), else the IANA bootstrap (.com: Verisign). null = no registry service known / bootstrap unavailable. */
export async function endingBase(db: Kysely<Database>, screening: ScreeningDeps, now: () => number, tld: EndingTld, log?: { warn(o: object, m: string): void }): Promise<string | null> {
  const fallback = RDAP_FALLBACK_BASES[tld];
  if (fallback) return fallback;
  try {
    return await rdapBaseFor(db, screening, tld, { enabled: true, now });
  } catch (e) {
    log?.warn({ tld, errMessage: (e as Error).message }, 'engine endings: RDAP base unavailable');
    return null;
  }
}

/** One paced RDAP query (one retry after a short 429 Retry-After); a refusal slows the host's pacer down. `timeoutMs` bounds one lookup. */
export async function askRdap(screening: ScreeningDeps, domain: string, base: string, pace: ReturnType<typeof hostPacer>, timeoutMs: number = LOOKUP_TIMEOUT_MS): Promise<Answer> {
  const call = async (): Promise<RdapLookup> => {
    const x = await pace.run(() => screening.rdapLookup(domain, { baseUrl: base, timeoutMs }));
    if (refused(x)) pace.slowDown(); else pace.noteNotRefused();
    return x;
  };
  let x = await call();
  if (x.reasonCode === 'RATE_LIMITED' && x.retryAfterMs != null && x.retryAfterMs <= MAX_RETRY_AFTER_MS && !pace.breakerOpen) {
    await screening.sleep(x.retryAfterMs);
    x = await call();
  }
  const host = new URL(base).host;
  if (x.outcome === 'registered') {
    const f = x.facts;
    const created = f?.created_at ? new Date(f.created_at) : null;
    return {
      registered: true, createdAt: created && !Number.isNaN(created.getTime()) ? created : null, httpStatus: x.httpStatus, reason: null,
      evidence: { host, registrar: f?.registrar ?? null, expires_at: f?.expires_at ?? null, statuses: (f?.statuses ?? []).slice(0, 6) },
    };
  }
  if (x.outcome === 'not_registered') return { registered: false, createdAt: null, httpStatus: x.httpStatus, reason: null, evidence: { host } };
  return { registered: null, createdAt: null, httpStatus: x.httpStatus, reason: x.reasonCode ?? 'SOURCE_ERROR', evidence: null };
}

/**
 * Never asked: insert. An unanswered row: update it in place. An answered row: when the new answer says the same (same registered, same registry creation date)
 * the row is updated in place (checked_at, http status, evidence, registrar; v5.14.0, D4), so a 30-day re-ask of a stable name does not grow the table; a changed
 * answer appends a row; an unanswered ask keeps the known row. Returns what was done.
 */
export async function saveAnswer(db: Kysely<Database>, nowMs: number, p: Pair, a: Answer): Promise<'inserted' | 'updated' | 'kept'> {
  const registrar = (a.evidence as { registrar?: string | null } | null)?.registrar ?? null;
  const row = { registered: a.registered, created_at_registry: a.createdAt, checked_at: new Date(nowMs), http_status: a.httpStatus, reason_code: a.reason, evidence: a.evidence == null ? null : JSON.stringify(a.evidence), registrar };
  if (p.prevId !== null && p.prevRegistered === null) {
    await db.updateTable('engine_endings').set(row).where('id', '=', p.prevId).execute();
    return 'updated';
  }
  if (p.prevId !== null && a.registered === null) return 'kept'; // keep the known answer; the pair stays due and is asked again on the next run
  if (p.prevId !== null) {
    const same = await sql`update engine_endings set checked_at = ${row.checked_at}, http_status = ${row.http_status}, reason_code = ${row.reason_code}, evidence = ${row.evidence}::jsonb, registrar = ${row.registrar}
      where id = ${p.prevId} and registered is not distinct from ${row.registered} and created_at_registry is not distinct from ${row.created_at_registry} and checked_at <= ${row.checked_at}`.execute(db);
    if (Number(same.numAffectedRows ?? 0) > 0) return 'updated';
  }
  await db.insertInto('engine_endings').values({ name: p.name, tld: p.tld, ...row }).execute();
  return 'inserted';
}

/** v5.42.0 (G-124): how many answers wait in memory before one batch of statements writes them. */
export const ENDINGS_FLUSH_EVERY = 500;

/**
 * Buffers answers and writes them in batches with the same keep / update / append rule as `saveAnswer` (v5.14.0): an unanswered row is updated in place;
 * an unanswered ask keeps the known row (no write); an answer that says the same (registered, registry creation date, and not older) updates the row in place
 * (guarded by `is not distinct from`, so a changed answer never overwrites); a changed answer or a never-asked pair appends a row. One `update ... from unnest` for each
 * kind of update and one multi-row insert per batch instead of one to three statements per pair.
 */
export class EndingsWriter {
  private buf: Array<{ p: Pair; row: ReturnType<typeof rowOf> }> = [];
  inserted = 0;
  updated = 0;
  constructor(private readonly db: Kysely<Database>, private readonly everyN: number = ENDINGS_FLUSH_EVERY) {}

  async add(nowMs: number, p: Pair, a: Answer): Promise<void> {
    if (p.prevId !== null && p.prevRegistered !== null && a.registered === null) return; // keep the known answer; the pair stays due and is asked again on the next run
    this.buf.push({ p, row: rowOf(nowMs, a) });
    if (this.buf.length >= this.everyN) await this.flush();
  }

  async flush(): Promise<void> {
    const items = this.buf;
    this.buf = [];
    if (items.length === 0) return;
    const db = this.db;
    const unanswered = items.filter((x) => x.p.prevId !== null && x.p.prevRegistered === null);
    const answered = items.filter((x) => x.p.prevId !== null && x.p.prevRegistered !== null);
    const appends = items.filter((x) => x.p.prevId === null);
    const cols = (xs: typeof items) => ({
      id: xs.map((x) => x.p.prevId), registered: xs.map((x) => x.row.registered), created: xs.map((x) => x.row.created_at_registry), checked: xs.map((x) => x.row.checked_at),
      http: xs.map((x) => x.row.http_status), reason: xs.map((x) => x.row.reason_code), evidence: xs.map((x) => x.row.evidence), registrar: xs.map((x) => x.row.registrar),
    });
    if (unanswered.length > 0) {
      const c = cols(unanswered);
      const r = await sql`update engine_endings e set registered = u.registered, created_at_registry = u.created, checked_at = u.checked, http_status = u.http, reason_code = u.reason, evidence = u.evidence::jsonb, registrar = u.registrar
        from unnest(${c.id}::bigint[], ${c.registered}::bool[], ${c.created}::timestamptz[], ${c.checked}::timestamptz[], ${c.http}::int[], ${c.reason}::text[], ${c.evidence}::text[], ${c.registrar}::text[])
          as u(id, registered, created, checked, http, reason, evidence, registrar)
        where e.id = u.id`.execute(db);
      this.updated += Number(r.numAffectedRows ?? 0);
    }
    let toInsert = appends;
    if (answered.length > 0) {
      const c = cols(answered);
      const done = await sql<{ id: string }>`update engine_endings e set checked_at = u.checked, http_status = u.http, reason_code = u.reason, evidence = u.evidence::jsonb, registrar = u.registrar
        from unnest(${c.id}::bigint[], ${c.registered}::bool[], ${c.created}::timestamptz[], ${c.checked}::timestamptz[], ${c.http}::int[], ${c.reason}::text[], ${c.evidence}::text[], ${c.registrar}::text[])
          as u(id, registered, created, checked, http, reason, evidence, registrar)
        where e.id = u.id and e.registered is not distinct from u.registered and e.created_at_registry is not distinct from u.created and e.checked_at <= u.checked
        returning e.id::text as id`.execute(db);
      const same = new Set(done.rows.map((r) => Number(r.id)));
      this.updated += same.size;
      toInsert = [...answered.filter((x) => !same.has(x.p.prevId!)), ...appends];
    }
    for (const part of chunks(toInsert, 500)) {
      await db.insertInto('engine_endings').values(part.map((x) => ({ name: x.p.name, tld: x.p.tld, ...x.row }))).execute();
      this.inserted += part.length;
    }
  }
}

function rowOf(nowMs: number, a: Answer) {
  const registrar = (a.evidence as { registrar?: string | null } | null)?.registrar ?? null;
  return { registered: a.registered, created_at_registry: a.createdAt, checked_at: new Date(nowMs), http_status: a.httpStatus, reason_code: a.reason, evidence: a.evidence == null ? null : JSON.stringify(a.evidence), registrar };
}

export class EndingsJob {
  constructor(private readonly deps: { db: Kysely<Database>; screening: ScreeningDeps; now: () => number; maxPairs?: number; budgetMs?: number; log?: { warn(o: object, m: string): void } }) {}

  private baseOf(tld: EndingTld): Promise<string | null> {
    return endingBase(this.deps.db, this.deps.screening, this.deps.now, tld, this.deps.log);
  }

  async runOnce(): Promise<EndingsSummary> {
    const { db, screening, now } = this.deps;
    const out: EndingsSummary = { skipped: false, due: 0, asked: 0, registered: 0, not_registered: 0, unknown: 0, inserted: 0, updated: 0, left_for_next_run: 0, partial: false, by_tld: {}, skipped_tlds: [] };
    const lock = await trySessionLock(db, 'job:engine-endings');
    if (!lock) return { ...out, skipped: true };
    try {
      const start = now();
      const deadline = start + (this.deps.budgetMs ?? ENDINGS_TIME_BUDGET_MS);
      const cut = dueCutoffs(start);
      const max = this.deps.maxPairs ?? ENDINGS_MAX_PAIRS_PER_RUN;
      // v5.7.0 (CR-058): the owned names' pairs come first, weekly; the bulk pairs below leave them out.
      const ownedPairs = (await this.ownedDue(start)).slice(0, max);
      const allOwned = (await sql<{ name: string }>`select split_part(domain, '.', 1) as name from domains where status in (${sql.join(OWNED_STATUSES)}) and domain like '%.com'`.execute(db)).rows.map((r) => r.name);
      // one statement: the pairs CTE is built once; the count of due pairs is a window over the rows before the limit
      const room = Math.max(0, max - ownedPairs.length);
      const picked = (await sql<{ name: string; tld: EndingTld; id: string | null; registered: boolean | null; due: string }>`
        with ${pairsCte()}
        select name, tld, id::text as id, registered, count(*) over ()::text as due from pairs
        where (checked_at is null or (registered is null and checked_at < ${cut.unknown}) or checked_at < ${cut.recheck}) and not (tld <> 'com' and name = any(${allOwned}))
        order by checked_at asc nulls first, name, tld limit ${room}`.execute(db)).rows;
      let bulkDue = picked.length > 0 ? Number(picked[0]!.due) : 0;
      if (picked.length === 0 && room === 0) {
        bulkDue = Number((await sql<{ n: string }>`with ${pairsCte()} select count(*)::text as n from pairs where (checked_at is null or (registered is null and checked_at < ${cut.unknown}) or checked_at < ${cut.recheck}) and not (tld <> 'com' and name = any(${allOwned}))`.execute(db)).rows[0]?.n ?? 0);
      }
      out.due = bulkDue + ownedPairs.length;
      const byTld = new Map<EndingTld, Pair[]>();
      for (const p of ownedPairs) (byTld.get(p.tld) ?? byTld.set(p.tld, []).get(p.tld)!).push(p);
      for (const r of picked) (byTld.get(r.tld) ?? byTld.set(r.tld, []).get(r.tld)!).push({ name: r.name, tld: r.tld, prevId: r.id === null ? null : Number(r.id), prevRegistered: r.registered });
      let stopped = false;
      const writer = new EndingsWriter(db);
      try {
      await Promise.all([...byTld.entries()].map(async ([tld, pairs]) => {
        const base = await this.baseOf(tld);
        if (!base) { out.skipped_tlds.push(tld); return; }
        const pace = hostPacer(new URL(base).host, screening.sleep);
        const stats = (out.by_tld[tld] = { asked: 0, registered: 0, not_registered: 0, unknown: 0 });
        let next = 0;
        const worker = async () => {
          for (;;) {
            if (now() > deadline || pace.breakerOpen) { stopped = true; return; }
            const p = pairs[next++];
            if (!p) return;
            const a = await this.ask(`${p.name}.${tld}`, base, pace);
            stats.asked += 1; out.asked += 1;
            if (a.registered === true) { stats.registered += 1; out.registered += 1; } else if (a.registered === false) { stats.not_registered += 1; out.not_registered += 1; } else { stats.unknown += 1; out.unknown += 1; }
            if (p.owned) {
              await this.save(p, a, out); // the owned event reads the row just written, so owned pairs are written one by one (a few hundred a week at most)
              await recordOwnedEvent(db, now(), p, a);
            } else await writer.add(now(), p, a);
          }
        };
        await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      }));
      } finally {
        await writer.flush();
        out.inserted += writer.inserted; out.updated += writer.updated;
      }
      out.left_for_next_run = Math.max(0, out.due - out.asked);
      out.partial = stopped || out.skipped_tlds.length > 0;
      if (out.asked > 0) await db.insertInto('audit_log').values({
        id: newAuditId(), at: new Date(now()), scope: 'job', method: 'JOB', path: 'engine-endings', request: JSON.stringify({}), status_code: 200,
        result_summary: `asked ${out.asked}; registered ${out.registered}; not registered ${out.not_registered}; unknown ${out.unknown}; left ${out.left_for_next_run}`,
      }).execute();
      return out;
    } finally {
      await lock.release();
    }
  }

  /** The five endings of every owned name that are due: never asked, asked over 7 days ago, or unanswered for 6 hours. */
  private async ownedDue(nowMs: number): Promise<Pair[]> {
    const weekAgo = new Date(nowMs - OWNED_RECHECK_DAYS * DAY);
    const unknownCut = new Date(nowMs - ENDINGS_UNKNOWN_RETRY_HOURS * 3_600_000);
    const rows = (await sql<{ domain: string; name: string; tld: EndingTld; buy_date: string | null; id: string | null; registered: boolean | null }>`
      with own as (select domain, split_part(domain, '.', 1) as name, to_char(buy_date, 'YYYY-MM-DD') as buy_date from domains where status in (${sql.join(OWNED_STATUSES)}) and domain like '%.com'),
      tlds(tld) as (values ('net'), ('co'), ('org'), ('io'), ('ai')),
      cur as (select distinct on (name, tld) id, name, tld, registered, checked_at from engine_endings order by name, tld, checked_at desc, id desc)
      select o.domain, o.name, t.tld, o.buy_date, c.id::text as id, c.registered
      from own o cross join tlds t left join cur c on c.name = o.name and c.tld = t.tld
      where c.checked_at is null or c.checked_at < ${weekAgo} or (c.registered is null and c.checked_at < ${unknownCut})
      order by c.checked_at asc nulls first, o.name, t.tld`.execute(this.deps.db)).rows;
    return rows.map((r) => ({ name: r.name, tld: r.tld, prevId: r.id === null ? null : Number(r.id), prevRegistered: r.registered, owned: { domain: r.domain, buyDate: r.buy_date } }));
  }

  private ask(domain: string, base: string, pace: ReturnType<typeof hostPacer>): Promise<Answer> {
    return askRdap(this.deps.screening, domain, base, pace);
  }

  private async save(p: Pair, a: Answer, out: EndingsSummary): Promise<void> {
    const r = await saveAnswer(this.deps.db, this.deps.now(), p, a);
    if (r === 'inserted') out.inserted += 1; else if (r === 'updated') out.updated += 1;
  }
}

/**
 * v5.7.0 (CR-058): after an owned pair's answer, appends at most one event to owned_ending_events. The first answer after the buy is the baseline, or
 * `newly_registered` when the ending was created after the buy date; later, an unregistered ending that is now registered is `newly_registered` and a
 * changed registry creation date is `re_registered`. An unknown answer writes nothing, and an event is only written when the state differs from the newest event.
 */
async function recordOwnedEvent(db: Kysely<Database>, nowMs: number, p: Pair, a: Answer): Promise<'baseline' | 'newly_registered' | 're_registered' | null> {
  if (!p.owned || a.registered === null) return null;
  const prev = await db.selectFrom('owned_ending_events').select(['registered', 'created_at_registry']).where('domain', '=', p.owned.domain).where('tld', '=', p.tld as 'net').orderBy('id', 'desc').limit(1).executeTakeFirst();
  let kind: 'baseline' | 'newly_registered' | 're_registered' | null = null;
  if (!prev) {
    kind = a.registered && a.createdAt && p.owned.buyDate && a.createdAt.toISOString().slice(0, 10) > p.owned.buyDate ? 'newly_registered' : 'baseline';
  } else if (!prev.registered && a.registered) {
    kind = 'newly_registered';
  } else if (prev.registered && a.registered && prev.created_at_registry && a.createdAt && prev.created_at_registry.getTime() !== a.createdAt.getTime()) {
    kind = 're_registered';
  }
  if (!kind) return null;
  const cur = await db.selectFrom('engine_endings').select(['id', 'registrar']).where('name', '=', p.name).where('tld', '=', p.tld).orderBy('checked_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
  await db.insertInto('owned_ending_events').values({
    domain: p.owned.domain, tld: p.tld as 'net', kind, registered: a.registered, created_at_registry: a.createdAt, registrar: cur?.registrar ?? null, ending_id: cur?.id ?? null, created_at: new Date(nowMs),
  }).execute();
  return kind;
}

/** GET /owned/:domain/endings (v5.7.0): the current state of the five endings of an owned name plus its event history; null when the name is not owned. */
export async function ownedEndingsView(db: Kysely<Database>, domain: string) {
  const d = await db.selectFrom('domains').select(['domain', 'buy_date']).where('domain', '=', domain).where('status', 'in', [...OWNED_STATUSES]).executeTakeFirst();
  if (!d) return null;
  const name = domain.slice(0, -4);
  const cur = (await sql<{ tld: EndingTld; registered: boolean | null; created_at_registry: Date | null; registrar: string | null; checked_at: Date }>`
    select distinct on (tld) tld, registered, created_at_registry, registrar, checked_at from engine_endings where name = ${name} and tld <> 'com'
    order by tld, (registered is not null) desc, checked_at desc, id desc`.execute(db)).rows;
  const events = await db.selectFrom('owned_ending_events').selectAll().where('domain', '=', domain).orderBy('id').execute();
  const iso = (x: Date | null) => (x ? toJerusalemIso(x) : null);
  return {
    domain, buy_date: d.buy_date,
    endings: ENDING_TLDS.map((tld) => {
      const r = cur.find((c) => c.tld === tld);
      return { tld, host: `${name}.${tld}`, registered: r?.registered ?? null, created: iso(r?.created_at_registry ?? null), registrar: r?.registrar ?? null, checked_at: iso(r?.checked_at ?? null) };
    }),
    events: events.map((e) => ({ id: e.id, tld: e.tld, kind: e.kind, registered: e.registered, created: iso(e.created_at_registry), registrar: e.registrar, at: toJerusalemIso(e.created_at) })),
  };
}

export interface EndingsHealth {
  names_n: number; pairs_n: number; checked_n: number; unknown_n: number; pending_n: number;
  by_tld: Record<string, { checked_n: number; registered_n: number; unknown_n: number; pending_n: number }>;
}

/** Counts of the endings fill for GET /engine/health. `checked_n` = pairs whose newest row holds an answer; `pending_n` = pairs the next run would ask. */
export async function endingsHealth(db: Kysely<Database>, nowMs: number): Promise<EndingsHealth> {
  const cut = dueCutoffs(nowMs);
  // one statement (v5.14.0): the pairs CTE is built once, the name count rides on every row
  const rows = (await sql<{ tld: string; checked_n: string; registered_n: string; unknown_n: string; pending_n: string; names_n: string }>`
    with ${pairsCte()}
    select tld, count(*) filter (where registered is not null)::text as checked_n, count(*) filter (where registered)::text as registered_n,
      count(*) filter (where checked_at is not null and registered is null)::text as unknown_n,
      count(*) filter (where checked_at is null or (registered is null and checked_at < ${cut.unknown}) or checked_at < ${cut.recheck})::text as pending_n,
      (select count(*) from names)::text as names_n
    from pairs group by tld`.execute(db)).rows;
  const by_tld: EndingsHealth['by_tld'] = {};
  for (const t of ENGINE_TLDS) by_tld[t] = { checked_n: 0, registered_n: 0, unknown_n: 0, pending_n: 0 };
  const sum = { checked_n: 0, unknown_n: 0, pending_n: 0 };
  for (const r of rows) {
    const v = { checked_n: Number(r.checked_n), registered_n: Number(r.registered_n), unknown_n: Number(r.unknown_n), pending_n: Number(r.pending_n) };
    by_tld[r.tld] = v;
    sum.checked_n += v.checked_n; sum.unknown_n += v.unknown_n; sum.pending_n += v.pending_n;
  }
  const namesN = Number(rows[0]?.names_n ?? 0);
  return { names_n: namesN, pairs_n: namesN * ENGINE_TLDS.length, ...sum, by_tld };
}
