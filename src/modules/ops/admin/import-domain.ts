import { z } from 'zod';
import type { Kysely } from 'kysely';
import type { Category, Database } from '../../../db/types.js';
import { AppError } from '../../../http/errors.js';
import { newAuditId } from '../../../http/audit.js';
import { addOneYear, idtDay, isRealDate } from '../../../core/dates.js';
import { centsToDollarsOrNull, formatUsd, usdStringToCents } from '../../../core/money.js';
import { normalizeDomain } from '../../../domain-name.js';
import { buildSchedule, isV3, priceFormula, s8LadderBin } from '../../listing/index.js';
import { currentSettings } from '../../listing/index.js';
import { RegistrarError, type RegistrarAdapter } from '../../registrars/index.js';
import { activeDomainCount, activeLaneCounts, laneCapBlock } from '../../buying/index.js';
import { registrarApiOf } from '../../buying/index.js';
import { changedColumns } from '../../listing/index.js';
import { isCategory, validateComps, validateListing, type Comp, type ListingPlan, type ListingRequest } from '../../listing/index.js';
import { planView } from '../../listing/index.js';
import { domainPlanColumns, historyRow, writePlan } from '../../listing/index.js';
import { withDomainLock } from '../../../core/locks.js';

/** Bad or missing arguments (the CLI exits 2). Business refusals are AppErrors (exit 1, code in the message). */
export class ImportInputError extends Error {}

/** The comps rule started on 5 Oct 2026: an earlier buy may carry a legacy reason instead of comps (V11). */
export const COMPS_RULE_DATE = '2026-10-05';

export interface ImportInput {
  domain: string; registrar: string; buyDate: string; cost: string; costNote?: string; order?: string; deal?: string;
  category?: string; grade?: string;
  listingMode?: string; bin?: string; floor?: string; walkaway?: string; minOffer?: string;
  pricingException?: string; override?: boolean; overrideReason?: string;
  evidence?: { comps?: unknown; rationale?: unknown } | null; legacyNoComps?: string;
  approvalText?: string; approvalAt?: string;
  manual?: boolean; expiry?: string; renewalPrice?: string; dryRun?: boolean;
  /** v5.8.0 (CR-059): the S8 aftermarket import (POST /portfolio/import). The BIN is the price-list rung for `compsValueCents`; any registrar name is accepted. */
  lane?: 'S8'; s8Source?: string; compsValueCents?: number;
  /** v5.9.0 (CR-060): Dvir's approved BIN and floor (cents, S8 only; the caller has checked the approval names them). */
  binOverrideCents?: number; floorOverrideCents?: number;
  /** v5.8.0: the HTTP audit id; the import then writes no audit row of its own (the audit hook writes it). */
  auditId?: string;
}

export interface ImportResult {
  dry_run?: true; domain: string; status: 'owned' | 'listed'; registrar_api: string; expiry_date: string; drop_date: string;
  listing: object | null; warnings: string[];
  /** v5.8.0 (S8 imports): the lane, the price-list rung chosen from the comps value, and what would refuse the import (a dry run reports it; a real import throws it). */
  lane?: 'S8'; s8?: { source: string; comps_value_cents: number | null; bin_cents: number | null; floor_cents: number | null; bin_source: 'override' | 'ladder' | 'grade_price' | null; floor_source: 'override' | 'formula' | null; s8_names: number; s8_reserved_slots: number; s8_max_price_cents: number };
  would_be_blocked?: 'S8_SLOTS_FULL' | 'DOMAIN_CAP_REACHED' | null;
}

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const DEAL = /^D-\d{3,}$/;

function realDate(label: string, v: string | undefined): string {
  if (!v || !isRealDate(v)) {
    throw new ImportInputError(`${label} must be a real date YYYY-MM-DD`);
  }
  return v;
}

function usd(label: string, v: string | undefined): number | null {
  if (v === undefined) return null;
  try {
    return usdStringToCents(v.trim());
  } catch {
    throw new ImportInputError(`${label} must be a USD amount with at most 2 decimals`);
  }
}

