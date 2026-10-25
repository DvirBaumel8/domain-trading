// v5.34.0 (BUG-052): RDAP tags for names that left a feed early. Called by the datasave step `buildPanel`. Rules: docs/internal/datasave.md "Disappearance tags".
//   1. collect: one `disappearances` row per GoDaddy closeouts name (and per sealed Dynadot closeouts upload name) that is on a stored day, still due to end
//      after the next stored day began, and missing from that next day; and one per market episode labelled DISAPPEARED. Every stored day pair is diffed, so
//      the first run is the backfill (R-5). The baseline registrar (R-3) is an RDAP answer stored before the name left (rdap_cache), else the feed's registrar.
//   2. tag: Verisign .com RDAP (through the shared cache, only answers checked after the name left), at most settings.disappearance_lookups_max_per_run live
//      lookups a run, closeouts first, newest first. `tagOf` is the rule (R-2). bought / deleted are final; an unknown is checked again once a day until
//      7 days after its first check (R-4), then it stays unknown. A 429 stops the run (R-7). Never counts against the bots' lookup limit (CR-074).
//   3. prune rows older than settings.disappearance_keep_days.
import { sql, type Kysely } from 'kysely';
import { addDays, dayNumber } from '../../../core/dates.js';
import { dropStatusOf, rdapLookup as realRdap, type RdapLookup, type RdapLookupFn } from '../../../core/rdap.js';
import { cacheGetMany, cachePut, cacheTtlMs } from '../../../core/rdap-cache.js';
import type { Database } from '../../../db/types.js';

export const TAG_RETRY_DAYS = 7;
export const TAG_PAUSE_MS = 250;

export type TagSource = 'godaddy_closeouts' | 'dynadot_closeouts' | 'market_episode';
export type Tag = 'bought' | 'deleted' | 'unknown';

/** The registrar that holds a closeout name while it is on the feed (both feeds sell their own expired names). A GoDaddy closeout may sit at a GoDaddy-family registrar. */
export const FEED_REGISTRAR: Readonly<Record<'godaddy_closeouts' | 'dynadot_closeouts', { name: string; family: RegExp }>> = {
  godaddy_closeouts: { name: 'GoDaddy', family: /godaddy|wildwestdomains/ },
  dynadot_closeouts: { name: 'Dynadot', family: /dynadot/ },
};

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export interface Baseline { registrar: string | null; source: 'rdap_cache' | 'feed' | null }

/**
 * R-2. `prevDate` is the last day the name was seen. Never guesses `bought`: only a registrar outside the baseline (and an active status) is `bought`.
 * A registration created after the name was last seen means the old one ended: `deleted`.
 */
export function tagOf(r: RdapLookup, base: Baseline, source: TagSource, prevDate: string): { tag: Tag; reason: string } {
  if (r.outcome === 'not_registered') return { tag: 'deleted', reason: 'NOT_REGISTERED' };
  if (r.outcome === 'unknown') return { tag: 'unknown', reason: r.reasonCode ?? 'SOURCE_ERROR' };
  const f = r.facts;
  const drop = dropStatusOf(f?.statuses ?? []);
  if (drop) return { tag: 'deleted', reason: `STATUS:${drop}` };
  if (f?.created_at && dayNumber(f.created_at.slice(0, 10)) > dayNumber(prevDate)) return { tag: 'deleted', reason: 'RE_REGISTERED' };
  if (!base.registrar || !base.source) return { tag: 'unknown', reason: 'NO_BASELINE' };
  if (!f?.registrar) return { tag: 'unknown', reason: 'NO_REGISTRAR' };
  const same = base.source === 'feed' && source !== 'market_episode' ? FEED_REGISTRAR[source].family.test(norm(f.registrar)) : norm(f.registrar) === norm(base.registrar);
  return same ? { tag: 'unknown', reason: 'SAME_REGISTRAR' } : { tag: 'bought', reason: `REGISTRAR_CHANGED:${base.registrar} -> ${f.registrar}` };
}

/** `regime` (v5.41.0): names it accepts are looked up first, so the daily cap yields rows the engine can train on. */
export interface TagDeps { db: Kysely<Database>; now: () => number; rdap?: RdapLookupFn; sleep?: (ms: number) => Promise<void>; regime?: (domain: string) => boolean }
export interface TagSummary {
  status: 'ok' | 'stopped' | 'nothing_due';
  inserted: Record<TagSource, number>;
  eligible_n: number; lookups_n: number; cache_hits_n: number; retagged_n: number; bought_n: number; deleted_n: number; unknown_n: number; not_com_n: number;
  cap: number; stopped_reason: string | null; pruned_n: number;
  /** v5.41.0: how many of the due names are in the engine's regime (looked up first); 0 without a regime test. */
  regime_due_n: number;
}

