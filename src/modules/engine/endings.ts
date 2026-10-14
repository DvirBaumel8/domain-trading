// Daily step `engineEndings` (v5.4.0, CR-056 part 1): for every name in the uploaded sold and unsold sets, asks the registry (RDAP only, never DNS)
// whether the same name is registered on .net, .co, .org, .io and .ai, and when it was created. The answers go to engine_endings and are kept for good.
// A run works through at most ENDINGS_MAX_PAIRS_PER_RUN (name, ending) pairs inside ENDINGS_TIME_BUDGET_MS, never-asked pairs first, then the oldest answers;
// the next night continues, so the first full fill takes a day or more. Per registry host: 4 in flight, 250 ms between starts (the shared host pacer), slower
// after a refusal. It calls no registrar, marketplace or outside service besides the registries' RDAP servers, and sends nothing.
// It does not go through lookupCached: that would write a screening_evidence row and an rdap_lookups row for each of ~160,000 asks (free-plan size);
// the compact answer in engine_endings is the permanent record.
import { sql, type Kysely } from 'kysely';
import { trySessionLock } from '../../core/locks.js';
import { RDAP_FALLBACK_BASES, type RdapLookup } from '../../core/rdap.js';
import type { Database } from '../../db/types.js';
import { newAuditId } from '../../http/audit.js';
import { hostPacer, rdapBaseFor, type ScreeningDeps } from '../selection/index.js';

export const ENDING_TLDS = ['net', 'co', 'org', 'io', 'ai'] as const;
export type EndingTld = (typeof ENDING_TLDS)[number];
/** About 4,000 names x 5 endings; at 4 requests a second per registry host that is a little under 20 minutes. */
export const ENDINGS_MAX_PAIRS_PER_RUN = 20_000;
export const ENDINGS_TIME_BUDGET_MS = 20 * 60_000;
/** An answer older than this is asked again (and a new row is appended). */
export const ENDINGS_RECHECK_DAYS = 30;
/** An unanswered ask (timeout, error, refusal) is asked again once it is this old, so a run never asks one name twice. */
export const ENDINGS_UNKNOWN_RETRY_HOURS = 6;
const CONCURRENCY = 4;
const LOOKUP_TIMEOUT_MS = 8_000;
const MAX_RETRY_AFTER_MS = 10_000;
const DAY = 86_400_000;