/** Everything that can be decided before touching the DB or a registrar. */
function parseInput(i: ImportInput, now: Date) {
  const domain = normalizeDomain(i.domain);
  if (!i.registrar?.trim()) throw new ImportInputError('--registrar is required');
  const registrar = i.registrar.trim().toLowerCase();
  if (registrar === 'cloudflare') throw new ImportInputError('Cloudflare Registrar is never used (founder rule 5)');
  if (i.lane === 'S8') {
    if (!/^[a-z0-9][a-z0-9.-]{1,40}$/.test(registrar)) throw new ImportInputError('registrar must be a registrar name such as godaddy or dynadot');
  } else if (!['porkbun', 'godaddy', 'other'].includes(registrar)) throw new ImportInputError('--registrar must be porkbun, godaddy or other');
  const manual = i.manual === true;
  if (!manual && registrar === 'other') throw new ImportInputError('--registrar other needs --manual');
  const today = idtDay(now);
  const buyDate = realDate('--buy-date', i.buyDate);
  if (buyDate > today) throw new ImportInputError('--buy-date must not be in the future');
  const costCents = usd('--cost', i.cost);
  if (costCents === null || costCents <= 0) throw new ImportInputError('--cost must be a positive USD amount');
  const renewalCents = usd('--renewal-price', i.renewalPrice);
  if (renewalCents !== null && renewalCents <= 0) throw new ImportInputError('--renewal-price must be a positive USD amount');
  if (i.costNote !== undefined && EMAIL.test(i.costNote)) throw new AppError(422, 'NO_PII', 'The cost note must not contain an email address');
  if (i.deal !== undefined && !DEAL.test(i.deal)) throw new ImportInputError('--deal must look like D-001');
  const order = (i.order ?? 'none').trim();
  if (!order) throw new ImportInputError('--order must not be empty (use none)');
  if (order.includes('@')) throw new AppError(422, 'NO_PII', 'The order reference must not contain an email address or "@"');

  if (!i.category || !isCategory(i.category)) {
    throw new AppError(422, 'CATEGORY_REQUIRED', 'A valid category is required: geo, trend, b2b, collision, regulation, buzzword or other');
  }
  const category: Category = i.category;
  let grade: 'strong' | 'weaker' | null = null;
  if (i.grade !== undefined) {
    if (i.grade !== 'strong' && i.grade !== 'weaker') throw new ImportInputError('--grade must be strong or weaker');
    if (category !== 'geo') throw new AppError(422, 'GRADE_NOT_GEO', '--grade is only for geo names');
    grade = i.grade;
  }
  if (category === 'geo' && !grade) throw new AppError(422, 'GEO_GRADE_REQUIRED', 'Geo names need --grade strong or weaker');

  const hasListing = i.listingMode !== undefined;
  const listingFlags = [i.bin, i.floor, i.walkaway, i.minOffer, i.pricingException, i.overrideReason].some((x) => x !== undefined) || i.override === true;
  if (!hasListing && listingFlags) throw new ImportInputError('listing flags need --listing-mode');
  if (i.pricingException !== undefined && !i.pricingException.trim()) throw new AppError(422, 'EXCEPTION_REASON_REQUIRED', 'A pricing exception needs a reason');
  let listing: ListingRequest | null = null;
  if (hasListing) {
    const dollars = (label: string, v: string | undefined) => { const c = usd(label, v); return centsToDollarsOrNull(c); };
    listing = {
      mode: i.listingMode, bin: dollars('--bin', i.bin), floor: dollars('--floor', i.floor), walkaway: dollars('--walkaway', i.walkaway),
      min_offer: dollars('--min-offer', i.minOffer), pricing_exception: i.pricingException !== undefined, pricing_exception_reason: i.pricingException ?? null,
    };
  }

  // Approval (owner amendment): needed only for an exception or an override; when given it is always validated.
  const hasText = i.approvalText !== undefined;
  const hasAt = i.approvalAt !== undefined;
  if (hasText !== hasAt) throw new ImportInputError('--approval-text and --approval-at go together');
  let approval: { text: string; at: Date } | null = null;
  if (hasText && hasAt) {
    if (!i.approvalText!.trim()) throw new ImportInputError('--approval-text must not be empty');
    if (!z.iso.datetime({ offset: true }).safeParse(i.approvalAt).success) throw new ImportInputError('--approval-at must be ISO 8601 with an offset or Z');
    const at = new Date(i.approvalAt!);
    if (at.getTime() > now.getTime()) throw new ImportInputError('--approval-at must not be in the future');
    approval = { text: i.approvalText!.trim(), at };
  }

  // Comps (D8)
  const legacy = i.legacyNoComps;
  if (legacy !== undefined && i.evidence) throw new ImportInputError('give --comps-file or --legacy-no-comps, not both');
  if (legacy !== undefined) {
    if (!legacy.trim()) throw new ImportInputError('--legacy-no-comps needs a reason');
    if (EMAIL.test(legacy)) throw new AppError(422, 'NO_PII', 'The legacy reason must not contain an email address');
    if (buyDate >= COMPS_RULE_DATE) {
      throw new AppError(422, 'COMPS_REQUIRED', `A buy on or after ${COMPS_RULE_DATE} needs 2-3 comparable sales (--comps-file); --legacy-no-comps is only for earlier buys`);
    }
  }
  // v3.9.0: no comps and no legacy reason is decided against the current pricing settings (comps_min, 0 since pricing v3) in importDomain

  let expiry: string | null = null;
  if (manual) {
    if (!i.expiry) throw new ImportInputError('--manual needs --expiry YYYY-MM-DD');
    expiry = realDate('--expiry', i.expiry);
  } else if (i.expiry !== undefined) expiry = realDate('--expiry', i.expiry);

  return {
    domain, registrar, manual, today, buyDate, lane: i.lane ?? null, costCents, renewalCents, order, category, grade, listing, approval, expiry,
    override: i.override === true, overrideReason: i.overrideReason ?? null, legacy: legacy?.trim() ?? null,
  };
}