const dayStart = (d: string): Date => new Date(`${d}T00:00:00Z`);

/** Inserts the gone names of every stored day pair of one closeouts feed (idempotent). */
async function collectCloseouts(db: Kysely<Database>, source: 'godaddy_closeouts' | 'dynadot_closeouts'): Promise<number> {
  const days = source === 'godaddy_closeouts'
    ? (await sql<{ d: string }>`select distinct data_date::text as d from datasave_pool where source = 'godaddy_closeouts' order by 1`.execute(db)).rows.map((r) => r.d)
    : (await sql<{ d: string }>`select distinct r.data_date::text as d from dynadot_rows r
        where r.kind = 'closeouts' and exists (select 1 from snapshot_manifests m where m.source = 'dynadot_closeouts' and m.file_name = 'bot_upload' and m.sealed_at is not null and m.data_date = r.data_date)
        order by 1`.execute(db)).rows.map((r) => r.d);
  const feed = FEED_REGISTRAR[source].name;
  let n = 0;
  for (let i = 1; i < days.length; i++) {
    const prev = days[i - 1]!, next = days[i]!;
    const rows = source === 'godaddy_closeouts'
      ? sql`select p.domain, p.ends_at from datasave_pool p where p.source = 'godaddy_closeouts' and p.data_date = ${prev}::date and p.ends_at > ${dayStart(next)}
          and not exists (select 1 from datasave_pool t where t.source = p.source and t.data_date = ${next}::date and t.domain = p.domain)`
      : sql`select p.domain, min(p.ends_at) as ends_at from dynadot_rows p where p.kind = 'closeouts' and p.data_date = ${prev}::date and p.ends_at > ${dayStart(next)}
          and not exists (select 1 from dynadot_rows t where t.kind = 'closeouts' and t.data_date = ${next}::date and t.domain = p.domain) group by p.domain`;
    const res = await sql`insert into disappearances (source, domain, gone_date, prev_date, ends_at, baseline_registrar, baseline_source)
      select ${source}, g.domain, ${next}::date, ${prev}::date, g.ends_at, coalesce(c.registrar, ${feed}), case when c.registrar is not null then 'rdap_cache' else 'feed' end
      from (${rows}) g left join rdap_cache c on c.domain = g.domain and c.registered = true and c.checked_at < ${dayStart(next)}
      on conflict do nothing`.execute(db);
    n += Number(res.numAffectedRows ?? 0);
  }
  return n;
}

/** Keeps one row per DISAPPEARED market episode (gone_date = the day after last_seen); drops the rows of episodes that are no longer DISAPPEARED there. */
async function collectEpisodes(db: Kysely<Database>): Promise<number> {
  await sql`delete from disappearances d where d.source = 'market_episode' and not exists (
    select 1 from market_names m where m.episode_id = d.episode_id and m.outcome_rule = 'DISAPPEARED' and m.last_seen + 1 = d.gone_date and m.name = d.domain)`.execute(db);
  const res = await sql`insert into disappearances (source, domain, gone_date, prev_date, episode_id, baseline_registrar, baseline_source)
    select 'market_episode', m.name, m.last_seen + 1, m.last_seen, m.episode_id, c.registrar, case when c.registrar is not null then 'rdap_cache' end
    from market_names m left join rdap_cache c on c.domain = m.name and c.registered = true and c.checked_at < (m.last_seen + 1)::timestamp at time zone 'UTC'
    where m.outcome_rule = 'DISAPPEARED'
    on conflict do nothing`.execute(db);
  return Number(res.numAffectedRows ?? 0);
}

