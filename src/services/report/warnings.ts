import type { Kysely } from 'kysely';
import { jerusalemDate } from '../../dates.js';
import type { Database } from '../../db/types.js';
import { computePlan } from '../../pricing/plan.js';
import { settingsByVersion } from '../../pricing/settings.js';
import { toJerusalemIso } from '../../time.js';
import { manualDelist, pendingDomains, VENUES } from '../export-state.js';
import { payoutsPending } from './domains.js';
import { pair, priceValues } from './money.js';

export type WarningLevel = 'info' | 'warn' | 'error';
export interface ReportWarning { code: string; level: WarningLevel; domain?: string; message: string; details: Record<string, unknown> }

const LIVE = ['owned', 'listed', 'delisted'] as const;
const DAY = 86_400_000;
const RANK: Record<WarningLevel, number> = { error: 0, warn: 1, info: 2 };

export async function buildWarnings(db: Kysely<Database>, now: Date): Promise<ReportWarning[]> {
  const out: ReportWarning[] = [];
  const add = (code: string, level: WarningLevel, message: string, domain?: string, details: Record<string, unknown> = {}) =>
    out.push({ code, level, ...(domain ? { domain } : {}), message, details });
  const today = jerusalemDate(now);
  const domains = await db.selectFrom('domains').selectAll().where('status', '!=', 'pending_purchase').orderBy('domain').execute();
  const nameOf = new Map(domains.map((d) => [d.id, d.domain]));
  const statusOf = new Map(domains.map((d) => [d.id, d.status]));
  const registrarOf = new Map(domains.map((d) => [d.id, d.registrar]));
  const live = (s: string) => (LIVE as readonly string[]).includes(s);

  // sales
  const sales = await db.selectFrom('sales').selectAll().where('confirmed', '=', false).orderBy('sold_at').orderBy('id').execute();
  for (const s of sales) {
    add('SALE_UNCONFIRMED', 'info', `Sale of ${nameOf.get(s.domain_id)} on ${s.venue} is recorded but not confirmed (recorded by ${s.recorded_by}).`, nameOf.get(s.domain_id), {
      venue: s.venue, transaction_ref: s.transaction_ref, evidence_source: s.evidence_source, evidence_ref: s.evidence_ref, recorded_by: s.recorded_by, sold_at: toJerusalemIso(s.sold_at),
    });
  }
  const soldIds = new Set((await db.selectFrom('sales').select('domain_id').execute()).map((s) => s.domain_id));
  for (const p of await db.selectFrom('registrar_presence').selectAll().where('status', '=', 'absent').orderBy('domain_id').execute()) {
    if (soldIds.has(p.domain_id)) continue;
    const d = nameOf.get(p.domain_id);
    if (d === undefined || !live(statusOf.get(p.domain_id)!)) continue;
    add('DOMAIN_LEFT_ACCOUNT', 'error', `${d} is no longer in the registrar account and no sale is recorded.`, d, {
      registrar: registrarOf.get(p.domain_id) ?? null,
      first_absent_at: p.first_absent_at ? toJerusalemIso(p.first_absent_at) : null, last_checked_at: toJerusalemIso(p.last_checked_at),
    });
  }
  for (const p of await payoutsPending(db, now)) {
    if (p.days_pending > 30) add('PAYOUT_OVERDUE', 'warn', `The ${p.venue} payout for ${p.domain} has been pending ${p.days_pending} days.`, p.domain, { venue: p.venue, amount_cents: p.amount_cents, amount: p.amount, days_pending: p.days_pending, sold_at: p.sold_at });
  }

  // domains
  const pending = new Set(await pendingDomains(db, 'afternic'));
  for (const d of domains) {
    if (d.lander_ns && d.ns_verified_at === null && (d.status === 'owned' || d.status === 'listed')) {
      add('NS_UNVERIFIED', 'warn', `${d.domain}: the nameservers are not verified as the lander's.`, d.domain, { lander: d.lander, lander_ns: d.lander_ns });
    }
    // unreachable under the domains_category_once_owned CHECK; kept as a defensive rule
    if (d.status === 'listed' && d.category === null) add('CATEGORY_MISSING', 'warn', `${d.domain} is listed without a category.`, d.domain);
    if (d.renewals_used === 0 && d.renewal_price_cents === null && d.status !== 'sold' && d.status !== 'dropped') {
      add('RENEWAL_PRICE_UNKNOWN', 'warn', `${d.domain} has no renewal price on record.`, d.domain);
    }
    if (d.status === 'listed' && (d.listing_mode === 'hybrid' || d.listing_mode === 'offer') && d.floor_cents !== null && d.bin_cents !== null && d.floor_cents < d.bin_cents) {
      add('FLOOR_AUTO_ACCEPT', 'info', `${d.domain}: Afternic auto-accepts any offer at or above the floor.`, d.domain, { ...pair('floor', d.floor_cents), ...pair('bin', d.bin_cents) });
    }
    if (d.status === 'listed' && (d.listing_mode === 'bin' || d.listing_mode === 'hybrid') && d.bin_cents === null) add('BIN_MISSING', 'warn', `${d.domain} is listed without a BIN.`, d.domain);
    if (live(d.status) && d.drop_date && d.drop_date < today) add('PAST_DROP_DATE', 'warn', `${d.domain} is past its drop date (${d.drop_date}); mark it dropped.`, d.domain, { drop_date: d.drop_date });
    if (live(d.status) && d.renewals_used === 0 && d.expiry_date && d.expiry_date < today) {
      add('EXPIRED_NOT_RENEWED', 'error', `${d.domain} expired on ${d.expiry_date} and was not renewed.`, d.domain, { expiry_date: d.expiry_date });
    }
    if (d.status === 'listed' && pending.has(d.domain)) {
      const ms = d.export_pending_since ? now.getTime() - d.export_pending_since.getTime() : 0;
      const days = Math.floor(ms / DAY);
      add('EXPORT_PENDING', ms > 7 * DAY ? 'error' : 'warn', `${d.domain}: the marketplace price is stale for ${days} days (export and upload).`, d.domain, { days_pending: days, export_pending_since: d.export_pending_since ? toJerusalemIso(d.export_pending_since) : null });
    }
    if (d.pricing_hold) {
      const last = await db.selectFrom('listing_history').select('at').where('domain_id', '=', d.id).orderBy('id', 'desc').limit(1).executeTakeFirst();
      const since = last?.at ?? d.updated_at;
      if (now.getTime() - since.getTime() > 30 * DAY) {
        add('HOLD_STALE', 'warn', `${d.domain}: the pricing hold has been on since ${toJerusalemIso(since)} (over 30 days).`, d.domain, { reason: d.pricing_hold_reason, since: toJerusalemIso(since) });
      }
    }
    if (d.pricing_source === 'approved_exception') {
      let formula: Record<string, unknown> | null = null;
      const st = d.pricing_settings_version === null ? null : await settingsByVersion(db, d.pricing_settings_version);
      if (st && d.category && d.bin_cents !== null) {
        const r = computePlan({ category: d.category, grade: d.price_grade, binCents: d.bin_cents, floorCents: d.floor_cents, walkawayCents: d.walkaway_cents, exception: true, mode: 'hybrid' }, st);
        if (r.ok && r.plan.formula) formula = priceValues({ bin_cents: d.bin_cents, floor_cents: r.plan.formula.floorCents, walkaway_cents: r.plan.formula.walkawayCents });
      }
      add('PRICING_EXCEPTION', 'info', `${d.domain} is priced by an approved exception, not the formula.`, d.domain, {
        settings_version: d.pricing_settings_version, stored: priceValues(d), formula,
      });
    }
  }

  // export staleness
  if (pending.size > 0) {
    const since = new Date(now.getTime() - 7 * DAY);
    const up = await db.selectFrom('export_uploads').select('id').where('venue', '=', 'afternic').where('uploaded_at', '>=', since).limit(1).executeTakeFirst();
    if (!up) add('EXPORT_STALE', 'warn', 'No confirmed Afternic upload in the last 7 days while listings have changed.', undefined, { pending: [...pending] });
  }

  // manual removal task (PR-27): names that went live in a confirmed file and whose removal no confirmed file asked for
  const venuesBy = new Map<string, string[]>();
  for (const v of VENUES) for (const name of await manualDelist(db, v)) venuesBy.set(name, [...(venuesBy.get(name) ?? []), v]);
  const statusByName = new Map(domains.map((d) => [d.domain, d.status]));
  for (const [name, venues] of [...venuesBy].sort((a, b) => a[0].localeCompare(b[0]))) {
    const status = statusByName.get(name)!;
    add('MANUAL_DELIST', 'warn', `Remove the listing at ${venues.join(', ')} (the name is ${status})`, name, { status, venues });
  }

  // purchases
  const purchases = await db.selectFrom('purchases').select(['id', 'domain', 'state', 'dry_run']).where('state', 'in', ['unknown', 'succeeded']).orderBy('id').execute();
  for (const p of purchases) {
    if (p.state === 'unknown') {
      add('PURCHASE_UNKNOWN', 'error', `The purchase of ${p.domain} is in an unknown state; the reconciler or Dvir must resolve it.`, p.domain, { purchase_id: p.id });
      continue;
    }
    if (p.dry_run) continue;
    const rec = await db.selectFrom('receipts').select('id').where('purchase_id', '=', p.id).limit(1).executeTakeFirst();
    if (!rec) add('RECEIPT_MISSING', 'warn', `The purchase of ${p.domain} has no receipt on file.`, p.domain, { purchase_id: p.id });
    const dom = domains.find((d) => d.domain === p.domain);
    if (dom) {
      const ev = await db.selectFrom('pricing_evidence').select('id').where('domain_id', '=', dom.id).limit(1).executeTakeFirst();
      if (!ev) add('POST_BUY_INCOMPLETE', 'warn', `${p.domain} was bought without pricing evidence (comps); add the sell plan.`, p.domain, { purchase_id: p.id });
    }
  }

  // price events
  const failed = await db.selectFrom('price_schedule').select(['domain_id', 'event', 'due_on', 'note']).where('status', '=', 'failed').orderBy('domain_id').orderBy('due_on').execute();
  const failedBy = new Map<number, typeof failed>();
  for (const f of failed) failedBy.set(f.domain_id, [...(failedBy.get(f.domain_id) ?? []), f]);
  for (const [id, evs] of failedBy) {
    const d = domains.find((x) => x.id === id);
    if (!d || d.status === 'sold' || d.status === 'dropped') continue;
    add('PRICE_EVENT_FAILED', 'error', `${d.domain}: ${evs.length} scheduled price event(s) failed.`, d.domain, { events: evs.map((e) => ({ event: e.event, due_on: e.due_on, note: e.note })) });
  }

  // offers
  const cutoff = new Date(now.getTime() - 48 * DAY / 24);
  const offers = await db.selectFrom('offers').select(['id', 'domain_id', 'amount_cents', 'source', 'created_at', 'outcome'])
    .where('routing', '=', 'dvir').where('outcome', 'in', ['open', 'countered']).where('created_at', '<', cutoff).orderBy('created_at').orderBy('id').execute();
  for (const o of offers) {
    const d = nameOf.get(o.domain_id);
    if (statusOf.get(o.domain_id) === 'sold' || statusOf.get(o.domain_id) === 'dropped') continue;
    add('OFFER_NEEDS_DVIR', 'warn', `An offer of ${pair('amount', o.amount_cents).amount} on ${d} has waited over 48 hours for Dvir.`, d, {
      offer_id: o.id, ...pair('amount', o.amount_cents), source: o.source, outcome: o.outcome, logged_at: toJerusalemIso(o.created_at),
    });
  }
  return out.sort((a, b) => RANK[a.level] - RANK[b.level] || a.code.localeCompare(b.code) || (a.domain ?? '').localeCompare(b.domain ?? ''));
}