export async function importDomain(
  db: Kysely<Database>, input: ImportInput, deps: { adapters: RegistrarAdapter[]; now: Date },
): Promise<ImportResult> {
  const p = parseInput(input, deps.now);
  const now = deps.now;
  const { domain } = p;

  const existing = await db.selectFrom('domains').select('status').where('domain', '=', domain).executeTakeFirst();
  if (existing) throw new AppError(409, 'ALREADY_IN_PORTFOLIO', `${domain} is already in the portfolio as ${existing.status}`, { status: existing.status });

  const warnings: string[] = [];
  const settings = await db.selectFrom('settings').selectAll().executeTakeFirstOrThrow();
  const s = await currentSettings(db, now);

  // v5.8.0 (CR-059): S8 caps. The per-name price cap and the slot reservation come from the settings row (migration only).
  let wouldBeBlocked: 'S8_SLOTS_FULL' | 'DOMAIN_CAP_REACHED' | null = null;
  let s8Listing: ListingRequest | null = null;
  if (p.lane === 'S8') {
    if (p.costCents > settings.s8_max_price_cents) {
      throw new AppError(400, 'S8_PRICE_CAP', `price_paid ${formatUsd(p.costCents)} is over the S8 per-name cap ${formatUsd(settings.s8_max_price_cents)}`,
        { price_paid_cents: p.costCents, s8_max_price_cents: settings.s8_max_price_cents });
    }
    const counts = await activeLaneCounts(db);
    wouldBeBlocked = laneCapBlock('S8', counts, settings);
    if (wouldBeBlocked && !input.dryRun) throw s8CapError(wouldBeBlocked, counts, settings);
    if (!p.listing) {
      if (!isV3(s)) throw new AppError(409, 'PRICING_SETTINGS_NO_PRICE_LIST', 'The current pricing settings have no price list; an S8 BIN comes from the price list');
      if (p.category === 'geo') {
        // geo S8 keeps the CR-059 behaviour: the grade price, strict BIN; CR-060 overrides do not apply to geo
        if (input.binOverrideCents !== undefined || input.floorOverrideCents !== undefined) {
          throw new ImportInputError('bin_override and floor_override do not apply to a geo name (geo is a strict grade-price BIN)');
        }
        s8Listing = { mode: 'bin', bin: (p.grade === 'strong' ? s.geoBinStrongCents : s.geoBinWeakerCents) / 100 };
      } else {
        // CR-060: the BIN is Dvir's approved override, else the S8 ladder by name length; the floor is his override, else 65% of the BIN (the pricing-settings share)
        const binCents = input.binOverrideCents ?? s8LadderBin(domain, settings.s8_bin_ladder);
        if (input.floorOverrideCents !== undefined && input.floorOverrideCents > binCents) {
          throw new ImportInputError(`floor_override ${formatUsd(input.floorOverrideCents)} must not be above the BIN ${formatUsd(binCents)}`);
        }
        s8Listing = { mode: 'hybrid', bin: binCents / 100 };
        if (input.floorOverrideCents !== undefined) {
          const f = priceFormula(binCents, s);
          s8Listing = { ...s8Listing, floor: input.floorOverrideCents / 100, walkaway: Math.min(input.floorOverrideCents, f.walkawayCents) / 100,
            pricing_exception: true, pricing_exception_reason: 'S8 approved floor (CR-060)' };
        }
      }
    }
  }
  const listingReq: ListingRequest | null = p.listing ?? s8Listing;

  // Registrar data
  let registrarApi: 'full' | 'manage' | 'none' = 'none';
  let expiry = p.expiry;
  if (!p.manual) {
    const adapter = deps.adapters.find((a) => a.name === p.registrar);
    if (!adapter) throw new AppError(422, 'ADAPTER_NOT_ENABLED', `${p.registrar} is not enabled (ENABLED_REGISTRARS and its key); use --manual with --expiry YYYY-MM-DD`);
    let info;
    try {
      info = await adapter.findDomain(domain);
    } catch (e) {
      if (e instanceof RegistrarError && e.code === 'ACCOUNT_NOT_ELIGIBLE') {
        throw new AppError(422, 'ACCOUNT_NOT_ELIGIBLE', `${p.registrar} refused the lookup (account not eligible): use --manual with --expiry YYYY-MM-DD`);
      }
      throw new AppError(502, 'REGISTRAR_ERROR', `${p.registrar} lookup failed${e instanceof RegistrarError ? ` (${e.code})` : ''}; retry, or use --manual with --expiry YYYY-MM-DD`);
    }
    if (!info) {
      throw new AppError(409, 'NOT_IN_ACCOUNT', `${domain} is not in the ${p.registrar} account${p.registrar === 'godaddy'
        ? ' (if the domain is in your GoDaddy account, the lookup path may differ — use --manual with --expiry)' : ''}`);
    }
    registrarApi = registrarApiOf(adapter.capabilities);
    if (info.expiryDate && p.expiry && info.expiryDate !== p.expiry) {
      warnings.push(`EXPIRY_MISMATCH: --expiry ${p.expiry} differs from the registrar's ${info.expiryDate}; using the registrar's`);
    }
    expiry = info.expiryDate ?? p.expiry;
    if (info.autoRenew === true) warnings.push(`AUTO_RENEW_ON: turn auto-renew OFF at ${p.registrar} (renewals there are billed outside the ledger)`);
    else if (p.registrar === 'godaddy' || info.autoRenew == null) warnings.push(`AUTO_RENEW_UNCONFIRMED: check auto-renew is OFF in the ${p.registrar} dashboard`);
    if (info.whoisPrivacy === false) warnings.push(`PRIVACY_OFF: WHOIS privacy is off at ${p.registrar}; turn it on in the dashboard`);
    if (p.registrar === 'porkbun' && info.apiAccess === false) warnings.push('API_ACCESS_DISABLED: turn on API access for this domain at porkbun.com/account/api');
    if (!expiry) throw new AppError(422, 'EXPIRY_UNKNOWN', `${p.registrar} did not report an expiry date; use --manual with --expiry YYYY-MM-DD`);
  }
  if (p.manual) warnings.push(`AUTO_RENEW_UNCONFIRMED: check auto-renew is OFF in the ${p.registrar} dashboard`);
  const expiryDate = expiry!;
  // Founder rule 3: 1-year registrations only. Allow 7 days of slack for registry rounding and time zones.
  // v5.9.0 (CR-060): an S8 closeout may carry the transfer year on top: buy_date + 2 years + 30 days.
  const maxExpiry = new Date(`${addOneYear(p.lane === 'S8' ? addOneYear(p.buyDate) : p.buyDate)}T00:00:00Z`);
  maxExpiry.setUTCDate(maxExpiry.getUTCDate() + (p.lane === 'S8' ? 30 : 7));
  if (expiryDate > maxExpiry.toISOString().slice(0, 10)) {
    throw new AppError(422, 'REGISTRATION_TERM_INVALID', p.lane === 'S8'
      ? `expiry ${expiryDate} is more than 2 years and 30 days after the buy date ${p.buyDate}; an S8 name may carry its transfer year but no more`
      : `expiry ${expiryDate} is more than one year after the buy date ${p.buyDate}; only 1-year registrations are allowed (founder rule 3)`);
  }
  const dropDate = addOneYear(expiryDate);

  let plan: ListingPlan | null = null;
  if (listingReq) {
    if (dropDate <= p.today) throw new AppError(422, 'DROP_DATE_PASSED', `drop_date ${dropDate} is not in the future; a listing cannot be scheduled`);
    const r = validateListing(listingReq, {
      category: p.category, grade: p.grade, phase: 'buy', settings: s, highValueMinBinCents: settings.high_value_min_bin_cents,
      override: p.override, overrideReason: p.overrideReason, approvalValid: p.approval !== null, today: p.today, dropDate, lane: p.lane,
    });
    if (!r.ok) throw new AppError(r.status, r.code, r.message, r.details);
    plan = r.plan;
  }
  let comps: Comp[] | null = null;
  let rationale: string | null = null;
  if (p.legacy === null) {
    const ev = validateComps(input.evidence, s, p.today);
    if (!ev.ok) throw new AppError(ev.status, ev.code, ev.message, ev.details);
    comps = ev.comps;
    rationale = ev.rationale;
  }

  if (p.renewalCents === null && dropDate !== expiryDate) warnings.push('RENEWAL_PRICE_UNKNOWN: the renewal price is not known; committed_forward is incomplete');
  if (p.legacy !== null) warnings.push('LEGACY_NO_COMPS: imported without comparable sales (bought before the comps rule)');
  if (expiryDate < p.today) warnings.push(`EXPIRY_IN_PAST: ${expiryDate} has passed; the daily job decides what happens next`);
  if (plan) warnings.push(...plan.warnings);

  if (input.dryRun) {
    const events = plan ? buildSchedule({ plan, anchor: p.today, dropDate, settings: s, lane: p.lane }) : [];
    return { dry_run: true, domain, status: plan ? 'listed' : 'owned', registrar_api: registrarApi, expiry_date: expiryDate, drop_date: dropDate,
      listing: plan ? planView(plan, events) : null, warnings, ...(await s8Fields(db, p.lane, input, plan, settings, wouldBeBlocked)) };
  }

  const auditId = input.auditId ?? newAuditId();
  const events = await withDomainLock(db, domain, (conn) => conn.transaction().execute(async (trx) => {
    const dup = await trx.selectFrom('domains').select('status').where('domain', '=', domain).executeTakeFirst();
    if (dup) throw new AppError(409, 'ALREADY_IN_PORTFOLIO', `${domain} is already in the portfolio as ${dup.status}`, { status: dup.status });
    if (p.lane === 'S8') {
      // authoritative re-check under the settings lock (two imports at once must not both take the last slot)
      const cfg = await trx.selectFrom('settings').select(['max_domains', 's8_reserved_slots']).forUpdate().executeTakeFirstOrThrow();
      const counts = await activeLaneCounts(trx);
      const block = laneCapBlock('S8', counts, cfg);
      if (block) throw s8CapError(block, counts, cfg);
    }
    if (!input.auditId) await trx.insertInto('audit_log').values({
      id: auditId, scope: 'admin', method: 'ADMIN', path: 'import-domain',
      request: JSON.stringify({
        domain, registrar: p.registrar, manual: p.manual, buy_date: p.buyDate, cost_cents: p.costCents, order: p.order, deal: input.deal ?? null,
        category: p.category, grade: p.grade, listing: listingReq, lane: p.lane, s8_source: input.s8Source ?? null, override: p.override, override_reason: p.overrideReason,
        comps: comps?.length ?? 0, legacy_no_comps: p.legacy, expiry: expiryDate, renewal_price_cents: p.renewalCents,
      }),
      approval_text: p.approval?.text ?? null, approval_at: p.approval?.at ?? null, status_code: 200,
      result_summary: `imported ${domain} ${plan ? 'listed' : 'owned'} cost ${formatUsd(p.costCents)}`,
    }).execute();
    const row = await trx.insertInto('domains').values({
      domain, status: plan ? 'listed' : 'owned', registrar: p.registrar, registrar_api: registrarApi,
      buy_date: p.buyDate, cost_cents: p.costCents, expiry_date: expiryDate, renewal_price_cents: p.renewalCents, renewals_used: 0,
      drop_date: dropDate, category: p.category, price_grade: p.grade, deal_id: input.deal ?? null, lane: p.lane, updated_at: now,
      ...(plan ? { ...domainPlanColumns(plan), first_listed_at: now, ...changedColumns({ export_pending_since: null }, now) } : {}),
    }).returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('ledger_entries').values({
      occurred_on: p.buyDate, domain_id: row.id, deal_id: input.deal ?? null, type: 'registration', amount_cents: -p.costCents,
      counterparty: p.registrar, receipt_ref: `${p.registrar}:${p.order}`,
      note: ['import', p.lane === 'S8' ? `S8 ${input.s8Source ?? ''}`.trim() : undefined, input.costNote?.trim(), `approval ${auditId}`].filter(Boolean).join('; '), audit_id: auditId,
    }).execute();
    await trx.insertInto('pricing_evidence').values({
      domain_id: row.id, comps: comps ? JSON.stringify(comps) : null, rationale, legacy_no_comps_reason: p.legacy, audit_id: auditId,
    }).execute();
    if (input.deal) {
      await trx.insertInto('deals').values({ id: input.deal, domain })
        .onConflict((oc) => oc.column('id').doUpdateSet({ domain, updated_at: now })).execute();
    }
    let written: Awaited<ReturnType<typeof writePlan>>['events'] = [];
    if (plan) {
      await trx.insertInto('listing_history').values(historyRow({
        domainId: row.id, source: 'import', plan, category: p.category, grade: plan.grade, lander: null,
        override: plan.overrideUsed, overrideReason: plan.overrideUsed ? p.overrideReason : null,
        approvalText: p.approval?.text ?? null, approvalAt: p.approval?.at ?? null, auditId, planAuditId: auditId, at: now,
      })).execute();
      written = (await writePlan(trx, { domainId: row.id, plan, anchor: p.today, dropDate, settings: s, planAuditId: auditId, now, lane: p.lane })).events;
    }
    // The domain cap counts the import. An import over it succeeds (the money is already spent) and says so.
    const n = await activeDomainCount(trx);
    if (n > settings.max_domains) warnings.push(`DOMAIN_CAP_EXCEEDED_BY_IMPORT: ${n}/${settings.max_domains} domains; /buy is refused until under the cap`);
    return written;
  }));
  return { domain, status: plan ? 'listed' : 'owned', registrar_api: registrarApi, expiry_date: expiryDate, drop_date: dropDate,
    listing: plan ? planView(plan, events) : null, warnings, ...(await s8Fields(db, p.lane, input, plan, settings, null)) };
}

