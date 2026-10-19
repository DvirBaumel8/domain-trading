// v5.18.0 (CR-068): the visitor counter's store. Counts only: one visit_daily row per (domain, UTC day, source); no IP, cookie, path or user agent exists anywhere here.
import { sql, type Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { landerNameservers } from '../listing/index.js';

/** Hits (human + bot) counted per name per UTC day; the rest only add to `capped`. */
export const VISIT_DAILY_CAP = 1000;
/** Distinct referrer hosts kept per name per day (the first ten seen); every other host adds to "other". */
export const REFERRER_HOSTS_PER_DAY = 10;
export const WEEKLY_TOP_REFERRERS = 5;

const HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

/** The host of whatever the Worker sent: a bare host, or a URL that slipped in (scheme, userinfo, port, path, query and fragment are dropped). Not a usable host, or over 253 characters: "other". Null/empty: null. */
export function normalizeReferrerHost(input: string | null | undefined): string | null {
  if (input === undefined || input === null) return null;
  let h = input.trim().toLowerCase();
  if (h === '') return null;
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  h = h.split(/[/?#]/, 1)[0]!;
  h = h.slice(h.lastIndexOf('@') + 1);
  h = h.replace(/:\d*$/, '').replace(/\.$/, '');
  return h.length > 0 && h.length <= 253 && HOST.test(h) ? h : 'other';
}

export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export async function visitsEnabled(db: Kysely<Database>): Promise<boolean> {
  return (await db.selectFrom('settings').select('visits_enabled').executeTakeFirstOrThrow()).visits_enabled;
}

/** Does this nameserver list include Afternic's (so Afternic, not our redirect, serves the page)? */
export function hasAfternicNs(ns: readonly string[] | null | undefined): boolean {
  const af = new Set(landerNameservers('afternic')!);
  return (ns ?? []).some((n) => af.has(n.trim().toLowerCase().replace(/\.$/, '')));
}

/**
 * Is this name on Afternic's nameservers? BUG-045 (v5.19.0): `lander: "afternic"` names the listing venue (a Porkbun name forwards to its Afternic page),
 * not the nameservers, so it no longer counts. The live NS answer decides when there is one; otherwise the stored `lander_ns`.
 */
export function onAfternicNs(row: { lander_ns: string[] | null }, liveNs?: string[] | null): boolean {
  return hasAfternicNs(liveNs ?? row.lander_ns);
}

/** Live nameservers per name (null when the lookup fails), looked up in parallel. */
export async function liveNsOf(domains: readonly string[], nsLookup?: (d: string) => Promise<string[] | null>): Promise<Map<string, string[] | null>> {
  if (!nsLookup) return new Map();
  const answers = await Promise.all(domains.map(async (d) => [d, await nsLookup(d).catch(() => null)] as const));
  return new Map(answers);
}

/** A name a hit can be counted for: status listed and not on Afternic's nameservers. */
export async function isCountable(db: Kysely<Database>, domain: string): Promise<boolean> {
  const row = await db.selectFrom('domains').select(['status', 'lander', 'lander_ns']).where('domain', '=', domain).executeTakeFirst();
  return row !== undefined && row.status === 'listed' && !onAfternicNs(row);
}

/**
 * One counted hit: a single upsert (INSERT .. ON CONFLICT DO UPDATE), so concurrent hits cannot lose a count or pass the cap.
 * Past VISIT_DAILY_CAP hits (human + bot) in the UTC day a hit only adds to `capped`. The referrer host goes to its own key while fewer than
 * REFERRER_HOSTS_PER_DAY hosts are stored (or it is already stored), else to "other". Once capped is above 0 every later hit of that day is capped too,
 * so `capped > 0` after the statement means this hit was capped.
 */
export async function recordHit(db: Kysely<Database>, o: { domain: string; ua: 'human' | 'bot'; referrer: string | null; nowMs: number }): Promise<{ counted: boolean; capped: boolean }> {
  const h = o.ua === 'human' ? 1 : 0;
  const b = 1 - h;
  const day = utcDay(o.nowMs);
  const cap = VISIT_DAILY_CAP;
  const maxHosts = REFERRER_HOSTS_PER_DAY;
  const ref = o.referrer;
  const total = sql`(visit_daily.human_hits + visit_daily.bot_hits)`;
  const key = sql`(case when ${ref}::text is null then null
    when jsonb_exists(visit_daily.referrer_hosts, ${ref}::text) or (select count(*) from jsonb_object_keys(visit_daily.referrer_hosts) k where k <> 'other') < ${maxHosts} then ${ref}::text
    else 'other' end)`;
  const r = await sql<{ capped: number }>`
    insert into visit_daily (domain, date_utc, source, human_hits, bot_hits, capped, referrer_hosts)
    values (${o.domain}, ${day}::date, 'dom_redirect', ${h}, ${b}, 0, case when ${ref}::text is null then '{}'::jsonb else jsonb_build_object(${ref}::text, 1) end)
    on conflict (domain, date_utc, source) do update set
      human_hits = visit_daily.human_hits + case when ${total} < ${cap} then ${h} else 0 end,
      bot_hits = visit_daily.bot_hits + case when ${total} < ${cap} then ${b} else 0 end,
      capped = visit_daily.capped + case when ${total} >= ${cap} then 1 else 0 end,
      referrer_hosts = case when ${key} is null or ${total} >= ${cap} then visit_daily.referrer_hosts
        else jsonb_set(visit_daily.referrer_hosts, array[${key}], to_jsonb(coalesce((visit_daily.referrer_hosts ->> ${key})::int, 0) + 1)) end,
      updated_at = now()
    returning capped`.execute(db);
  const capped = r.rows[0]!.capped > 0;
  return { counted: !capped, capped };
}

/** POST /visits/import: Afternic's 30-day Views/Leads read on `date`; a re-import of the same (domain, date) replaces the row. Returns false for a name we do not know. */
export async function importAfternic(db: Kysely<Database>, o: { domain: string; date: string; views30d: number; leads30d: number; now: Date }): Promise<boolean> {
  const known = await db.selectFrom('domains').select('id').where('domain', '=', o.domain).executeTakeFirst();
  if (!known) return false;
  await sql`
    insert into visit_daily (domain, date_utc, source, views_30d, leads_30d, imported_at)
    values (${o.domain}, ${o.date}::date, 'afternic', ${o.views30d}, ${o.leads30d}, ${o.now})
    on conflict (domain, date_utc, source) do update set views_30d = excluded.views_30d, leads_30d = excluded.leads_30d, imported_at = excluded.imported_at, updated_at = now()`.execute(db);
  return true;
}

/** POST /visits/settings: the on/off switch. Returns the previous value. */
export async function setVisitsEnabled(db: Kysely<Database>, enabled: boolean, now: Date): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const cur = await trx.selectFrom('settings').select('visits_enabled').forUpdate().executeTakeFirstOrThrow();
    await trx.updateTable('settings').set({ visits_enabled: enabled, updated_at: now }).execute();
    return cur.visits_enabled;
  });
}

