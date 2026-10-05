import type { Kysely } from 'kysely';
import type { Config } from '../config.js';
import type { Category, Database, DomainRow } from '../db/types.js';
import type { NsLookup } from '../dns/ns-lookup.js';
import { AppError } from '../http/errors.js';
import { RegistrarError, type RegistrarAdapter } from '../registrars/types.js';
import { checkApproval } from './approval.js';
import { changedColumns } from './export-state.js';
import { afternicRow, loadSedoTemplate, sedoRow, type ExportDomain } from './export.js';
import { landerNameservers, sameNsSet } from './lander.js';
import { jerusalemDate } from '../dates.js';
import { buildSchedule, type ScheduleEvent } from '../pricing/schedule.js';
import { currentSettings, settingsByVersion } from '../pricing/settings.js';
import { isCategory, validateListing, type ListingPlan, type ListingRequest } from './listing-v2.js';
import { domainPlanColumns, historyRow, withDomainLock, writePlan } from './plan-store.js';
import { isValidDisplayName } from '../domain-name.js';
import { planView } from './plan-view.js';

export interface ListBody {
  mode?: string | null; bin?: number | null; floor?: number | null; walkaway?: number | null; min_offer?: number | null; lto_max_months?: number | null;
  pricing_exception?: boolean | null; pricing_exception_reason?: string | null;
  category?: string | null; price_grade?: 'strong' | 'weaker' | null; replan?: boolean;
  pricing_hold?: boolean | null; pricing_hold_reason?: string | null;
  override?: boolean; override_reason?: string | null;
  lander?: string; ns?: string[] | null; display_name?: string | null; dry_run?: boolean;
  approval_ref?: { text?: unknown; approved_at?: unknown } | null;
}

const HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const PRICE_FIELDS = ['mode', 'bin', 'floor', 'walkaway', 'min_offer', 'lto_max_months', 'pricing_exception'] as const;

const sameNullableNs = (a: string[] | null, b: string[] | null): boolean => (a === null || b === null ? a === b : sameNsSet(a, b));
const dollars = (c: number | null): number | null => (c === null ? null : c / 100);

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The listing stored on the row, as a plan (for views and history rows of calls that change no price). */
function currentPlan(row: DomainRow, fallbackVersion: number): ListingPlan | null {
  if (!row.listing_mode || !row.category) return null;
  return {
    mode: row.listing_mode, category: row.category, grade: row.category === 'geo' ? row.price_grade : null,
    binCents: row.bin_cents, floorCents: row.floor_cents, walkawayCents: row.walkaway_cents, minOfferCents: row.min_offer_cents ?? 0,
    ltoMaxMonths: row.lto_max_months, pricingSource: row.pricing_source ?? 'formula', settingsVersion: row.pricing_settings_version ?? fallbackVersion,
    overrideUsed: false, warnings: [], formula: null,
  };
}

export class ListService {
  constructor(private readonly deps: { db: Kysely<Database>; adapters: RegistrarAdapter[]; config: Config; nsLookup: NsLookup; now: () => number }) {}

  async list(domain: string, body: ListBody, ctx: { auditId: string }): Promise<Record<string, unknown>> {
    // The dry run changes nothing, so it stays outside the lock; everything else runs under the per-domain lock (shared with /buy).
    if (body.dry_run) return this.run(this.deps.db, domain, body, ctx);
    return withDomainLock(this.deps.db, domain, (conn) => this.run(conn, domain, body, ctx));
  }

