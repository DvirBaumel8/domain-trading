import { pair } from '../../../core/money.js';
import { sql, type Kysely } from 'kysely';
import { idtDay, toJerusalemIso } from '../../../core/dates.js';
import type { Database, DomainRow } from '../../../db/types.js';
import { computePlan } from '../../listing/index.js';
import { settingsByVersion } from '../../listing/index.js';
import { manualDelist, pendingDomains, sameNsSet, VENUES } from '../../listing/index.js';
import { datasaveStatus, missingDays } from '../datasave-state.js';
import { marketDqStatus } from '../market-dq-state.js';
import { dailyScheduleState, JOBS_OVERDUE_HOURS, JOB_RUN_STUCK_HOURS, jobsOverdue } from '../job-runs.js';
import { daysBetween } from '../../candidates/index.js';
import { activeSelectionSettings } from '../../selection/index.js';
import { priceValues } from './money.js';
import { lifecycleWarnings } from './lifecycle.js';
import { ownershipWarnings } from './ownership.js';
import { afternicWarnings } from './afternic.js';
import { renewalSignals, RENEWAL_SIGNAL_WARN_DAYS } from './renewal-signal.js';

export type WarningLevel = 'info' | 'warn' | 'error';
export interface ReportWarning { code: string; level: WarningLevel; domain?: string; message: string; details: Record<string, unknown> }

const LIVE = ['owned', 'listed', 'delisted'] as const;
const DAY = 86_400_000;
/** LANDER_DOWN turns from warn to error when the lander failed on this many different IDT days in a row (CR-007 G-5). */
const LANDER_DOWN_ERROR_DAYS = 2;
/** v3.9.0: PURCHASE_UNRESOLVED is raised for a register_sent/unknown purchase open longer than this (the reconciler never fails one itself). */
const PURCHASE_UNRESOLVED_MINUTES = 30;
/** v3.9.0: Neon's free plan stores 1 GB per project (5.13.0; it was 0.5 GB); DB_SIZE_HIGH is raised above DB_SIZE_WARN_PERCENT of it. */
export const NEON_FREE_STORAGE_BYTES = 1024 ** 3;
export const DB_SIZE_WARN_PERCENT = 70;
/** v5.1.0: DAILY_JOB_MISSED is raised when no scheduled daily job run started in this many hours (once any job run exists). */
const DAILY_JOB_MISSED_HOURS = 26;
/** v5.7.0: ENDING_REGISTERED is raised for an event this recent. */
const ENDING_REGISTERED_DAYS = 30;
/** v5.50.0 (P8): DROP_FEED_STALE stays info from this many days without a drop list. */
const DROP_FEED_IDLE_DAYS = 14;
const RANK: Record<WarningLevel, number> = { error: 0, warn: 1, info: 2 };