/** POST /visits/settings {token: "request"}: asks the Mac host for a visit-counter token (see `admin visits-token-handoff`). Returns the state before. */
export async function requestVisitsToken(db: Kysely<Database>, now: Date): Promise<'requested' | 'issued' | null> {
  return db.transaction().execute(async (trx) => {
    const cur = await trx.selectFrom('settings').select('visits_token_request').forUpdate().executeTakeFirstOrThrow();
    await trx.updateTable('settings').set({ visits_token_request: 'requested', visits_token_requested_at: now, updated_at: now }).execute();
    return cur.visits_token_request;
  });
}

export interface VisitRow {
  domain: string; date: string; source: 'dom_redirect' | 'afternic'; human_hits: number; bot_hits: number; capped: number;
  referrer_hosts: Record<string, number>; views_30d: number | null; leads_30d: number | null;
}

export async function readDaily(db: Kysely<Database>, from: string, to: string): Promise<VisitRow[]> {
  const rows = await db.selectFrom('visit_daily').selectAll().where('date_utc', '>=', from).where('date_utc', '<=', to).orderBy('date_utc').orderBy('domain').orderBy('source').execute();
  return rows.map((r) => ({
    domain: r.domain, date: r.date_utc, source: r.source, human_hits: r.human_hits, bot_hits: r.bot_hits, capped: r.capped,
    referrer_hosts: r.referrer_hosts, views_30d: r.views_30d, leads_30d: r.leads_30d,
  }));
}

