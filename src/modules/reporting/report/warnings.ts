import { pair } from '../../../core/money.js';
import { sql, type Kysely } from 'kysely';
import { idtDay, toJerusalemIso } from '../../../core/dates.js';
import type { Database } from '../../../db/types.js';
import { computePlan } from '../../listing/index.js';
import { settingsByVersion } from '../../listing/index.js';
import { manualDelist, pendingDomains, VENUES } from '../../listing/index.js';
import { JOBS_OVERDUE_HOURS, jobsOverdue } from '../job-runs.js';
import { DROP_FEED_STALE_DAYS, daysBetween } from '../../candidates/index.js';
import { priceValues } from './money.js';

export type WarningLevel = 'info' | 'warn' | 'error';
export interface ReportWarning { code: string; level: WarningLevel; domain?: string; message: string; details: Record<string, unknown> }

const LIVE = ['owned', 'listed', 'delisted'] as const;
const DAY = 86_400_000;
/** LANDER_DOWN turns from warn to error when the lander failed on this many different IDT days in a row (CR-007 G-5). */
export const LANDER_DOWN_ERROR_DAYS = 2;
/** REVIEW_OVERDUE is raised when the newest review feedback is older than this (CR-011 part B). */
export const REVIEW_OVERDUE_HOURS = 36;
const RANK: Record<WarningLevel, number> = { error: 0, warn: 1, info: 2 };