  /** `db` is the plain pool for dry runs, or the lock-holding connection: every query goes through it. */
  private async run(db: Kysely<Database>, domain: string, body: ListBody, ctx: { auditId: string }): Promise<Record<string, unknown>> {
    const now = new Date(this.deps.now());
    const row = await db.selectFrom('domains').selectAll().where('domain', '=', domain).executeTakeFirst();
    if (!row || (row.status !== 'owned' && row.status !== 'listed')) {
      throw new AppError(404, 'NOT_IN_PORTFOLIO', `${domain} is not an owned or listed domain`);
    }
    const settings = await db.selectFrom('settings').selectAll().executeTakeFirstOrThrow();

    // Classify
    const priceChange = PRICE_FIELDS.some((f) => body[f] !== undefined && body[f] !== null);
    const categoryChange = body.category !== undefined && body.category !== null && body.category !== row.category;
    const gradeChange = body.price_grade !== undefined && body.price_grade !== null && body.price_grade !== row.price_grade;
    const holdChange = body.pricing_hold !== undefined && body.pricing_hold !== null && body.pricing_hold !== row.pricing_hold;
    const replan = body.replan === true;
    const listingChange = priceChange || categoryChange || gradeChange || replan;
    const changing = listingChange || holdChange;

    // display name
    if (body.display_name != null && !isValidDisplayName(domain, body.display_name)) {
      throw new AppError(422, 'DISPLAY_NAME_MISMATCH', 'display_name must be the domain with different ASCII capitalisation only');
    }

    // Approval: evaluated now, enforced after the engine (listing-strategy §5 order)
    let approvalValid = false;
    let approvedAt: Date | null = null;
    let approvalFailure: { code: string; reason: string } | null = null;
    if (body.approval_ref) {
      const a = checkApproval(body.approval_ref, domain, now, settings.approval_max_age_hours);
      if (a.ok) { approvalValid = true; approvedAt = a.approvedAt; } else approvalFailure = { code: a.code, reason: a.reason };
    }

    // Field checks (V1 first: §5 order)
    if (body.mode != null && !['bin', 'offer', 'hybrid'].includes(body.mode)) throw new AppError(422, 'MODE_INVALID', 'mode must be bin, offer or hybrid');
    if (body.category !== undefined && body.category !== null && !isCategory(body.category)) throw new AppError(422, 'CATEGORY_REQUIRED', 'Unknown category');
    const category: Category | null = body.category !== undefined && body.category !== null && isCategory(body.category) ? body.category : row.category;
    if (body.price_grade != null && category !== 'geo') throw new AppError(422, 'GRADE_NOT_GEO', 'price_grade only applies to geo names');
    if (body.pricing_hold === true && !body.pricing_hold_reason?.trim()) throw new AppError(422, 'HOLD_REASON_REQUIRED', 'pricing_hold needs pricing_hold_reason');
    if (replan && !row.listing_mode && !priceChange) throw new AppError(422, 'REPLAN_NOTHING_LISTED', 'replan needs a listed domain');
    const grade = category === 'geo' ? (body.price_grade ?? row.price_grade) : null;

    // Settings: the version the plan was made under, unless replanning or never listed
    const useCurrent = replan || row.pricing_settings_version === null || row.first_listed_at === null;
    const s = useCurrent ? await currentSettings(db, now) : await settingsByVersion(db, row.pricing_settings_version!);
    if (!s) throw new Error(`pricing_settings v${row.pricing_settings_version} is missing for ${domain}`);

    // Relabel guard: any non-geo -> geo is an override
    let categoryOverride = false;
    if (categoryChange) {
      const relabelToGeo = category === 'geo' && row.category !== null && row.category !== 'geo';
      if (relabelToGeo && !(body.override && body.override_reason?.trim() && approvalValid)) {
        throw new AppError(422, 'OVERRIDE_NEEDS_APPROVAL', 'Relabelling a name as geo is an override: needs override, a reason and a valid approval_ref');
      }
      categoryOverride = relabelToGeo;
      if (category === 'geo' && grade === null) throw new AppError(422, 'GEO_GRADE_REQUIRED', 'Geo names need price_grade strong or weaker');
    }

    // Engine
    let req: ListingRequest | null = null;
    if (priceChange) {
      req = {
        mode: body.mode, bin: body.bin, floor: body.floor, walkaway: body.walkaway, min_offer: body.min_offer, lto_max_months: body.lto_max_months,
        pricing_exception: body.pricing_exception, pricing_exception_reason: body.pricing_exception_reason,
      };
    } else if (listingChange && row.listing_mode) {
      if (row.listing_mode === 'hybrid') {
        // replan recomputes from the formula (Q10); anything else carries the stored values (§10.4)
        req = replan
          ? { mode: 'hybrid', bin: dollars(row.bin_cents), lto_max_months: row.lto_max_months }
          : { mode: 'hybrid', bin: dollars(row.bin_cents), floor: dollars(row.floor_cents), walkaway: dollars(row.walkaway_cents),
              min_offer: dollars(row.min_offer_cents), lto_max_months: row.lto_max_months };
      } else if (row.listing_mode === 'bin') req = { mode: 'bin', bin: dollars(row.bin_cents) };
      else req = { mode: 'offer', min_offer: dollars(row.min_offer_cents), floor: dollars(row.floor_cents) };
    }
    let plan: ListingPlan | null = null;
    const warnings: string[] = [];
    if (req) {
      const r = validateListing(req, {
        category, grade, phase: 'change', settings: s, highValueMinBinCents: settings.high_value_min_bin_cents,
        override: body.override ?? false, overrideReason: body.override_reason ?? null, approvalValid,
        today: jerusalemDate(now), dropDate: row.drop_date,
        ...(!priceChange && !replan && row.listing_mode === 'hybrid' ? { carried: { pricingSource: row.pricing_source ?? 'formula' } } : {}),
      });
      if (!r.ok) throw new AppError(r.status, r.code, r.message, r.details ?? {});
      plan = r.plan;
      warnings.push(...plan.warnings);
    }
    const overrideUsed = (plan?.overrideUsed ?? false) || categoryOverride;

    // V9/V10
    if (approvalFailure) throw new AppError(422, approvalFailure.code, approvalFailure.reason);
    if (changing && !body.approval_ref) {
      throw new AppError(422, 'APPROVAL_REQUIRED', "Changing the mode, a price, the category, the grade or the pricing hold needs approval_ref (Dvir's words)");
    }

    // Schedule anchor: the first listing starts the clock; later plans keep it and only schedule events after today
    const firstListing = row.first_listed_at === null;
    const today = jerusalemDate(now);
    const anchor = firstListing ? today : jerusalemDate(row.first_listed_at!);
    const startAfter = firstListing ? undefined : today;
    if (plan && row.drop_date === null) throw new AppError(422, 'DROP_DATE_UNKNOWN', 'The domain has no drop_date; a schedule cannot be built');

    // Lander target
    const lander = body.lander ?? settings.lander_target;
    let ns: string[];
    if (lander === 'dan') throw new AppError(422, 'LANDER_RETIRED', 'Dan.com retired 2025-06-27; use afternic');
    if (lander === 'custom') {
      const list = [...new Set((body.ns ?? []).map((n) => n.trim().toLowerCase().replace(/\.$/, '')))];
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

    const shown = plan ?? currentPlan(row, s.version);
    const displayName = body.display_name ?? row.display_name;
    const exportDomain: ExportDomain | null = shown ? {
      domain, display_name: displayName, listing_mode: shown.mode, bin_cents: shown.binCents, floor_cents: shown.floorCents,
      min_offer_cents: shown.minOfferCents, lto_max_months: shown.ltoMaxMonths,
    } : null;

    // Dry run: validation + preview only
    if (body.dry_run) {
      const a = exportDomain ? afternicRow(exportDomain) : null;
      const t = await loadSedoTemplate(this.deps.config.sedoTemplatePath).catch(() => null);
      const previewEvents = plan ? buildSchedule({ plan, anchor, dropDate: row.drop_date!, settings: s, startAfter }) : await this.currentEvents(db, row.id, row.plan_id);
      return {
        dry_run: true, valid: true, domain, category, listing: shown ? planView(shown, previewEvents) : null, lander, ns,
        preview: {
          afternic: a && 'cells' in a.row ? a.row.cells.join(',') : null,
          sedo: t && exportDomain ? sedoRow(exportDomain, t, settings.sedo_hybrid_as).join(',') : null,
        },
        warnings,
      };
    }

    // Nameservers (before saving; L5)
    const ns_result = await this.setNameservers(row, ns, warnings);
    let ns_public: 'match' | 'pending' | 'unknown' = 'unknown';
    const seen = await this.deps.nsLookup(domain).catch(() => null);
    if (seen) ns_public = sameNsSet(seen, ns) ? 'match' : 'pending';

    // Save + history (one transaction)
    const historyChange = changing || (row.lander !== null && row.lander !== lander);
    const displayChanged = body.display_name != null && body.display_name !== row.display_name;
    await db.transaction().execute(async (trx) => {
      const cur = await trx.selectFrom('domains').selectAll().where('id', '=', row.id).forUpdate().executeTakeFirst();
      if (!cur || (cur.status !== 'owned' && cur.status !== 'listed')) {
        throw new AppError(404, 'NOT_IN_PORTFOLIO', `${domain} is not an owned or listed domain`);
      }
      if (cur.category !== row.category || cur.listing_mode !== row.listing_mode || cur.bin_cents !== row.bin_cents
        || cur.floor_cents !== row.floor_cents || cur.walkaway_cents !== row.walkaway_cents || cur.min_offer_cents !== row.min_offer_cents
        || cur.lto_max_months !== row.lto_max_months || cur.plan_id !== row.plan_id || cur.pricing_hold !== row.pricing_hold
        || cur.lander !== row.lander || !sameNullableNs(cur.lander_ns, row.lander_ns) || cur.status !== row.status
        || (cur.first_listed_at?.getTime() ?? null) !== (row.first_listed_at?.getTime() ?? null)) {
        throw new AppError(409, 'LISTING_CHANGED_CONCURRENTLY', 'The listing changed while this request was running; retry');
      }
      const nsChanged = !row.lander_ns || !sameNsSet(row.lander_ns, ns);
      await trx.updateTable('domains').set({
        ...(plan ? {
          ...domainPlanColumns(plan), status: 'listed' as const, category: plan.category, price_grade: plan.category === 'geo' ? plan.grade : null,
          first_listed_at: cur.first_listed_at ?? now,
        } : {
          ...(categoryChange ? { category, price_grade: category === 'geo' ? grade : null } : {}),
          ...(gradeChange ? { price_grade: body.price_grade } : {}),
        }),
        ...(plan || displayChanged ? changedColumns(cur, now) : {}),
        ...(holdChange ? { pricing_hold: body.pricing_hold!, pricing_hold_reason: body.pricing_hold ? body.pricing_hold_reason!.trim() : null } : {}),
        ...(body.display_name != null ? { display_name: body.display_name } : {}),
        lander, lander_ns: ns, lander_set_at: now,
        ns_verified_at: ns_public === 'match' ? now : nsChanged ? null : row.ns_verified_at,
        updated_at: now,
      }).where('id', '=', row.id).execute();
      if (plan) {
        await writePlan(trx, { domainId: row.id, plan, anchor, dropDate: row.drop_date!, settings: s, planAuditId: ctx.auditId, startAfter, now });
      }
      if (historyChange) {
        await trx.insertInto('listing_history').values(historyRow({
          domainId: row.id, source: 'list', plan: shown, category, grade, lander, override: overrideUsed,
          overrideReason: overrideUsed ? (body.override_reason ?? null) : null,
          approvalText: body.approval_ref ? String(body.approval_ref.text) : null, approvalAt: approvedAt, auditId: ctx.auditId,
          planAuditId: plan ? ctx.auditId : row.plan_audit_id,
        })).execute();
      }
    });

    const after = await db.selectFrom('domains').select(['plan_id', 'pricing_hold']).where('id', '=', row.id).executeTakeFirstOrThrow();
    const events = await this.currentEvents(db, row.id, after.plan_id);

    const checklist = [
      'Add/update at Afternic: download /export/afternic.csv and upload it at afternic.com/domains/add with **Update** (never Replace)',
      'Sedo: download /export/sedo.csv and use the Sedo Bulk Uploader',
    ];
    if (row.buy_date) checklist.push(`Day 60 (${addDays(row.buy_date, 60)}): enable Afternic Fast Transfer opt-in at the registrar`);
    if (row.registrar === 'godaddy') checklist.push("GoDaddy-registered: GoDaddy's own List for Sale is an alternative to the Afternic upload");

    return {
      domain, status: plan ? 'listed' : row.status, category,
      listing: shown ? planView(shown, events) : null, pricing_hold: after.pricing_hold,
      lander, ns, ns_status: ns_result.status, ...(ns_result.steps ? { manual_steps: ns_result.steps } : {}), ns_public,
      checklist, warnings,
    };
  }

  /** Rows of the current plan that still count (not superseded), as schedule events. */
  private async currentEvents(db: Kysely<Database>, domainId: number, planId: string | null): Promise<ScheduleEvent[]> {
    if (planId === null) return [];
    const rows = await db.selectFrom('price_schedule').selectAll()
      .where('domain_id', '=', domainId).where('plan_id', '=', planId).where('status', '!=', 'superseded').orderBy('due_on').orderBy('id').execute();
    return rows.map((e) => ({ event: e.event, dueOn: e.due_on, binCents: e.bin_cents, floorCents: e.floor_cents, walkawayCents: e.walkaway_cents, status: e.status }));
  }

  private async setNameservers(row: DomainRow, ns: string[], warnings: string[]): Promise<{ status: 'set' | 'mismatch' | 'unverified' | 'manual'; steps?: string[] }> {
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
    } catch (e) {
      if (!(e instanceof RegistrarError)) throw e;
      if (e.code === 'API_ACCESS_DISABLED') {
        throw new AppError(409, 'API_ACCESS_DISABLED', adapter.name === 'porkbun'
          ? 'The registrar refused: API access is off for this domain. Turn on "Opt In All Domains" at porkbun.com/account/api, then call /list again.'
          : `The registrar refused: API access is off for this domain at ${adapter.name}. Enable API access for it, then call /list again.`);
      }
      if (e.ambiguous) {
        // The change may have gone through: read it back before deciding.
        const unavailable = new AppError(503, 'REGISTRAR_UNAVAILABLE', 'The registrar did not confirm the nameserver change; retry later', { registrar: adapter.name, registrar_code: e.code });
        let got: Set<string>;
        try {
          got = await adapter.getNameservers(row.domain);
        } catch {
          throw unavailable;
        }
        if (!sameNsSet(got, ns)) throw unavailable;
        warnings.push('NS_SET_AFTER_AMBIGUOUS');
        return { status: 'set' };
      }
      throw new AppError(409, 'REGISTRAR_REJECTED', 'The registrar refused the nameserver change', { registrar: adapter.name, registrar_code: e.code });
    }
    try {
      const got = await adapter.getNameservers(row.domain);
      return { status: sameNsSet(got, ns) ? 'set' : 'mismatch' };
    } catch {
      return { status: 'unverified' };
    }
  }
}

