// v5.65.0 (F44): the renew-or-drop signal of an owned name, from the Afternic 30-day views and leads (visit_daily, source afternic, stored by the daily afternicSync or a hand import)
// and the offers of the last 365 days. ADVICE ONLY: Dvir decides every renewal (founder rule 3); nothing here renews, drops or changes a plan. Rules: docs/internal/renewal-signal.md.
import { sql, type Kysely } from 'kysely';
import { dayNumber, idtDay } from '../../../core/dates.js';
import type { Database, DomainRow } from '../../../db/types.js';

export type RenewalSignalValue = 'renew' | 'reprice' | 'drop' | 'too_early';
export interface RenewalSignal {
  views_30d: number | null; leads_30d: number | null;
  views_trend: { previous_30d: number | null; delta: number | null; direction: 'up' | 'flat' | 'down' | 'unknown' };
  days_to_expiry: number | null; offers_365d: number;
  /** null when there is no Afternic read of the name yet and no offer (nothing to judge by) */
  signal: RenewalSignalValue | null;
  reason: string;
  renewal_available: boolean;
}

/** Days before expiry from which the signal is judged; earlier it is "too_early". */
export const RENEWAL_SIGNAL_START_DAYS = 90;
/** RENEWAL_SIGNAL_DROP (info) is raised for a "drop" within this many days of expiry. */
export const RENEWAL_SIGNAL_WARN_DAYS = 60;
const LIVE = ['owned', 'listed', 'delisted'];

/** Pure rule. `viewsMin` = settings.renew_views_min. */
export function judgeRenewal(i: { views: number | null; leads: number | null; offers365: number; daysToExpiry: number | null; viewsMin: number }): { signal: RenewalSignalValue | null; reason: string } {
  if (i.daysToExpiry === null || i.daysToExpiry > RENEWAL_SIGNAL_START_DAYS) return { signal: 'too_early', reason: `more than ${RENEWAL_SIGNAL_START_DAYS} days to expiry` };
  const leads = i.leads ?? 0;
  if (leads >= 1) return { signal: 'renew', reason: `${leads} lead(s) in 30 days` };
  if (i.offers365 >= 1) return { signal: 'renew', reason: `${i.offers365} offer(s) in the last 365 days` };
  if (i.views === null) return { signal: null, reason: 'no Afternic views read for this name yet' };
  if (i.views >= i.viewsMin) return { signal: 'renew', reason: `${i.views} views in 30 days (minimum ${i.viewsMin})` };
  if (i.views >= 1) return { signal: 'reprice', reason: `${i.views} views in 30 days, below the minimum ${i.viewsMin}, no leads` };
  return { signal: 'drop', reason: '0 views in 30 days, no leads, no offers in 365 days' };
}

/** One signal per owned / listed / delisted name of `domains`: three bulk statements (settings, visits, offers), no per-name queries. */
export async function renewalSignals(db: Kysely<Database>, now: Date, domains: DomainRow[]): Promise<Map<string, RenewalSignal>> {
  const live = domains.filter((d) => LIVE.includes(d.status));
  const out = new Map<string, RenewalSignal>();
  if (live.length === 0) return out;
  const names = live.map((d) => d.domain);
  const ids = live.map((d) => d.id);
  const viewsMin = (await db.selectFrom('settings').select('renew_views_min').executeTakeFirstOrThrow()).renew_views_min;
  // the newest afternic row of each name and the newest row at least 30 days older than it (the 30-day window before)
  const v = await sql<{ domain: string; views: number | null; leads: number | null; prev_views: number | null }>`
    select l.domain, l.views_30d as views, l.leads_30d as leads, p.views_30d as prev_views
    from (select distinct on (domain) domain, date_utc, views_30d, leads_30d from visit_daily where source = 'afternic' and domain = any(${names}::text[]) order by domain, date_utc desc, id desc) l
    left join lateral (select x.views_30d from visit_daily x where x.source = 'afternic' and x.domain = l.domain and x.date_utc <= l.date_utc - 30 order by x.date_utc desc, x.id desc limit 1) p on true`.execute(db);
  const vBy = new Map(v.rows.map((r) => [r.domain, r]));
  const o = await sql<{ domain_id: number; n: string }>`select domain_id, count(*)::text as n from offers where domain_id = any(${ids}::int[]) and received_at >= ${new Date(now.getTime() - 365 * 86_400_000)} group by domain_id`.execute(db);
  const oBy = new Map(o.rows.map((r) => [r.domain_id, Number(r.n)]));
  const today = dayNumber(idtDay(now));
  for (const d of live) {
    const r = vBy.get(d.domain);
    const views = r?.views ?? null; const prev = r?.prev_views ?? null;
    const delta = views !== null && prev !== null ? views - prev : null;
    const offers365 = oBy.get(d.id) ?? 0;
    const daysToExpiry = d.expiry_date ? dayNumber(d.expiry_date) - today : null;
    const j = judgeRenewal({ views, leads: r?.leads ?? null, offers365, daysToExpiry, viewsMin });
    out.set(d.domain, {
      views_30d: views, leads_30d: r?.leads ?? null,
      views_trend: { previous_30d: prev, delta, direction: delta === null ? 'unknown' : delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat' },
      days_to_expiry: daysToExpiry, offers_365d: offers365, signal: j.signal, reason: j.reason, renewal_available: d.renewals_used < 1,
    });
  }
  return out;
}
