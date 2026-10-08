// v2.8.0 (CR-007 §22, G-2 source A): the drop-list filter, the registry-status mapping and the paced fresh lookups shared by the daily steps
// `dropWatch` and `cohortOutcomes`. Nothing here calls a registrar or marketplace; the only outside call is RDAP, 4 at a time, 250 ms apart, adaptive.
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { addDays, dayNumber, idtDay } from '../../core/dates.js';
import type { Database } from '../../db/types.js';
import { TEST_SET_RDAP_CONCURRENCY, TEST_SET_RDAP_MIN_MS, lookupCached, Pacer, type CachedLookup } from '../selection/index.js';
import { activeSelectionSettings } from '../selection/index.js';
import { splitV2 } from '../selection/index.js';
import type { ScreeningDeps } from '../selection/index.js';
import type { RdapFacts } from '../../core/rdap.js';

/** Reads ignore a list more than this many days after its list_date; rows are never deleted (append-only). */
export const DROP_LIST_RETENTION_DAYS = 60;
export const DROP_WATCH_MAX_PER_RUN = 3000;
/** A registry lookup that answered unknown is asked again on later daily runs, at most this many checks in all. */
export const MAX_UNKNOWN_CHECKS = 5;
/** `/report` warns DROP_FEED_STALE when the newest list is more than this many days old. */
export const DROP_FEED_STALE_DAYS = 2;
export const PENDING_DELETE_DAYS = 5;
export const REDEMPTION_DAYS = 35;
export const DROP_LIST_NAME_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/;

export const daysBetween = (a: string, b: string): number => dayNumber(b) - dayNumber(a);
/** The oldest list_date a read still uses. */
export const retentionCutoff = (nowMs: number): string => addDays(idtDay(nowMs), -DROP_LIST_RETENTION_DAYS);

export type RemovedReason = 'DOMAIN_INVALID' | 'DUPLICATE_IN_UPLOAD' | 'HAS_DIGIT' | 'HAS_HYPHEN' | 'NO_SPLIT' | 'TOO_MANY_WORDS' | 'ONE_WORD';
export const MAX_WORDS = 3;
export interface FilteredName { domain: string; kept: boolean; reason: RemovedReason | null; tokens: string[] | null }

/** Lower-cases and filters one uploaded name: a letters-only second-level .com of 2 or 3 words by the bt1@v2 split. */
export function filterDropName(raw: string, seen: Set<string>): FilteredName {
  const domain = raw.trim().toLowerCase();
  const out = (reason: RemovedReason): FilteredName => ({ domain: raw, kept: false, reason, tokens: null });
  const m = /^([a-z0-9-]+)\.com$/.exec(domain);
  if (!m || m[1]!.startsWith('-') || m[1]!.endsWith('-') || m[1]!.length > 63) return out('DOMAIN_INVALID');
  if (seen.has(domain)) return { ...out('DUPLICATE_IN_UPLOAD'), domain };
  seen.add(domain);
  const sld = m[1]!;
  if (/\d/.test(sld)) return { ...out('HAS_DIGIT'), domain };
  if (sld.includes('-')) return { ...out('HAS_HYPHEN'), domain };
  const tokens = splitV2(sld);
  if (tokens.length === 0) return { ...out('NO_SPLIT'), domain };
  // v2.15.0 (CR-013 F-11b): a removed row keeps the split DOM used.
  if (tokens.length > MAX_WORDS) return { ...out('TOO_MANY_WORDS'), domain, tokens };
  if (tokens.length < 2) return { ...out('ONE_WORD'), domain, tokens };
  return { domain, kept: true, reason: null, tokens };
}

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, '');
export const isPendingDelete = (f: RdapFacts | null): boolean => !!f && f.statuses.some((s) => squash(s) === 'pendingdelete');
export const isRedemption = (f: RdapFacts | null): boolean => !!f && f.statuses.some((s) => squash(s) === 'redemptionperiod');
const dateOf = (iso: string | null | undefined): string | null => (iso && !Number.isNaN(Date.parse(iso)) ? idtDay(new Date(Date.parse(iso))) : null);