export async function tagDisappearances(deps: TagDeps): Promise<TagSummary> {
  const { db } = deps;
  const rdap = deps.rdap ?? realRdap;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const nowMs = deps.now();
  const now = new Date(nowMs);
  const today = now.toISOString().slice(0, 10);
  const st = await db.selectFrom('settings').select(['disappearance_lookups_max_per_run', 'disappearance_keep_days']).executeTakeFirstOrThrow();
  const ttlSetting = await cacheTtlMs(db);
  const out: TagSummary = {
    status: 'nothing_due', inserted: { godaddy_closeouts: 0, dynadot_closeouts: 0, market_episode: 0 },
    eligible_n: 0, lookups_n: 0, cache_hits_n: 0, retagged_n: 0, bought_n: 0, deleted_n: 0, unknown_n: 0, not_com_n: 0,
    cap: st.disappearance_lookups_max_per_run, stopped_reason: null, pruned_n: 0, regime_due_n: 0,
  };

  out.inserted.godaddy_closeouts = await collectCloseouts(db, 'godaddy_closeouts');
  out.inserted.dynadot_closeouts = await collectCloseouts(db, 'dynadot_closeouts');
  out.inserted.market_episode = await collectEpisodes(db);

  // only .com has an RDAP source here (Verisign): any other ending stays unknown, final, without a lookup
  const notCom = await sql`update disappearances set tag = 'unknown', tag_reason = 'TLD_NOT_CHECKED', final = true where not final and domain not like '%.com'`.execute(db);
  out.not_com_n = Number(notCom.numAffectedRows ?? 0);

  // due: not final and not checked yet today; never checked first, closeouts before episodes, newest first
  const due = (await sql<{ source: TagSource; domain: string; gone_date: string; prev_date: string; baseline_registrar: string | null; baseline_source: 'rdap_cache' | 'feed' | null; first_checked_at: Date | null; tag: Tag }>`
    select source, domain, gone_date::text as gone_date, prev_date::text as prev_date, baseline_registrar, baseline_source, first_checked_at, tag
    from disappearances where not final and (rdap_checked_at is null or rdap_checked_at < ${dayStart(today)})
    order by (attempts > 0), (source = 'market_episode'), gone_date desc, source, domain`.execute(db)).rows;
  out.eligible_n = due.length;
  if (deps.regime) {
    // engine-regime names first (stable sort: the order above holds inside each group)
    const flag = new Map<string, boolean>();
    for (const d of due) if (!flag.has(d.domain)) flag.set(d.domain, deps.regime(d.domain));
    out.regime_due_n = due.filter((d) => flag.get(d.domain)).length;
    due.sort((a, b) => Number(flag.get(b.domain)) - Number(flag.get(a.domain)));
  }

  for (const d of due) {
    // a stored answer counts only if it was read after the name left the feed
    const ttl = Math.min(ttlSetting, nowMs - dayStart(d.gone_date).getTime());
    let r: RdapLookup | undefined;
    const hit = (await cacheGetMany(db, [d.domain], ttl, nowMs)).get(d.domain);
    if (hit) {
      r = { outcome: hit.registered ? 'registered' : 'not_registered', reasonCode: null, httpStatus: hit.registered ? 200 : 404, url: '', retrievedAt: hit.checkedAt, body: null, facts: hit.facts };
      out.cache_hits_n++;
    } else {
      if (out.lookups_n >= out.cap) { out.stopped_reason = 'CAP'; break; }
      if (out.lookups_n > 0) await sleep(TAG_PAUSE_MS);
      r = await rdap(d.domain);
      out.lookups_n++;
      try { await cachePut(db, d.domain, r, nowMs); } catch { /* the cache is an optimisation */ }
    }
    const t = tagOf(r, { registrar: d.baseline_registrar, source: d.baseline_source }, d.source, d.prev_date);
    const firstChecked = d.first_checked_at ?? now;
    const final = t.tag !== 'unknown' || nowMs - firstChecked.getTime() >= TAG_RETRY_DAYS * 86_400_000;
    const f = r.outcome === 'registered' ? r.facts : null;
    await db.updateTable('disappearances').set({
      tag: t.tag, tag_reason: t.reason, final, attempts: sql`attempts + 1`, first_checked_at: firstChecked, rdap_checked_at: now,
      rdap_registrar: f?.registrar ?? null, rdap_statuses: f ? JSON.stringify(f.statuses) : null, rdap_created: f?.created_at ?? null,
    }).where('source', '=', d.source).where('domain', '=', d.domain).where('gone_date', '=', d.gone_date).execute();
    if (t.tag === 'bought') out.bought_n++; else if (t.tag === 'deleted') out.deleted_n++; else out.unknown_n++;
    if (t.tag !== 'unknown' && d.tag === 'unknown') out.retagged_n++;
    if (r.reasonCode === 'RATE_LIMITED') { out.stopped_reason = 'RATE_LIMITED'; break; } // the registry asked us to slow down: the rest waits for the next run
  }
  if (out.eligible_n > 0) out.status = out.stopped_reason ? 'stopped' : 'ok';

  const del = await db.deleteFrom('disappearances').where('gone_date', '<', addDays(today, -st.disappearance_keep_days)).executeTakeFirst();
  out.pruned_n = Number(del.numDeletedRows ?? 0);
  return out;
}

/** The gone names of one stored day of a closeouts feed, split by tag (R-6). Sums to the day's gone_before_end_n. */
export async function goneByTag(db: Kysely<Database>, source: 'godaddy_closeouts' | 'dynadot_closeouts', goneDate: string): Promise<{ gone_bought_n: number; gone_deleted_n: number; gone_unknown_n: number }> {
  const rows = (await sql<{ tag: Tag; n: string }>`select tag, count(*)::text as n from disappearances where source = ${source} and gone_date = ${goneDate}::date group by tag`.execute(db)).rows;
  const of = (t: Tag) => Number(rows.find((r) => r.tag === t)?.n ?? 0);
  return { gone_bought_n: of('bought'), gone_deleted_n: of('deleted'), gone_unknown_n: of('unknown') };
}