/** The pairs of the uploaded names and the current (newest) row of each; shared by the job's pick and the health counts. */
function pairsCte() {
  return sql`
    names as (select split_part(domain, '.', 1) as name from engine_sales union select split_part(domain, '.', 1) from engine_unsold),
    tlds(tld) as (values ('net'), ('co'), ('org'), ('io'), ('ai')),
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
  /** Rows inserted / unanswered rows updated in place. */
  inserted: number;
  updated: number;
  left_for_next_run: number;
  /** True when the time budget ran out or a registry host stopped answering before every picked pair was asked. */
  partial: boolean;
  by_tld: Record<string, { asked: number; registered: number; not_registered: number; unknown: number }>;
  skipped_tlds: string[];
}

interface Pair { name: string; tld: EndingTld; prevId: number | null; prevRegistered: boolean | null }
interface Answer { registered: boolean | null; createdAt: Date | null; httpStatus: number | null; reason: string | null; evidence: unknown }

const refused = (x: RdapLookup): boolean => x.reasonCode === 'RATE_LIMITED' || x.httpStatus === 429 || x.httpStatus === 403;

export class EndingsJob {
  constructor(private readonly deps: { db: Kysely<Database>; screening: ScreeningDeps; now: () => number; maxPairs?: number; budgetMs?: number; log?: { warn(o: object, m: string): void } }) {}

  /** The RDAP base of an ending: the fixed fallback for .co and .io (IANA's file lacks them), else the IANA bootstrap. null = no registry service known / bootstrap unavailable. */
  private async baseOf(tld: EndingTld): Promise<string | null> {
    const fallback = RDAP_FALLBACK_BASES[tld];
    if (fallback) return fallback;
    try {
      return await rdapBaseFor(this.deps.db, this.deps.screening, tld, { enabled: true, now: this.deps.now });
    } catch (e) {
      this.deps.log?.warn({ tld, errMessage: (e as Error).message }, 'engine endings: RDAP base unavailable');
      return null;
    }
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
      const total = await sql<{ n: string }>`with ${pairsCte()} select count(*)::text as n from pairs where checked_at is null or (registered is null and checked_at < ${cut.unknown}) or checked_at < ${cut.recheck}`.execute(db);
      out.due = Number(total.rows[0]?.n ?? 0);
      const picked = (await sql<{ name: string; tld: EndingTld; id: string | null; registered: boolean | null }>`
        with ${pairsCte()}
        select name, tld, id::text as id, registered from pairs
        where checked_at is null or (registered is null and checked_at < ${cut.unknown}) or checked_at < ${cut.recheck}
        order by checked_at asc nulls first, name, tld limit ${max}`.execute(db)).rows;
      const byTld = new Map<EndingTld, Pair[]>();
      for (const r of picked) (byTld.get(r.tld) ?? byTld.set(r.tld, []).get(r.tld)!).push({ name: r.name, tld: r.tld, prevId: r.id === null ? null : Number(r.id), prevRegistered: r.registered });
      let stopped = false;
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
            await this.save(p, a, out);
          }
        };
        await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      }));
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

  /** One paced RDAP query (one retry after a short 429 Retry-After); a refusal slows the host's pacer down. */
  private async ask(domain: string, base: string, pace: ReturnType<typeof hostPacer>): Promise<Answer> {
    const { screening } = this.deps;
    const call = async (): Promise<RdapLookup> => {
      const x = await pace.run(() => screening.rdapLookup(domain, { baseUrl: base, timeoutMs: LOOKUP_TIMEOUT_MS }));
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

  /** Never asked: insert. An unanswered row: update it in place. An answered row (older than 30 days): append a row for a new answer, keep the old one on an unanswered ask. */
  private async save(p: Pair, a: Answer, out: EndingsSummary): Promise<void> {
    const { db, now } = this.deps;
    const row = { registered: a.registered, created_at_registry: a.createdAt, checked_at: new Date(now()), http_status: a.httpStatus, reason_code: a.reason, evidence: a.evidence == null ? null : JSON.stringify(a.evidence) };
    if (p.prevId !== null && p.prevRegistered === null) {
      await db.updateTable('engine_endings').set(row).where('id', '=', p.prevId).execute();
      out.updated += 1;
    } else if (p.prevId !== null && a.registered === null) {
      // keep the known answer; the pair stays due and is asked again on the next run
    } else {
      await db.insertInto('engine_endings').values({ name: p.name, tld: p.tld, ...row }).execute();
      out.inserted += 1;
    }
  }
}

export interface EndingsHealth {
  names_n: number; pairs_n: number; checked_n: number; unknown_n: number; pending_n: number;
  by_tld: Record<string, { checked_n: number; registered_n: number; unknown_n: number; pending_n: number }>;
}

/** Counts of the endings fill for GET /engine/health. `checked_n` = pairs whose newest row holds an answer; `pending_n` = pairs the next run would ask. */
export async function endingsHealth(db: Kysely<Database>, nowMs: number): Promise<EndingsHealth> {
  const cut = dueCutoffs(nowMs);
  const rows = (await sql<{ tld: string; checked_n: string; registered_n: string; unknown_n: string; pending_n: string }>`
    with ${pairsCte()}
    select tld, count(*) filter (where registered is not null)::text as checked_n, count(*) filter (where registered)::text as registered_n,
      count(*) filter (where checked_at is not null and registered is null)::text as unknown_n,
      count(*) filter (where checked_at is null or (registered is null and checked_at < ${cut.unknown}) or checked_at < ${cut.recheck})::text as pending_n
    from pairs group by tld`.execute(db)).rows;
  const names = await sql<{ n: string }>`with ${pairsCte()} select count(distinct name)::text as n from pairs`.execute(db);
  const by_tld: EndingsHealth['by_tld'] = {};
  for (const t of ENDING_TLDS) by_tld[t] = { checked_n: 0, registered_n: 0, unknown_n: 0, pending_n: 0 };
  const sum = { checked_n: 0, unknown_n: 0, pending_n: 0 };
  for (const r of rows) {
    const v = { checked_n: Number(r.checked_n), registered_n: Number(r.registered_n), unknown_n: Number(r.unknown_n), pending_n: Number(r.pending_n) };
    by_tld[r.tld] = v;
    sum.checked_n += v.checked_n; sum.unknown_n += v.unknown_n; sum.pending_n += v.pending_n;
  }
  const namesN = Number(names.rows[0]?.n ?? 0);
  return { names_n: namesN, pairs_n: namesN * ENDING_TLDS.length, ...sum, by_tld };
}
