import { z } from 'zod';
import type { Kysely } from 'kysely';
import type { Category, Database } from '../db/types.js';
import { AppError } from '../http/errors.js';
import { newAuditId } from '../http/audit.js';
import { addOneYear, jerusalemDate } from '../dates.js';
import { formatUsd, usdStringToCents } from '../money.js';
import { normalizeDomain } from '../domain-name.js';
import { buildSchedule } from '../pricing/schedule.js';
import { currentSettings } from '../pricing/settings.js';
import { RegistrarError, type RegistrarAdapter } from '../registrars/types.js';
import { activeDomainCount, spentCents } from '../services/budget.js';
import { registrarApiOf } from '../services/bookkeeping.js';
import { changedColumns } from '../services/export-state.js';
import { isCategory, validateComps, validateListing, type Comp, type ListingPlan, type ListingRequest } from '../services/listing-v2.js';
import { planView } from '../services/plan-view.js';
import { domainPlanColumns, historyRow, withDomainLock, writePlan } from '../services/plan-store.js';

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
}

export interface ImportResult {
  dry_run?: true; domain: string; status: 'owned' | 'listed'; registrar_api: string; expiry_date: string; drop_date: string;
  listing: object | null; warnings: string[];
}

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const DEAL = /^D-\d{3,}$/;

