// v4.0.0 (CR-045 .. CR-049): the life of a bought name in /report: the renewal-time drop check (RENEWAL_DROP_SUGGESTED, SELL_BEFORE_DROP), the 12-month
// horizon (HORIZON_DUE) and the delist task after a sale (DELIST_NEEDED). Mechanical checks only; they list, they never act.
import { sql, type Kysely, type Selectable } from 'kysely';
import { addDays, dayNumber, toJerusalemIso } from '../../../core/dates.js';
import { pair } from '../../../core/money.js';
import type { Database, DomainsTable } from '../../../db/types.js';
import { activeSelectionSettings, searchesOfDomain } from '../../selection/index.js';
import type { WarningLevel } from './warnings.js';

type Add = (code: string, level: WarningLevel, message: string, domain?: string, details?: Record<string, unknown>) => void;
type Dom = Selectable<DomainsTable>;
const daysBetweenYmd = (a: string, b: string): number => dayNumber(b) - dayNumber(a);
const LIVE = ['owned', 'listed', 'delisted'];
const SELL_BEFORE_DROP_VENUES = [
  'afternic: the same listing at a wholesale BIN (a pricing exception: POST /list with an override and Dvir\'s approval_ref naming the domain and the price)',
  'sellerhub: a wholesale BIN through the listing sync, once the plan carries it',
  'namepros: a sale thread, posted by hand (the service never posts)',
];

interface Signals { offers: number; inquiries: number; lookalike_rise: boolean; lookalikes_at_buy: number | null; lookalikes_now: number | null; search_band_above_unmeasured: boolean; keyword_searches: number | null }

/** The keep-signals of a name: offers, inquiries or leads, a rise in lookalikes in use since the screening before the buy, a measured search demand (the latest keyword upload has at least `demand.keep_min_searches` average monthly searches for the name). */
async function signalsFor(db: Kysely<Database>, domain: string, domainId: number, keepMinSearches: number): Promise<Signals> {
  const offers = Number((await sql<{ n: string }>`select count(*)::text as n from offers where domain_id = ${domainId}`.execute(db)).rows[0]!.n);
  const inq = Number((await sql<{ n: string }>`select coalesce(sum(coalesce(inquiries, 0) + coalesce(leads, 0)), 0)::text as n from portfolio_stats where domain = ${domain}`.execute(db)).rows[0]!.n);
  const base = await sql<{ n: number | null }>`
    select (fields->'lookalikes'->>'in_use_n')::int as n from screening_results where domain = ${domain} and check_id = 'lookalikes' and status = 'PASS'
    order by checked_at asc, id asc limit 1`.execute(db);
  const now = await sql<{ n: number | null }>`
    select (details->>'in_use_n')::int as n from portfolio_checks pc join domains d on d.id = pc.domain_id where d.domain = ${domain} and pc.kind = 'lookalikes' and pc.status = 'ok'
    order by pc.id desc limit 1`.execute(db);
  const searches = await searchesOfDomain(db, domain);
  const at = base.rows[0]?.n ?? null;
  const cur = now.rows[0]?.n ?? null;
  return { offers, inquiries: inq, lookalike_rise: at !== null && cur !== null && cur > at, lookalikes_at_buy: at, lookalikes_now: cur, search_band_above_unmeasured: searches !== null && searches >= keepMinSearches, keyword_searches: searches };
}

