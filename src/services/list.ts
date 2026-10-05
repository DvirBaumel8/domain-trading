import type { Kysely } from 'kysely';
import type { Config } from '../config.js';
import type { Category, Database, DomainRow } from '../db/types.js';
import type { NsLookup } from '../dns/ns-lookup.js';
import { AppError } from '../http/errors.js';
import { RegistrarError, type RegistrarAdapter } from '../registrars/types.js';
import { checkApproval } from './approval.js';
import { afternicRow, loadSedoTemplate, sedoRow, type ExportDomain } from './export.js';
import { landerNameservers, sameNsSet } from './lander.js';
import { isCategory, listingSettings, presentListing, validateListing, type NormalizedListing } from './listing-rules.js';

export interface ListBody {
  mode?: string; bin?: number | null; floor?: number | null; min_offer?: number | null; lto_max_months?: number | null;
  category?: string | null; override?: boolean; override_reason?: string | null;
  lander?: string; ns?: string[] | null; display_name?: string | null; dry_run?: boolean;
  approval_ref?: { text?: unknown; approved_at?: unknown } | null;
}

const HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const PRICE_FIELDS = ['mode', 'bin', 'floor', 'min_offer', 'lto_max_months'] as const;

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export class ListService {
  constructor(private readonly deps: { db: Kysely<Database>; adapters: RegistrarAdapter[]; config: Config; nsLookup: NsLookup; now: () => number }) {}

  async list(domain: string, body: ListBody, ctx: { auditId: string }): Promise<Record<string, unknown>> {
    const { db } = this.deps;
    const now = new Date(this.deps.now());
    const row = await db.selectFrom('domains').selectAll().where('domain', '=', domain).executeTakeFirst();
    if (!row || (row.status !== 'owned' && row.status !== 'listed')) {
      throw new AppError(404, 'NOT_IN_PORTFOLIO', `${domain} is not an owned or listed domain`);
    }
    const settings = await db.selectFrom('settings').selectAll().executeTakeFirstOrThrow();

    // Classify (L2)
    const priceChange = PRICE_FIELDS.some((f) => body[f] !== undefined && body[f] !== null);
    const categoryChange = body.category !== undefined && body.category !== null;
    const changing = priceChange || categoryChange;

    // display name (L4)
    if (body.display_name != null && body.display_name.toLowerCase() !== domain) {
      throw new AppError(422, 'DISPLAY_NAME_MISMATCH', 'display_name must be the domain with different capitalisation only');
    }

    // Approval (V9/V10)
    let approvalValid = false;
    let approvedAt: Date | null = null;
    if (body.approval_ref) {
      const a = checkApproval(body.approval_ref, domain, now, settings.approval_max_age_hours);
      if (!a.ok) throw new AppError(422, a.code, a.reason);
      approvalValid = true;
      approvedAt = a.approvedAt;
    } else if (changing) {
      throw new AppError(422, 'APPROVAL_REQUIRED', 'Changing the mode, a price or the category needs approval_ref (Dvir\'s words)');
    }

    // Category (V9 + relabel guard)
    let category: Category | null = row.category;
    let categoryOverride = false;
    if (categoryChange) {
      if (!isCategory(body.category)) throw new AppError(422, 'CATEGORY_REQUIRED', 'Unknown category');
      const highValueToGeo = body.category === 'geo' && row.category !== null && settings.high_value_categories.includes(row.category);
      if (highValueToGeo && !(body.override && body.override_reason?.trim() && approvalValid)) {
        throw new AppError(422, 'OVERRIDE_NEEDS_APPROVAL', 'Moving a high-value name to geo is an override: needs override, a reason and approval_ref');
      }
      categoryOverride = highValueToGeo;
      category = body.category;
    }

    // Listing (V1–V8); a category change alone re-validates the current listing (L3)
    let listing: NormalizedListing | null = null;
    let overrideUsed = false;
    const warnings: string[] = [];
    const lsettings = listingSettings(settings);
    if (priceChange) {
      if (body.mode === undefined || body.mode === null) throw new AppError(422, 'MODE_INVALID', 'mode is required when any price is sent');
      const r = validateListing(body, { category, settings: lsettings, override: body.override ?? false, overrideReason: body.override_reason ?? null, approvalValid });
      if (!r.ok) throw new AppError(422, r.code, r.message);
      listing = r.listing;
      overrideUsed = r.overrideUsed;
      warnings.push(...r.warnings);
    } else if (categoryChange && row.listing_mode) {
      const current = {
        mode: row.listing_mode, bin: row.bin_cents === null ? null : row.bin_cents / 100,
        floor: row.floor_cents === null ? null : row.floor_cents / 100, min_offer: row.min_offer_cents === null ? null : row.min_offer_cents / 100,
        lto_max_months: row.lto_max_months,
      };
      const r = validateListing(current, { category, settings: lsettings, override: body.override ?? false, overrideReason: body.override_reason ?? null, approvalValid });
      if (!r.ok) throw new AppError(422, r.code, r.message);
      overrideUsed = r.overrideUsed;
      warnings.push(...r.warnings);
    }

    overrideUsed = overrideUsed || categoryOverride;

    // Lander target
    const lander = body.lander ?? settings.lander_target;
    let ns: string[];
    if (lander === 'dan') throw new AppError(422, 'LANDER_RETIRED', 'Dan.com retired 2025-06-27; use afternic');
    if (lander === 'custom') {
      const list = (body.ns ?? []).map((n) => n.trim().toLowerCase().replace(/\.$/, ''));
      if (list.length < 2 || list.length > 4 || !list.every((n) => HOST.test(n))) {
        throw new AppError(422, 'NS_INVALID', 'custom lander needs 2–4 valid nameserver hostnames');
      }
      ns = list;
    } else {
      const known = landerNameservers(lander);
      if (!known) throw new AppError(422, 'LANDER_INVALID', 'lander must be afternic, sedo or custom');
      if (body.ns) throw new AppError(422, 'NS_INVALID', 'ns is only allowed with lander "custom"');
      ns = [...known];
    }

    const effective = listing ?? (row.listing_mode ? {
      mode: row.listing_mode, binCents: row.bin_cents, floorCents: row.floor_cents, minOfferCents: row.min_offer_cents, ltoMaxMonths: row.lto_max_months,
    } : null);
    const exportDomain: ExportDomain = {
      domain, display_name: body.display_name ?? row.display_name, listing_mode: effective?.mode ?? null,
      bin_cents: effective?.binCents ?? null, floor_cents: effective?.floorCents ?? null,
      min_offer_cents: effective?.minOfferCents ?? null, lto_max_months: effective?.ltoMaxMonths ?? null,
    };
    if (listing && [listing.binCents, listing.floorCents, listing.minOfferCents].some((c) => c !== null && c % 100 !== 0)) {
      warnings.push('AFTERNIC_ROUNDS_DOWN');
    }

    // Dry run: validation + preview only
    if (body.dry_run) {
      const a = effective ? afternicRow(exportDomain) : null;
      const t = await loadSedoTemplate(this.deps.config.sedoTemplatePath).catch(() => null);
      return {
        dry_run: true, valid: true, domain, category, listing: effective ? presentListing(effective) : null, lander, ns,
        preview: {
          afternic: a && 'cells' in a.row ? a.row.cells.join(',') : null,
          sedo: t && effective ? sedoRow(exportDomain, t, settings.sedo_hybrid_as).join(',') : null,
        },
        warnings,
      };
    }

    // Nameservers (before saving; L5)
    const ns_result = await this.setNameservers(row, ns);
    let ns_public: 'match' | 'pending' | 'unknown' = 'unknown';
    const seen = await this.deps.nsLookup(domain).catch(() => null);
    if (seen) ns_public = sameNsSet(seen, ns) ? 'match' : 'pending';

    // Save + history (one transaction)
    const historyChange = priceChange || categoryChange;
    await db.transaction().execute(async (trx) => {
      const nsChanged = !row.lander_ns || !sameNsSet(row.lander_ns, ns);
      await trx.updateTable('domains').set({
        ...(listing ? {
          listing_mode: listing.mode, bin_cents: listing.binCents, floor_cents: listing.floorCents,
          min_offer_cents: listing.minOfferCents, lto_max_months: listing.ltoMaxMonths, status: 'listed' as const,
        } : {}),
        ...(categoryChange ? { category } : {}),
        ...(body.display_name != null ? { display_name: body.display_name } : {}),
        lander, lander_ns: ns, lander_set_at: now,
        ns_verified_at: ns_public === 'match' ? now : nsChanged ? null : row.ns_verified_at,
        updated_at: now,
      }).where('id', '=', row.id).execute();
      if (historyChange) {
        const h = effective;
        await trx.insertInto('listing_history').values({
          domain_id: row.id, source: 'list', category, mode: h?.mode ?? null, bin_cents: h?.binCents ?? null,
          floor_cents: h?.floorCents ?? null, min_offer_cents: h?.minOfferCents ?? null, lto_max_months: h?.ltoMaxMonths ?? null,
          lander, override: overrideUsed, override_reason: overrideUsed ? (body.override_reason ?? null) : null,
          approval_text: body.approval_ref ? String(body.approval_ref.text) : null, approval_at: approvedAt, audit_id: ctx.auditId,
        }).execute();
      }
    });

    const checklist = [
      'Add/update at Afternic: download /export/afternic.csv and upload it at afternic.com/domains/add with **Update** (never Replace)',
      'Sedo: download /export/sedo.csv and use the Sedo Bulk Uploader',
    ];
    if (row.buy_date) checklist.push(`Day 60 (${addDays(row.buy_date, 60)}): enable Afternic Fast Transfer opt-in at the registrar`);
    if (row.registrar === 'godaddy') checklist.push("GoDaddy-registered: GoDaddy's own List for Sale is an alternative to the Afternic upload");

    return {
      domain, status: listing ? 'listed' : row.status, category,
      listing: effective ? presentListing(effective) : null,
      lander, ns, ns_status: ns_result.status, ...(ns_result.steps ? { manual_steps: ns_result.steps } : {}), ns_public,
      checklist, warnings,
    };
  }

  private async setNameservers(row: DomainRow, ns: string[]): Promise<{ status: 'set' | 'mismatch' | 'manual'; steps?: string[] }> {
    const adapter = this.deps.adapters.find((a) => a.name === row.registrar);
    if (row.registrar_api === 'none' || !adapter || !adapter.capabilities.canManageNs) {
      return {
        status: 'manual',
        steps: [
          `At ${row.registrar ?? 'the registrar'}: open ${row.domain} → DNS → Nameservers → use custom nameservers → ${ns.join(', ')} (menu names may differ; follow the registrar's current UI)`,
          'The service checks public DNS daily and clears the /report warning once the nameservers match',
        ],
      };
    }
    try {
      await adapter.setNameservers(row.domain, ns);
      const got = await adapter.getNameservers(row.domain);
      return { status: sameNsSet(got, ns) ? 'set' : 'mismatch' };
    } catch (e) {
      if (e instanceof RegistrarError && e.code === 'API_ACCESS_DISABLED') {
        throw new AppError(409, 'API_ACCESS_DISABLED', 'The registrar refused: API access is off for this domain. Turn on "Opt In All Domains" at porkbun.com/account/api, then call /list again.');
      }
      throw new AppError(409, 'REGISTRAR_REJECTED', 'The registrar refused the nameserver change', {
        registrar: adapter.name, registrar_code: e instanceof RegistrarError ? e.code : 'UNKNOWN',
      });
    }
  }
}