function s8CapError(code: 'S8_SLOTS_FULL' | 'DOMAIN_CAP_REACHED', c: { total: number; s8: number }, cfg: { max_domains: number; s8_reserved_slots: number }): AppError {
  return code === 'S8_SLOTS_FULL'
    ? new AppError(409, 'S8_SLOTS_FULL', `All ${cfg.s8_reserved_slots} S8 slots are taken`, { s8_names: c.s8, s8_reserved_slots: cfg.s8_reserved_slots })
    : new AppError(409, 'DOMAIN_CAP_REACHED', `Domain cap reached (${c.total}/${cfg.max_domains})`, { domains: c.total, max_domains: cfg.max_domains });
}

async function s8Fields(
  db: Kysely<Database>, lane: 'S8' | null, input: ImportInput, plan: ListingPlan | null,
  settings: { s8_max_price_cents: number; s8_reserved_slots: number }, blocked: 'S8_SLOTS_FULL' | 'DOMAIN_CAP_REACHED' | null,
): Promise<Pick<ImportResult, 'lane' | 's8' | 'would_be_blocked'>> {
  if (lane !== 'S8') return {};
  return {
    lane: 'S8', would_be_blocked: blocked,
    s8: { source: input.s8Source ?? '', comps_value_cents: input.compsValueCents ?? null, bin_cents: plan?.binCents ?? null, floor_cents: plan?.floorCents ?? null,
      bin_source: !plan ? null : plan.category === 'geo' ? 'grade_price' : input.binOverrideCents !== undefined ? 'override' : 'ladder',
      floor_source: !plan || plan.category === 'geo' ? null : input.floorOverrideCents !== undefined ? 'override' : 'formula',
      s8_names: (await activeLaneCounts(db)).s8, s8_reserved_slots: settings.s8_reserved_slots, s8_max_price_cents: settings.s8_max_price_cents },
  };
}