/** `opts.domains` / `opts.pendingAfternic`: rows the caller already loaded for the same report (loadReportDomains, pendingDomains(db, 'afternic')). */
export async function buildWarnings(db: Kysely<Database>, now: Date, opts: { storageLimitBytes?: number; domains?: DomainRow[]; pendingAfternic?: Set<string> } = {}): Promise<ReportWarning[]> {
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
  // CR-016 R-A3: a daily run left open, and a scheduled slot nobody ran.
  const sched = await dailyScheduleState(db, now.getTime());
  if (sched.stuck) {
    add('JOB_RUN_INCOMPLETE', 'error', `A daily job run has been queued or running for over ${JOB_RUN_STUCK_HOURS} hours.`, undefined, {
      run_id: sched.stuck.runId, started_at: toJerusalemIso(sched.stuck.startedAt), open_steps: sched.stuck.openSteps,
    });
  }
  if (sched.missed) {
    add('JOB_MISSED', 'error', 'The scheduled daily run (00:05 UTC) did not start.', undefined, {
      slot: toJerusalemIso(sched.missed.slot), last_run_at: sched.missed.lastRunAt ? toJerusalemIso(sched.missed.lastRunAt) : null,
    });
  }
  // CR-071 R-6: the daily data save (15:00 UTC job). Raised once a save or a datasave run exists; Dynadot (not_configured) never counts.
  const ds = await datasaveStatus(db, now.getTime());
  if (ds.started && ds.state !== 'ok') {
    const to = new Date(now.getTime() - 16 * 3_600_000).toISOString().slice(0, 10); // today's data date is due after 15:00 UTC plus the retry hour
    const from = new Date(now.getTime() - 13 * 86_400_000).toISOString().slice(0, 10);
    const first = (await db.selectFrom('snapshot_manifests').select((eb) => eb.fn.min('data_date').as('d')).where('source', '=', 'godaddy_inventory').executeTakeFirst())?.d ?? from;
    const days = await missingDays(db, first > from ? first : from, to);
    add('DATASAVE_MISSED', ds.state === 'partial' ? 'warn' : 'error', `The daily data save is ${ds.state}: ${ds.state === 'partial' ? 'some files' : 'no complete save'} within the last 26 hours.${ds.dynadot_missing.length ? ` No sealed bot upload for ${ds.dynadot_due_date}: ${ds.dynadot_missing.join(', ')}.` : ''}`, undefined, {
      state: ds.state, sources: ['godaddy_inventory', ...ds.dynadot_missing], missing_files: ds.missing_files, missing_days: days.missing.map((m) => m.date),
      dynadot_missing: ds.dynadot_missing.map((source) => ({ source, data_date: ds.dynadot_due_date })),
      last_complete_at: ds.last_complete_at ? toJerusalemIso(ds.last_complete_at) : null,
    });
  }
  // v5.23.0 (CR-075 R-3): a failed market data-quality check is never silent.
  const dq = await marketDqStatus(db);
  if (dq.state === 'alert') {
    add('DQ_MARKET_FAIL', 'error', `The market data-quality check failed: ${dq.failed_checks.join(', ')}.`, undefined, {
      checks: dq.failed_checks, failures: dq.failures, checked_at: dq.checked_at ? toJerusalemIso(dq.checked_at) : null, see: 'GET /market/dq',
    });
  }
  // v5.1.0: the cron itself. A manual or CLI daily does not count; a fresh install with no job run at all is not warned.
  const anyRun = await db.selectFrom('job_runs').select('id').limit(1).executeTakeFirst();
  if (anyRun) {
    const lastScheduled = await db.selectFrom('job_runs').select(({ fn }) => fn.max('started_at').as('at')).where('job', '=', 'daily').where('trigger', '=', 'scheduled').executeTakeFirst();
    const at = lastScheduled?.at ?? null;
    if (at === null || now.getTime() - at.getTime() > DAILY_JOB_MISSED_HOURS * 3_600_000) {
      add('DAILY_JOB_MISSED', 'warn', `No scheduled daily job run has started in the last ${DAILY_JOB_MISSED_HOURS} hours.`, undefined, {
        last_scheduled_at: at ? toJerusalemIso(at) : null, hours_since: at ? Math.round((now.getTime() - at.getTime()) / 360_000) / 10 : null,
      });
    }
  }
  // v3.9.0: the database against Neon's free storage (1 GB)
  const limit = opts.storageLimitBytes ?? NEON_FREE_STORAGE_BYTES;
  const size = Number((await sql<{ n: string }>`select pg_database_size(current_database())::text as n`.execute(db)).rows[0]!.n);
  if (size > limit * DB_SIZE_WARN_PERCENT / 100) {
    add('DB_SIZE_HIGH', 'warn', `The database is ${(size / 1024 ** 2).toFixed(0)} MB, over ${DB_SIZE_WARN_PERCENT}% of the ${(limit / 1024 ** 2).toFixed(0)} MB free-plan limit.`, undefined, {
      size_bytes: size, limit_bytes: limit, percent: Math.round(size * 1000 / limit) / 10, warn_percent: DB_SIZE_WARN_PERCENT,
    });
  }
  const domains = opts.domains ?? await db.selectFrom('domains').selectAll().where('status', '!=', 'pending_purchase').orderBy('domain').execute();
  const nameOf = new Map(domains.map((d) => [d.id, d.domain]));
  const statusOf = new Map(domains.map((d) => [d.id, d.status]));
  const registrarOf = new Map(domains.map((d) => [d.id, d.registrar]));
  const live = (s: string) => (LIVE as readonly string[]).includes(s);

  // v5.44.0: an S8 name (an aftermarket buy) not yet seen at the registrar it was imported into. The old owner can still redeem a won auction name, so do not list it before RDAP shows it
  // at our registrar. The daily portfolioCheck step re-checks it until transfer_confirmed is true.
  for (const dm of domains) {
    if (dm.lane !== 'S8' || dm.transfer_confirmed === true || !live(dm.status)) continue;
    add('S8_TRANSFER_UNCONFIRMED', 'warn', `${dm.domain}: the transfer to ${dm.registrar ?? 'the registrar'} is not confirmed by RDAP yet; do not list it until the transfer is complete.`, dm.domain, {
      transfer_confirmed: dm.transfer_confirmed ?? null, registrar: dm.registrar, checked_at: dm.transfer_checked_at ? toJerusalemIso(dm.transfer_checked_at) : null,
    });
  }

  // daily portfolio checks (CR-007 G-5): the latest row of each kind that is NOT unknown decides (an unknown never clears nor raises)
  const latestChecks = await sql<{ domain_id: number; kind: string; status: string; at: Date; details: Record<string, any> }>`
    select distinct on (domain_id, kind) domain_id, kind, status, at, details from portfolio_checks
    where status <> 'unknown' order by domain_id, kind, id desc`.execute(db);
  for (const c of latestChecks.rows) {
    const d = nameOf.get(Number(c.domain_id));
    const st = statusOf.get(Number(c.domain_id));
    if (d === undefined || st === undefined || !live(st)) continue;
    const checkedAt = toJerusalemIso(c.at);
    if (c.kind === 'price') {
      // v4.0.0 (CR-049 item 3): the Buy Now amount the lander shows against the plan's BIN, and the make-offer option
      if (st !== 'listed') continue;
      if (c.status === 'fail') {
        add('LANDER_PRICE_MISMATCH', 'warn', `${d}: the lander shows a Buy Now price that is not the plan's BIN.`, d, {
          checked_at: checkedAt, ...pair('shown', c.details.shown_cents ?? 0), ...pair('expected', c.details.expected_cents ?? 0),
        });
      }
      if (c.details.make_offer_expected === true && c.details.make_offer_shown === false) {
        add('LANDER_OFFER_MISSING', 'info', `${d}: the plan has a make-offer option but the lander page shows none.`, d, { checked_at: checkedAt });
      }
      continue;
    }
    if (c.status !== 'fail') continue;
    if (c.kind === 'registry') {
      // v5.58.0 (CR-079): a hold / redemption / pending-delete status alone (the ledger shows the name live and not on hold) is a warn; a missing registration, another registrar or another expiry stays an error
      const diffs = (c.details.differences ?? []) as { field?: string }[];
      const holdOnly = diffs.length > 0 && diffs.every((x) => x.field === 'status');
      add('REGISTRY_MISMATCH', holdOnly ? 'warn' : 'error', `${d}: the registry does not agree with our record.`, d, { checked_at: checkedAt, differences: c.details.differences ?? [] });
    } else if (c.kind === 'blocklist') {
      add('OWNED_NAME_BLOCKLISTED', 'error', `${d} is listed on a blocklist.`, d, { checked_at: checkedAt, sources: c.details.sources ?? [] });
    } else if (c.kind === 'web' && st === 'listed') {
      // v3.7.0 (CR-033 G-8): until a confirmed Afternic upload covers the name, a failing lander is expected (info); the LANDER_DOWN clock starts at the first confirmed upload
      let firstUpload: Date | null = null;
      if (domains.find((x) => x.id === Number(c.domain_id))?.lander === 'afternic') {
        const u = await sql<{ at: Date | null }>`
          select min(u.uploaded_at) as at from export_uploads u join export_runs r on r.export_id = u.export_id where u.venue = 'afternic' and ${d} = any(r.domains)`.execute(db);
        firstUpload = u.rows[0]?.at ?? null;
        if (firstUpload === null) {
          add('LANDER_AWAITING_MARKETPLACE', 'info', `${d}: the for-sale lander does not answer yet; the name has not been listed at Afternic (no confirmed upload).`, d, {
            checked_at: checkedAt, status_code: c.details.status_code ?? null, reason: c.details.reason ?? null,
          });
          continue;
        }
      }
      const recent = (await sql<{ status: string; at: Date }>`
        select status, at from portfolio_checks where domain_id = ${c.domain_id} and kind = 'web' and status <> 'unknown'
          ${firstUpload ? sql`and at >= ${firstUpload}` : sql``} order by id desc limit 400`.execute(db)).rows;
      if (recent.length === 0 || recent[0]!.status !== 'fail') continue;
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

  // v3.7.0 (CR-033 G-6): the registrar-side state read by the daily registrarCheck (latest row per name)
  const regState = await sql<{ domain: string; checked_at: Date; auto_renew: boolean | null; privacy: boolean | null; ns: string[] | null }>`
    select distinct on (domain) domain, checked_at, auto_renew, privacy, ns from registrar_state_checks order by domain, id desc`.execute(db);
  const byName = new Map(domains.map((d) => [d.domain, d]));
  // v5.50.0 (P8): a name with an active visit forward (CR-068) reaches the lander through the forward, so its stored lander_ns is stale by design
  // (visits/store.ts isCountable) and nothing is reported about its nameserver state (NS_UNVERIFIED, REGISTRAR_DRIFT `nameservers`). Privacy drift still counts.
  const forwarded = new Set((await db.selectFrom('visit_forwards').select('domain').where('reverted_at', 'is', null).execute()).map((r) => r.domain));
  for (const r of regState.rows) {
    const d = byName.get(r.domain);
    if (!d || !live(d.status)) continue;
    const checkedAt = toJerusalemIso(r.checked_at);
    if (r.auto_renew === true) {
      add('AUTO_RENEW_ON', 'error', `${d.domain}: auto-renew is ON at ${d.registrar}; turn it off in the registrar dashboard (a renewal there is billed outside the cap).`, d.domain, { registrar: d.registrar, checked_at: checkedAt });
    }
    const drift: string[] = [];
    if (r.privacy === false) drift.push('privacy_off');
    if (!forwarded.has(d.domain) && r.ns !== null && d.lander_ns !== null && !sameNsSet(r.ns, d.lander_ns)) drift.push('nameservers');
    if (drift.length > 0) {
      add('REGISTRAR_DRIFT', 'warn', `${d.domain}: the registrar state differs from the plan (${drift.join(', ')}).`, d.domain, { drift, privacy: r.privacy, ns: r.ns, lander_ns: d.lander_ns, checked_at: checkedAt });
    }
  }

  // drop lists (CR-007 §22 G-2, v3.3.0 CR-023 G): once any list exists, the newest one must not be more than intake.drop_feed_stale_days old (default 7); the level is
  // intake.drop_feed_stale_level (default info: it never counts as a warning). days 2 and level warn restore the old behaviour.
  const newest = await sql<{ d: string | null }>`select max(list_date)::text as d from drop_lists`.execute(db);
  const newestDate = newest.rows[0]?.d ?? null;
  const feed = (await activeSelectionSettings(db)).values.intake;
  if (newestDate !== null && daysBetween(newestDate, today) > feed.drop_feed_stale_days) {
    const list = await db.selectFrom('drop_lists').select('name').where('list_date', '=', newestDate).orderBy('created_at', 'desc').limit(1).executeTakeFirst();
    // v5.50.0 (P8): 14 or more days without a list means the drop-list side line is idle, not broken: info whatever the setting says (a `warn` setting applies below 14 days)
    const idle = daysBetween(newestDate, today) >= DROP_FEED_IDLE_DAYS;
    add('DROP_FEED_STALE', idle ? 'info' : feed.drop_feed_stale_level, `The newest drop list is from ${newestDate}; upload today's list.`, undefined, { newest_list: list?.name ?? null, newest_list_date: newestDate });
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
  const pending = opts.pendingAfternic ?? new Set(await pendingDomains(db, 'afternic'));
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
    if (d.lander_ns && d.ns_verified_at === null && !forwarded.has(d.domain) && (d.status === 'owned' || d.status === 'listed')) {
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
    // v5.50.0 (P8): FLOOR_AUTO_ACCEPT is no longer a /report warning (it fired for every hybrid name by design); POST /list and /pricing/preview still return it at plan time.
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
        const r = computePlan({ category: d.category, grade: d.price_grade, binCents: d.bin_cents, floorCents: d.floor_cents, walkawayCents: d.walkaway_cents, exception: true, mode: 'hybrid', s8: d.lane === 'S8' }, st);
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
  // v3.9.0: POST_BUY_INCOMPLETE = a /buy purchase whose name has no screening pack (comps are optional since pricing v3); imports have no purchase row
  const withPack = new Set<string>();
  const packNames = purchases.filter((p) => p.state === 'succeeded' && !p.dry_run).map((p) => p.domain);
  if (packNames.length > 0) for (const r of await db.selectFrom('screening_packs').select('domain').distinct().where('domain', 'in', packNames).execute()) withPack.add(r.domain);
  for (const p of purchases) {
    if (p.state === 'unknown') {
      add('PURCHASE_UNKNOWN', 'error', `The purchase of ${p.domain} is in an unknown state; the reconciler or Dvir must resolve it.`, p.domain, { purchase_id: p.id });
      continue;
    }
    if (p.dry_run) continue;
    if (!withReceipt.has(p.id)) add('RECEIPT_MISSING', 'warn', `The purchase of ${p.domain} has no receipt on file.`, p.domain, { purchase_id: p.id });
    if (domainByName.has(p.domain) && !withPack.has(p.domain)) {
      add('POST_BUY_INCOMPLETE', 'warn', `${p.domain} was bought without a screening pack on file.`, p.domain, { purchase_id: p.id });
    }
  }
  // v3.9.0 (Dvir, 10 Oct 2026): the reconciler never fails an open purchase; resolution is the admin resolve-purchase command after checking the registrar account
  const open = await db.selectFrom('purchases').select(['id', 'domain', 'state', 'created_at']).where('state', 'in', ['register_sent', 'unknown']).where('dry_run', '=', false)
    .where('created_at', '<', new Date(now.getTime() - PURCHASE_UNRESOLVED_MINUTES * 60_000)).orderBy('id').execute();
  for (const p of open) {
    const ageMinutes = Math.floor((now.getTime() - p.created_at.getTime()) / 60_000);
    add('PURCHASE_UNRESOLVED', 'warn', `The purchase of ${p.domain} (${p.state}) has been open for ${ageMinutes} minutes; check the registrar account, then resolve it (admin resolve-purchase).`, p.domain, {
      purchase_id: p.id, state: p.state, age_minutes: ageMinutes, created_at: toJerusalemIso(p.created_at),
    });
  }

  // v5.58.0 (CR-079): the missing-name check (listing record, listing approval, unconfirmed sightings, receipt pointer); the daily step ownershipCheck reads this same list
  await ownershipWarnings(db, domains, add);
  await afternicWarnings(db, domains, now, add);
  // v5.65.0 (F44): advice only; Dvir decides every renewal
  for (const [name, sg] of await renewalSignals(db, now, domains)) {
    if (sg.signal === 'drop' && sg.days_to_expiry !== null && sg.days_to_expiry >= 0 && sg.days_to_expiry <= RENEWAL_SIGNAL_WARN_DAYS) {
      add('RENEWAL_SIGNAL_DROP', 'info', `${name} expires in ${sg.days_to_expiry} days and shows no buyer interest (${sg.reason}); the signal is to drop it. Dvir decides every renewal.`, name, { days_to_expiry: sg.days_to_expiry, views_30d: sg.views_30d, leads_30d: sg.leads_30d });
    }
  }

  // v4.0.0: renewal drop check, horizon, delist after a sale
  await lifecycleWarnings(db, now, today, domains, add);
  // v5.7.0 (CR-058): another ending of an owned name was registered (or re-registered) after we bought it; a possible buyer. One warning per event, for 30 days.
  const endingEvents = await db.selectFrom('owned_ending_events').select(['domain', 'tld', 'kind', 'created_at_registry', 'registrar', 'created_at'])
    .where('kind', '<>', 'baseline').where('created_at', '>', new Date(now.getTime() - ENDING_REGISTERED_DAYS * DAY)).orderBy('id').execute();
  for (const e of endingEvents) {
    const host = `${e.domain.slice(0, -4)}.${e.tld}`;
    add('ENDING_REGISTERED', 'warn', `${host} was ${e.kind === 'newly_registered' ? 'newly registered' : 're-registered'} while we hold ${e.domain}; the registrant is a possible buyer (nothing is sent automatically).`, e.domain, {
      owned_domain: e.domain, host, created: e.created_at_registry ? toJerusalemIso(e.created_at_registry) : null, registrar: e.registrar, kind: e.kind, detected_at: toJerusalemIso(e.created_at),
    });
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