export async function buildWarnings(db: Kysely<Database>, now: Date): Promise<ReportWarning[]> {
  const out: ReportWarning[] = [];
  const add = (code: string, level: WarningLevel, message: string, domain?: string, details: Record<string, unknown> = {}) =>
    out.push({ code, level, ...(domain ? { domain } : {}), message, details });
  const today = idtDay(now);

  // CR-005 N-2: the schedule itself. A manual daily run counts; a tick or a skipped overlap does not.
  const overdue = await jobsOverdue(db, now.getTime());
  if (overdue.overdue) {
    add('JOB_OVERDUE', 'error', `No daily job run has finished in the last ${JOBS_OVERDUE_HOURS} hours.`, undefined, {
      job: 'daily', last_run_at: overdue.lastRunAt ? toJerusalemIso(overdue.lastRunAt) : null, expected_every: '24h',
    });
  }
  // CR-011 part B: once any review feedback exists, the newest must not be older than REVIEW_OVERDUE_HOURS.
  const lastFeedback = await db.selectFrom('review_feedback').select('created_at').orderBy('created_at', 'desc').limit(1).executeTakeFirst();
  if (lastFeedback && now.getTime() - lastFeedback.created_at.getTime() > REVIEW_OVERDUE_HOURS * 3_600_000) {
    add('REVIEW_OVERDUE', 'warn', `No review feedback has been recorded for over ${REVIEW_OVERDUE_HOURS} hours.`, undefined, { last_feedback_at: toJerusalemIso(lastFeedback.created_at) });
  }
  const domains = await db.selectFrom('domains').selectAll().where('status', '!=', 'pending_purchase').orderBy('domain').execute();
  const nameOf = new Map(domains.map((d) => [d.id, d.domain]));
  const statusOf = new Map(domains.map((d) => [d.id, d.status]));
  const registrarOf = new Map(domains.map((d) => [d.id, d.registrar]));
  const live = (s: string) => (LIVE as readonly string[]).includes(s);

  // daily portfolio checks (CR-007 G-5): the latest row of each kind that is NOT unknown decides (an unknown never clears nor raises)
  const latestChecks = await sql<{ domain_id: number; kind: string; status: string; at: Date; details: Record<string, any> }>`
    select distinct on (domain_id, kind) domain_id, kind, status, at, details from portfolio_checks
    where status <> 'unknown' order by domain_id, kind, id desc`.execute(db);
  for (const c of latestChecks.rows) {
    const d = nameOf.get(Number(c.domain_id));
    const st = statusOf.get(Number(c.domain_id));
    if (d === undefined || st === undefined || !live(st) || c.status !== 'fail') continue;
    const checkedAt = toJerusalemIso(c.at);
    if (c.kind === 'registry') {
      add('REGISTRY_MISMATCH', 'error', `${d}: the registry does not agree with our record.`, d, { checked_at: checkedAt, differences: c.details.differences ?? [] });
    } else if (c.kind === 'blocklist') {
      add('OWNED_NAME_BLOCKLISTED', 'error', `${d} is listed on a blocklist.`, d, { checked_at: checkedAt, sources: c.details.sources ?? [] });
    } else if (c.kind === 'web' && st === 'listed') {
      const recent = (await sql<{ status: string; at: Date }>`
        select status, at from portfolio_checks where domain_id = ${c.domain_id} and kind = 'web' and status <> 'unknown' order by id desc limit 400`.execute(db)).rows;
      let streak = 0;
      while (streak < recent.length && recent[streak]!.status === 'fail') streak++;
      const since = recent[streak - 1]!.at;
      const days = new Set(recent.slice(0, streak).map((r) => idtDay(r.at)));
      const twoFails = streak >= 2 && idtDay(recent[0]!.at) !== idtDay(recent[1]!.at);
      add('LANDER_DOWN', twoFails && days.size >= LANDER_DOWN_ERROR_DAYS ? 'error' : 'warn', `${d}: the for-sale lander is not answering as expected.`, d, {
        checked_at: checkedAt, since: toJerusalemIso(since), status_code: c.details.status_code ?? null, reason: c.details.reason ?? null,
      });
    }
  }

  // drop lists (CR-007 §22 G-2): once any list exists, the newest one must not be more than DROP_FEED_STALE_DAYS old
  const newest = await sql<{ d: string | null }>`select max(list_date)::text as d from drop_lists`.execute(db);
  const newestDate = newest.rows[0]?.d ?? null;
  if (newestDate !== null && daysBetween(newestDate, today) > DROP_FEED_STALE_DAYS) {
    const list = await db.selectFrom('drop_lists').select('name').where('list_date', '=', newestDate).orderBy('created_at', 'desc').limit(1).executeTakeFirst();
    add('DROP_FEED_STALE', 'warn', `The newest drop list is from ${newestDate}; upload today's list.`, undefined, { newest_list: list?.name ?? null, newest_list_date: newestDate });
  }

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

  // domains
  const pending = new Set(await pendingDomains(db, 'afternic'));
  // batched lookups for the per-row rules below (no query inside the loop)
  const heldIds = domains.filter((d) => d.pricing_hold).map((d) => d.id);
  const lastHistoryAt = new Map<number, Date>(); // newest listing_history row (by id) of each held name
  if (heldIds.length > 0) {
    const r = await sql<{ domain_id: number; at: Date }>`select distinct on (domain_id) domain_id, at from listing_history where domain_id in (${sql.join(heldIds)}) order by domain_id, id desc`.execute(db);
    for (const x of r.rows) lastHistoryAt.set(x.domain_id, x.at);
  }
  const exceptionVersions = [...new Set(domains.filter((d) => d.pricing_source === 'approved_exception' && d.pricing_settings_version !== null).map((d) => d.pricing_settings_version!))];
  const settingsOf = new Map<number, Awaited<ReturnType<typeof settingsByVersion>>>();
  for (const v of exceptionVersions) settingsOf.set(v, await settingsByVersion(db, v));
  for (const d of domains) {
    if (d.lander_ns && d.ns_verified_at === null && (d.status === 'owned' || d.status === 'listed')) {
      add('NS_UNVERIFIED', 'warn', `${d.domain}: the nameservers are not verified as the lander's.`, d.domain, { lander: d.lander, lander_ns: d.lander_ns });
    }
    // unreachable under the domains_category_once_owned CHECK; kept as a defensive rule
    if (d.lander_pending && (d.status === 'owned' || d.status === 'listed')) {
      add('LANDER_PENDING', 'info', `${d.domain} is listed with no lander yet (listed with lander "none"); call POST /list with a lander when the nameservers should change.`, d.domain, { lander: null });
    }
    if (live(d.status) && (d.registrar_api === 'none' || d.registrar === 'godaddy')) {
      add('AUTO_RENEW_UNCONFIRMED', 'info', `${d.domain}: the service can't read auto-renew at ${d.registrar}; check it is OFF in the ${d.registrar} dashboard (a renewal there is billed outside the cap).`, d.domain, { registrar: d.registrar, registrar_api: d.registrar_api });
    }
    if (d.status === 'listed' && d.category === null) add('CATEGORY_MISSING', 'warn', `${d.domain} is listed without a category.`, d.domain);
    const dropsAtFirstExpiry = d.drop_date !== null && d.drop_date === d.expiry_date; // no renewal is planned, so no renewal price is needed
    if (d.renewals_used === 0 && d.renewal_price_cents === null && d.status !== 'sold' && d.status !== 'dropped' && !dropsAtFirstExpiry) {
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
      const since = lastHistoryAt.get(d.id) ?? d.updated_at;
      if (now.getTime() - since.getTime() > 30 * DAY) {
        add('HOLD_STALE', 'warn', `${d.domain}: the pricing hold has been on since ${toJerusalemIso(since)} (over 30 days).`, d.domain, { reason: d.pricing_hold_reason, since: toJerusalemIso(since) });
      }
    }
    if (d.pricing_source === 'approved_exception') {
      let formula: Record<string, unknown> | null = null;
      const st = d.pricing_settings_version === null ? null : settingsOf.get(d.pricing_settings_version) ?? null;
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

  // manual removal task (PR-27): names first listed before the venue's last confirmed file whose status changed after that file's snapshot
  const venuesBy = new Map<string, string[]>();
  for (const v of VENUES) for (const name of await manualDelist(db, v)) venuesBy.set(name, [...(venuesBy.get(name) ?? []), v]);
  const statusByName = new Map(domains.map((d) => [d.domain, d.status]));
  for (const [name, venues] of [...venuesBy].sort((a, b) => a[0].localeCompare(b[0]))) {
    const status = statusByName.get(name)!;
    add('MANUAL_DELIST', 'warn', `Remove the listing at ${venues.join(', ')} (the name is ${status})`, name, { status, venues });
  }

  // purchases
  const purchases = await db.selectFrom('purchases').select(['id', 'domain', 'state', 'dry_run']).where('state', 'in', ['unknown', 'succeeded']).orderBy('id').execute();
  const buyIds = purchases.filter((p) => p.state === 'succeeded' && !p.dry_run).map((p) => p.id);
  const withReceipt = new Set<number>();
  if (buyIds.length > 0) for (const r of await db.selectFrom('receipts').select('purchase_id').distinct().where('purchase_id', 'in', buyIds).execute()) withReceipt.add(r.purchase_id as number);
  const domainByName = new Map(domains.map((d) => [d.domain, d]));
  const withEvidence = new Set<number>();
  const evDomainIds = purchases.filter((p) => p.state === 'succeeded' && !p.dry_run).map((p) => domainByName.get(p.domain)?.id).filter((x): x is number => x !== undefined);
  if (evDomainIds.length > 0) for (const r of await db.selectFrom('pricing_evidence').select('domain_id').distinct().where('domain_id', 'in', evDomainIds).execute()) withEvidence.add(r.domain_id as number);
  for (const p of purchases) {
    if (p.state === 'unknown') {
      add('PURCHASE_UNKNOWN', 'error', `The purchase of ${p.domain} is in an unknown state; the reconciler or Dvir must resolve it.`, p.domain, { purchase_id: p.id });
      continue;
    }
    if (p.dry_run) continue;
    if (!withReceipt.has(p.id)) add('RECEIPT_MISSING', 'warn', `The purchase of ${p.domain} has no receipt on file.`, p.domain, { purchase_id: p.id });
    const dom = domainByName.get(p.domain);
    if (dom) {
      const ev = withEvidence.has(dom.id);
      // an imported legacy_no_comps name has an evidence row (comps null + legacy reason): that is complete, not "incomplete"
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