export async function lifecycleWarnings(db: Kysely<Database>, now: Date, today: string, domains: Dom[], add: Add): Promise<void> {
  const sel = (await activeSelectionSettings(db)).values;
  const r = sel.renewal;
  for (const d of domains) {
    if (!LIVE.includes(d.status) || d.expiry_date === null) continue;
    // CR-045 item 1 + follow-up: the renewal-time drop check, r.drop_check_days before the first expiry
    if (d.renewals_used === 0) {
      const days = daysBetweenYmd(today, d.expiry_date);
      if (days >= 0 && days <= r.drop_check_days) {
        const s = await signalsFor(db, d.domain, d.id, sel.demand.keep_min_searches);
        const keep = s.offers > 0 || s.inquiries > 0 || s.lookalike_rise || s.search_band_above_unmeasured;
        const card = (d.buy_card ?? null) as { stre_bp?: number | null; renewal_math?: { commission_bp?: number } } | null;
        let math: Record<string, unknown> | null = null;
        let mathFails = false;
        if (card?.stre_bp != null && card.renewal_math?.commission_bp != null && d.bin_cents !== null && d.renewal_price_cents) {
          const exact = (d.bin_cents * (10_000 - card.renewal_math.commission_bp) * card.stre_bp) / 100_000_000;
          const ratio = exact / d.renewal_price_cents;
          mathFails = ratio < sel.buy.renewal_math_min;
          math = { ratio: Math.round(ratio * 100) / 100, min: sel.buy.renewal_math_min, pass: !mathFails };
        }
        const suggested = !keep || mathFails;
        if (suggested) {
          const listBy = addDays(d.expiry_date, -r.list_by_days_before_expiry);
          const details = { expiry: d.expiry_date, days_to_expiry: days, signals: s, ...(math ? { renewal_math: math } : {}), ...pair('renewal', d.renewal_price_cents) };
          if (d.drop_date !== d.expiry_date) {
            add('RENEWAL_DROP_SUGGESTED', 'warn', `${d.domain}: no inquiry, offer or growing lookalike use and the expiry is in ${days} days; drop it instead of renewing.`, d.domain, details);
          }
          add('SELL_BEFORE_DROP', 'warn', `${d.domain}: list it for a wholesale exit by ${listBy}; if it is unsold at ${d.expiry_date} it drops.`, d.domain, {
            expiry: d.expiry_date, list_by: listBy, venues: SELL_BEFORE_DROP_VENUES, ...(d.drop_date === d.expiry_date ? {} : { drop_suggested: true }),
          });
        }
      }
    }
    // CR-045 item 2: trend and regulation names are sold or dropped by buy + 12 months
    if (d.horizon !== 'evergreen' && d.sell_or_drop_by) {
      const left = daysBetweenYmd(today, d.sell_or_drop_by);
      if (left <= r.horizon_due_days) {
        add('HORIZON_DUE', left < 0 ? 'error' : 'warn', `${d.domain} (${d.horizon}): sell it or drop it by ${d.sell_or_drop_by}${left < 0 ? ' (past due)' : ''}.`, d.domain, { horizon: d.horizon, sell_or_drop_by: d.sell_or_drop_by, days_left: left });
      }
    }
  }

  // CR-049 item 4: a sold name must come off every venue. The venues whose latest hand-listing row is not a removal are still to be cleared in the Chrome run.
  const soldRecent = domains.filter((d) => d.status === 'sold' && d.sold_at && now.getTime() - d.sold_at.getTime() <= 30 * 86_400_000);
  const latestVenue = await sql<{ domain: string; venue: string; delisted: boolean }>`
    select distinct on (domain, venue) domain, venue, delisted from venue_listings where provenance <> 'observed_public' order by domain, venue, id desc`.execute(db);
  const clearedAt = new Map(latestVenue.rows.filter((v) => v.delisted).map((v) => [`${v.domain}|${v.venue}`, true]));
  for (const d of soldRecent) {
    const venues = ['afternic', 'sedo'].filter((v) => !clearedAt.has(`${d.domain}|${v}`));
    if (venues.length > 0) {
      add('DELIST_NEEDED', 'error', `${d.domain} is sold: remove the listing at ${venues.join(' and ')} now (SellerHub is delisted by the service).`, d.domain, { venues, reason: 'sold', sold_at: toJerusalemIso(d.sold_at!) });
    }
  }
  // a SellerHub sold report for a name we have not recorded as sold: the sale there is real, the other venues must be cleared too
  const seen = await sql<{ domain: string; at: Date }>`
    select distinct on (domain) domain, at from listing_sync_log where venue = 'sellerhub' and action = 'sold_seen' order by domain, id desc`.execute(db);
  const byName = new Map(domains.map((d) => [d.domain, d]));
  for (const s of seen.rows) {
    const d = byName.get(s.domain);
    if (!d || d.status === 'sold' || d.status === 'dropped') continue;
    add('DELIST_NEEDED', 'error', `${d.domain} was sold at SellerHub: remove the listing at afternic and sedo now, then record the sale (POST /sold).`, d.domain, {
      venues: ['afternic', 'sedo'], reason: 'sellerhub_sold_report', seen_at: toJerusalemIso(s.at),
    });
  }
}
