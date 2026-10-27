// v5.61.0: what the plan says Afternic should show for a listed name, how Afternic's own read differs from it, and the push that fixes the difference.
// The plan values are the ones the Afternic CSV export carries (they are read back from `afternicRow`, so the file and the API never disagree).
// The private walk-away has no Afternic field and is never read here. The scheduled price job never calls this: only the operator-run route does.
import type { Kysely } from 'kysely';
import { AppError } from '../../http/errors.js';
import type { Database } from '../../db/types.js';
import { normalizeDomain } from '../../domain-name.js';
import { AfternicApiError, type AfternicClient, type AfternicListing, type AfternicUpdate } from './afternic-api.js';
import { afternicRow, leaseOf, type AfternicLease, type ExportDomain, type ExportService } from './export.js';

export interface AfternicPlan {
  domain: string; bin_cents: number; floor_cents: number; min_offer_cents: number;
  leasing_enabled: boolean; max_lease_months: number | null; intake_style: 'BUYNOW' | 'CUSTOM_LANDER';
  show_buynow: boolean; show_lto: boolean; show_offer: boolean; hidden: boolean; list_status: 'ACTIVE';
}
export type PlanResult = { plan: AfternicPlan } | { skip: string };

export interface FieldDiff { field: string; plan: unknown; afternic: unknown }

const EXPORT_COLS = ['domain', 'display_name', 'listing_mode', 'bin_cents', 'floor_cents', 'min_offer_cents', 'lto_max_months'] as const;
const SAFE_DOMAIN = /^[a-z0-9.-]+$/;
const dollarsToCents = (s: string): number => Number(s) * 100;

/** The Afternic values of one name, from the same row the CSV export writes. `skip` = the name is not in the file (not listed, min offer under $20). */
export function afternicPlanOf(d: ExportDomain, lease: AfternicLease): PlanResult {
  const r = afternicRow(d, lease);
  if (!('cells' in r.row)) return { skip: r.row.skip };
  const c = r.row.cells;
  const months = c[5] === '' ? null : Number(c[5]);
  return {
    plan: {
      domain: d.domain, bin_cents: dollarsToCents(c[1]!), floor_cents: dollarsToCents(c[2]!), min_offer_cents: dollarsToCents(c[3]!),
      leasing_enabled: c[4] === 'Y', max_lease_months: months, intake_style: c[6] === 'Buy It Now' ? 'BUYNOW' : 'CUSTOM_LANDER',
      show_buynow: c[7] === 'Y', show_lto: c[8] === 'Y', show_offer: c[9] === 'Y', hidden: c[10] === 'Y', list_status: 'ACTIVE',
    },
  };
}

/** Fields where Afternic's value is not the plan's. The lease months count only when the plan has the lease on. `list_status` is reported but is not pushable. */
export function diffListing(plan: AfternicPlan, a: AfternicListing | StoredListing): FieldDiff[] {
  const out: FieldDiff[] = [];
  const cmp = (field: string, p: unknown, v: unknown) => { if (p !== v) out.push({ field, plan: p, afternic: v ?? null }); };
  cmp('bin_cents', plan.bin_cents, a.bin_cents);
  cmp('floor_cents', plan.floor_cents, a.floor_cents);
  cmp('min_offer_cents', plan.min_offer_cents, a.min_offer_cents);
  cmp('leasing_enabled', plan.leasing_enabled, a.leasing_enabled);
  if (plan.leasing_enabled) cmp('max_lease_months', plan.max_lease_months, a.max_lease_months);
  cmp('intake_style', plan.intake_style, a.intake_style);
  cmp('show_buynow', plan.show_buynow, a.show_buynow);
  cmp('show_lto', plan.show_lto, a.show_lto);
  cmp('show_offer', plan.show_offer, a.show_offer);
  cmp('hidden', plan.hidden, a.hidden);
  cmp('list_status', plan.list_status, a.list_status);
  return out;
}

/** The columns of afternic_listings_daily that diffListing reads. */
export interface StoredListing {
  list_status: string | null; bin_cents: number | null; floor_cents: number | null; min_offer_cents: number | null; leasing_enabled: boolean | null;
  max_lease_months: number | null; intake_style: string | null; show_buynow: boolean | null; show_lto: boolean | null; show_offer: boolean | null; hidden: boolean | null;
}