export interface WatchStatus {
  status: 'pending_delete' | 'redemption' | 'registered' | 'not_registered' | 'unknown';
  last_changed: string | null; expected_drop_date: string | null; drop_date_source: 'rdap_last_changed' | 'estimate' | null; reason_code: string | null;
}

/** RDAP answer -> drop-list status and expected drop date (pending delete: last changed + 5 days; redemption: + 35 days, an estimate). */
export function watchStatusOf(r: Pick<CachedLookup, 'outcome' | 'facts' | 'reasonCode'>): WatchStatus {
  const none = { last_changed: null, expected_drop_date: null, drop_date_source: null, reason_code: null };
  if (r.outcome === 'not_registered') return { status: 'not_registered', ...none };
  if (r.outcome === 'unknown' || !r.facts) return { status: 'unknown', ...none, reason_code: r.reasonCode ?? 'SOURCE_ERROR' };
  const last = dateOf(r.facts.updated_at);
  if (isPendingDelete(r.facts)) {
    return { status: 'pending_delete', last_changed: last, expected_drop_date: last ? addDays(last, PENDING_DELETE_DAYS) : null, drop_date_source: last ? 'rdap_last_changed' : null, reason_code: null };
  }
  if (isRedemption(r.facts)) {
    return { status: 'redemption', last_changed: last, expected_drop_date: last ? addDays(last, REDEMPTION_DAYS) : null, drop_date_source: last ? 'estimate' : null, reason_code: null };
  }
  return { status: 'registered', ...none };
}

/**
 * Fresh RDAP lookups (never reused from the cache), 4 at a time with the adaptive pacer. `onResult` runs as each lookup
 * ends; a throw inside it is the caller's. A lookup that throws is recorded as unknown (SOURCE_ERROR).
 */
export async function freshLookups(db: Kysely<Database>, deps: ScreeningDeps, now: () => number, domains: string[], onResult: (domain: string, r: CachedLookup) => Promise<void>): Promise<void> {
  if (domains.length === 0) return;
  const evidenceMaxBytes = (await activeSelectionSettings(db)).values.evidence.max_text_bytes;
  const pace = new Pacer(TEST_SET_RDAP_MIN_MS, TEST_SET_RDAP_CONCURRENCY, deps.sleep);
  const queue = [...domains];
  const worker = async () => {
    for (let d = queue.shift(); d !== undefined; d = queue.shift()) {
      let r: CachedLookup;
      try {
        r = await lookupCached(db, deps, d, { maxAgeHours: 0, evidenceMaxBytes, pace, now });
      } catch (e) {
        void e;
        r = { outcome: 'unknown', reasonCode: 'SOURCE_ERROR', httpStatus: null, url: '', retrievedAt: new Date(now()), body: null, facts: null, cached: false, evidenceId: null, checkedAt: new Date(now()), rateLimited: 0, source: null };
      }
      await onResult(d, r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(TEST_SET_RDAP_CONCURRENCY, domains.length) }, worker));
}

export interface WindowName { domain: string; list_name: string; status: string; expected_drop_date: string; drop_date_source: string | null; tokens: string[] | null }

/** Kept names (lists within retention) whose latest check has an expected drop date in [from, to]; one row per domain (its latest check), by date then domain. */
export async function namesDroppingBetween(db: Kysely<Database>, nowMs: number, from: string, to: string): Promise<WindowName[]> {
  const r = await sql<WindowName>`
    select domain, list_name, status, expected_drop_date::text as expected_drop_date, drop_date_source, tokens from (
      select distinct on (c.domain) c.domain, c.list_name, c.status, c.expected_drop_date, c.drop_date_source,
        (select r.tokens from drop_list_rows r where r.list_name = c.list_name and r.domain = c.domain and r.kept order by r.id limit 1) as tokens
      from drop_list_checks c join drop_lists l on l.name = c.list_name
      where l.list_date >= ${retentionCutoff(nowMs)}::date
        and exists (select 1 from drop_list_rows r where r.list_name = c.list_name and r.domain = c.domain and r.kept)
      order by c.domain, c.id desc) x
    where expected_drop_date between ${from}::date and ${to}::date
    order by expected_drop_date, domain`.execute(db);
  return r.rows;
}