export interface WeeklyRow { domain: string; source: 'dom_redirect'; human_hits: number; bot_hits: number; capped: number; top_referrers: { host: string; n: number }[] }
export interface NotCountable { domain: string; reason: 'afternic_ns' | 'not_forwarded'; afternic_views_30d: number | null; afternic_leads_30d: number | null; afternic_read_date: string | null }

/**
 * The week (Sunday..Saturday, UTC days `from`..`to`): a row for every listed name that is counted (an active forward to the counting redirect, not on Afternic's
 * nameservers; zeros when nothing came), and under not_countable the other listed names: `afternic_ns` (Afternic serves the page) or `not_forwarded` (no active forward yet).
 */
export async function weekly(db: Kysely<Database>, from: string, to: string, nsLookup?: (d: string) => Promise<string[] | null>): Promise<{ rows: WeeklyRow[]; not_countable: NotCountable[] }> {
  const listed = await db.selectFrom('domains').select(['domain', 'lander', 'lander_ns']).where('status', '=', 'listed').orderBy('domain').execute();
  const live = await liveNsOf(listed.map((d) => d.domain), nsLookup);
  const active = new Set((await db.selectFrom('visit_forwards').select('domain').where('reverted_at', 'is', null).execute()).map((r) => r.domain));
  const data = (await readDaily(db, from, to)).filter((r) => r.source === 'dom_redirect');
  const byDomain = new Map<string, WeeklyRow & { hosts: Map<string, number> }>();
  const ensure = (domain: string) => {
    let x = byDomain.get(domain);
    if (!x) { x = { domain, source: 'dom_redirect', human_hits: 0, bot_hits: 0, capped: 0, top_referrers: [], hosts: new Map() }; byDomain.set(domain, x); }
    return x;
  };
  const notCountable: NotCountable[] = [];
  for (const d of listed) {
    const afternicNs = onAfternicNs(d, live.get(d.domain));
    if (afternicNs || !active.has(d.domain)) {
      const last = await db.selectFrom('visit_daily').select(['views_30d', 'leads_30d', 'date_utc']).where('domain', '=', d.domain).where('source', '=', 'afternic').orderBy('date_utc', 'desc').limit(1).executeTakeFirst();
      notCountable.push({ domain: d.domain, reason: afternicNs ? 'afternic_ns' : 'not_forwarded', afternic_views_30d: last?.views_30d ?? null, afternic_leads_30d: last?.leads_30d ?? null, afternic_read_date: last?.date_utc ?? null });
    } else ensure(d.domain);
  }
  const skip = new Set(notCountable.map((n) => n.domain));
  for (const r of data) {
    if (skip.has(r.domain)) continue;
    const x = ensure(r.domain);
    x.human_hits += r.human_hits; x.bot_hits += r.bot_hits; x.capped += r.capped;
    for (const [host, n] of Object.entries(r.referrer_hosts)) x.hosts.set(host, (x.hosts.get(host) ?? 0) + n);
  }
  const rows = [...byDomain.values()].sort((a, b) => a.domain.localeCompare(b.domain)).map(({ hosts, ...row }) => ({
    ...row,
    top_referrers: [...hosts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, WEEKLY_TOP_REFERRERS).map(([host, n]) => ({ host, n })),
  }));
  return { rows, not_countable: notCountable };
}