function realDate(label: string, v: string | undefined): string {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) {
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
  if (!['porkbun', 'godaddy', 'other'].includes(registrar)) throw new ImportInputError('--registrar must be porkbun, godaddy or other');
  const manual = i.manual === true;
  if (!manual && registrar === 'other') throw new ImportInputError('--registrar other needs --manual');
  const today = jerusalemDate(now);
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
    const dollars = (label: string, v: string | undefined) => { const c = usd(label, v); return c === null ? null : c / 100; };
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
  } else if (!i.evidence) {
    throw new AppError(422, 'COMPS_REQUIRED', 'Every import needs 2-3 comparable sales (--comps-file) or --legacy-no-comps "<reason>" for a buy before 2026-10-05');
  }

  let expiry: string | null = null;
  if (manual) {
    if (!i.expiry) throw new ImportInputError('--manual needs --expiry YYYY-MM-DD');
    expiry = realDate('--expiry', i.expiry);
  } else if (i.expiry !== undefined) expiry = realDate('--expiry', i.expiry);

  return {
    domain, registrar, manual, today, buyDate, costCents, renewalCents, order, category, grade, listing, approval, expiry,
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
    if (info.autoRenew === true) warnings.push(`AUTO_RENEW_ON: turn auto-renew OFF at ${p.registrar} (renewals there are billed outside the $1,500 cap)`);
    else if (p.registrar === 'godaddy' || info.autoRenew == null) warnings.push(`AUTO_RENEW_UNCONFIRMED: check auto-renew is OFF in the ${p.registrar} dashboard`);
    if (info.whoisPrivacy === false) warnings.push(`PRIVACY_OFF: WHOIS privacy is off at ${p.registrar}; turn it on in the dashboard`);
    if (p.registrar === 'porkbun' && info.apiAccess === false) warnings.push('API_ACCESS_DISABLED: turn on API access for this domain at porkbun.com/account/api');
    if (!expiry) throw new AppError(422, 'EXPIRY_UNKNOWN', `${p.registrar} did not report an expiry date; use --manual with --expiry YYYY-MM-DD`);
  }
  if (p.manual) warnings.push(`AUTO_RENEW_UNCONFIRMED: check auto-renew is OFF in the ${p.registrar} dashboard`);
  const expiryDate = expiry!;
  // Founder rule 3: 1-year registrations only. Allow 7 days of slack for registry rounding and time zones.
  const maxExpiry = new Date(`${addOneYear(p.buyDate)}T00:00:00Z`);
  maxExpiry.setUTCDate(maxExpiry.getUTCDate() + 7);
  if (expiryDate > maxExpiry.toISOString().slice(0, 10)) {
    throw new AppError(422, 'REGISTRATION_TERM_INVALID', `expiry ${expiryDate} is more than one year after the buy date ${p.buyDate}; only 1-year registrations are allowed (founder rule 3)`);
  }
  const dropDate = addOneYear(expiryDate);

  const settings = await db.selectFrom('settings').selectAll().executeTakeFirstOrThrow();
  const s = await currentSettings(db, now);

  let plan: ListingPlan | null = null;
  if (p.listing) {
    if (dropDate <= p.today) throw new AppError(422, 'DROP_DATE_PASSED', `drop_date ${dropDate} is not in the future; a listing cannot be scheduled`);
    const r = validateListing(p.listing, {
      category: p.category, grade: p.grade, phase: 'buy', settings: s, highValueMinBinCents: settings.high_value_min_bin_cents,
      override: p.override, overrideReason: p.overrideReason, approvalValid: p.approval !== null, today: p.today, dropDate,
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

  if (p.renewalCents === null) warnings.push('RENEWAL_PRICE_UNKNOWN: the renewal price is not known; committed_forward is incomplete');
  if (p.legacy !== null) warnings.push('LEGACY_NO_COMPS: imported without comparable sales (bought before the comps rule)');
  if (expiryDate < p.today) warnings.push(`EXPIRY_IN_PAST: ${expiryDate} has passed; the daily job decides what happens next`);
  if (plan) warnings.push(...plan.warnings);

  if (input.dryRun) {
    const events = plan ? buildSchedule({ plan, anchor: p.today, dropDate, settings: s }) : [];
    return { dry_run: true, domain, status: plan ? 'listed' : 'owned', registrar_api: registrarApi, expiry_date: expiryDate, drop_date: dropDate,
      listing: plan ? planView(plan, events) : null, warnings };
  }

  const auditId = newAuditId();
  const events = await withDomainLock(db, domain, (conn) => conn.transaction().execute(async (trx) => {
    const dup = await trx.selectFrom('domains').select('status').where('domain', '=', domain).executeTakeFirst();
    if (dup) throw new AppError(409, 'ALREADY_IN_PORTFOLIO', `${domain} is already in the portfolio as ${dup.status}`, { status: dup.status });
    await trx.insertInto('audit_log').values({
      id: auditId, scope: 'admin', method: 'ADMIN', path: 'import-domain',
      request: JSON.stringify({
        domain, registrar: p.registrar, manual: p.manual, buy_date: p.buyDate, cost_cents: p.costCents, order: p.order, deal: input.deal ?? null,
        category: p.category, grade: p.grade, listing: p.listing, override: p.override, override_reason: p.overrideReason,
        comps: comps?.length ?? 0, legacy_no_comps: p.legacy, expiry: expiryDate, renewal_price_cents: p.renewalCents,
      }),
      approval_text: p.approval?.text ?? null, approval_at: p.approval?.at ?? null, status_code: 200,
      result_summary: `imported ${domain} ${plan ? 'listed' : 'owned'} cost ${formatUsd(p.costCents)}`,
    }).execute();
    const row = await trx.insertInto('domains').values({
      domain, status: plan ? 'listed' : 'owned', registrar: p.registrar, registrar_api: registrarApi,
      buy_date: p.buyDate, cost_cents: p.costCents, expiry_date: expiryDate, renewal_price_cents: p.renewalCents, renewals_used: 0,
      drop_date: dropDate, category: p.category, price_grade: p.grade, deal_id: input.deal ?? null, updated_at: now,
      ...(plan ? { ...domainPlanColumns(plan), first_listed_at: now, ...changedColumns({ export_pending_since: null }, now) } : {}),
    }).returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('ledger_entries').values({
      occurred_on: p.buyDate, domain_id: row.id, deal_id: input.deal ?? null, type: 'registration', amount_cents: -p.costCents,
      counterparty: p.registrar, receipt_ref: `${p.registrar}:${p.order}`,
      note: ['import', input.costNote?.trim(), `approval ${auditId}`].filter(Boolean).join('; '), audit_id: auditId,
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
      written = (await writePlan(trx, { domainId: row.id, plan, anchor: p.today, dropDate, settings: s, planAuditId: auditId, now })).events;
    }
    // Caps count the import. An import over a cap succeeds (the money is already spent) and says so.
    const n = await activeDomainCount(trx);
    if (n > settings.max_domains) warnings.push(`DOMAIN_CAP_EXCEEDED_BY_IMPORT: ${n}/${settings.max_domains} domains; /buy is refused until under the cap`);
    const spent = await spentCents(trx);
    if (spent > settings.poc_cap_cents) warnings.push(`POC_CAP_EXCEEDED_BY_IMPORT: spent ${formatUsd(spent)} of ${formatUsd(settings.poc_cap_cents)}`);
    return written;
  }));
  return { domain, status: plan ? 'listed' : 'owned', registrar_api: registrarApi, expiry_date: expiryDate, drop_date: dropDate,
    listing: plan ? planView(plan, events) : null, warnings };
}