/** The update that makes Afternic match the plan: the pushable differing fields only. */
export function updateOf(plan: AfternicPlan, diff: FieldDiff[]): AfternicUpdate {
  const u: AfternicUpdate = {};
  const has = (f: string) => diff.some((x) => x.field === f);
  if (has('bin_cents')) u.bin_cents = plan.bin_cents;
  if (has('floor_cents')) u.floor_cents = plan.floor_cents;
  if (has('min_offer_cents')) u.min_offer_cents = plan.min_offer_cents;
  if (has('leasing_enabled') || has('max_lease_months')) {
    u.leasing_enabled = plan.leasing_enabled;
    if (plan.leasing_enabled && plan.max_lease_months !== null) u.max_lease_months = plan.max_lease_months;
  }
  if (has('intake_style')) u.intake_style = plan.intake_style;
  if (has('show_buynow')) u.show_buynow = plan.show_buynow;
  if (has('show_lto')) u.show_lto = plan.show_lto;
  if (has('show_offer')) u.show_offer = plan.show_offer;
  if (has('hidden')) u.hidden = plan.hidden;
  return u;
}

/** The plan of every listed name (name -> result), under one read of the settings. */
export async function loadPlans(db: Kysely<Database>): Promise<Map<string, PlanResult>> {
  const settings = await db.selectFrom('settings').select(['afternic_lease_to_own', 'afternic_lease_months']).executeTakeFirstOrThrow();
  const rows = await db.selectFrom('domains').select(EXPORT_COLS).where('status', '=', 'listed').orderBy('domain').execute();
  const lease = leaseOf(settings);
  return new Map(rows.filter((d) => SAFE_DOMAIN.test(d.domain)).map((d) => [d.domain, afternicPlanOf(d, lease)]));
}

export interface PushBody { domains?: string[]; dry_run?: boolean }
export interface PushResult {
  dry_run: boolean;
  pushed: { domain: string; fields: FieldDiff[] }[];
  unchanged: string[];
  failed: { domain: string; code: string }[];
  skipped: { domain: string; reason: string }[];
  upload: { recorded: boolean; export_id: string | null; reason: string | null };
}

export class AfternicPushService {
  constructor(private readonly deps: { db: Kysely<Database>; client: AfternicClient | null; exports: ExportService; now: () => number }) {}

  async push(body: PushBody, ctx: { auditId: string }): Promise<PushResult> {
    const { db, client } = this.deps;
    if (!client) throw new AppError(503, 'AFTERNIC_NOT_CONFIGURED', 'AFTERNIC_API_KEY and AFTERNIC_API_SECRET are not set on the server');
    const dry = body.dry_run === true;
    const at = new Date(this.deps.now()); // the snapshot time: a plan change after this moment stays pending
    const plans = await loadPlans(db);
    const failed: PushResult['failed'] = [];
    let names: string[];
    if (body.domains) {
      names = [...new Set(body.domains.map((d) => normalizeDomain(d)))];
      for (const n of names.filter((x) => !plans.has(x))) failed.push({ domain: n, code: 'DOMAIN_NOT_LISTED' });
      names = names.filter((x) => plans.has(x));
    } else {
      names = [...plans.keys()];
    }
    let remote: AfternicListing[];
    try {
      remote = await client.list();
    } catch (e) {
      throw apiError(e);
    }
    const remoteBy = new Map(remote.map((r) => [r.name, r]));
    const out: PushResult = { dry_run: dry, pushed: [], unchanged: [], failed, skipped: [], upload: { recorded: false, export_id: null, reason: null } };
    for (const n of names) {
      const p = plans.get(n)!;
      if ('skip' in p) { out.skipped.push({ domain: n, reason: p.skip }); continue; }
      const r = remoteBy.get(n);
      if (!r) { failed.push({ domain: n, code: 'AFTERNIC_NOT_LISTED' }); continue; }
      const fields = diffListing(p.plan, r).filter((f) => f.field !== 'list_status');
      if (fields.length === 0) { out.unchanged.push(n); continue; }
      if (!dry) {
        try {
          await client.update(n, updateOf(p.plan, fields));
        } catch (e) {
          failed.push({ domain: n, code: e instanceof AfternicApiError ? e.code : 'AFTERNIC_API_ERROR' });
          continue;
        }
      }
      out.pushed.push({ domain: n, fields });
    }
    if (dry) { out.upload.reason = 'DRY_RUN'; return out; }
    // The upload is recorded only when this run vouches for the whole file: every listed name checked and none failed (the pending set is global).
    const verified = [...out.unchanged, ...out.pushed.map((x) => x.domain)];
    if (body.domains && new Set(names).size < plans.size) out.upload.reason = 'PARTIAL_DOMAIN_LIST';
    else if (failed.length > 0) out.upload.reason = 'SOME_FAILED';
    else if (verified.length === 0) out.upload.reason = 'NOTHING_TO_RECORD';
    else {
      const rec = await this.deps.exports.recordApiPush(verified.sort(), at, { auditId: ctx.auditId });
      out.upload = { recorded: true, export_id: rec.export_id, reason: null };
    }
    return out;
  }
}

/** A failed list call becomes the route's one stable error; the reason is the client's code. */
export function apiError(e: unknown): AppError {
  if (e instanceof AfternicApiError) return new AppError(502, 'AFTERNIC_API_ERROR', e.message, { reason: e.code, status: e.status });
  throw e;
}
