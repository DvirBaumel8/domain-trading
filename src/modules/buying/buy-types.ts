// Shared types of the /buy flow (BuyService in buy.ts; the phases are in buy-dryrun.ts, buy-register.ts and buy-postbuy.ts) and the drop-policy words.
import type { Kysely } from 'kysely';
import type { Category, Database } from '../../db/types.js';
import { formatUsd } from '../../core/money.js';
import type { RdapFn } from '../../core/rdap.js';
import type { CheckResult, CheckService, EvaluatedQuote, RegistrarAdapter } from '../registrars/index.js';
import type { Comp, ListingPlan, ListingRequest, PricingSettings } from '../listing/index.js';
import type { latestScreeningRun } from './buy-hold.js';
import type { BuyBlock } from './buy-gates.js';
import type { RenewalMath } from './renewal-math.js';

export interface BuyInput {
  domain: string; maxPriceCents: number; maxTwoYearCents: number | null;
  approval: { text?: unknown; approved_at?: unknown } | null;
  dealId: string | null; category: string | null;
  priceGrade: 'strong' | 'weaker' | null; pricingEvidence: unknown; expectedSettingsVersion: number | null;
  proposedListing: ListingRequest | null; override: boolean; overrideReason: string | null;
  registrar: string | null; dryRun: boolean; /** `dry_run: "strict"`: a dry run whose first real-buy gate refusal is the answer (CR-005 N-7). */ strictDry?: boolean; autoList: boolean; requestBody: unknown;
  /** CR-030: `small_buy_exception` flag of the body. */ smallBuyException?: boolean;
  /** v3.7.0 (CR-033 G-2): the CamelCase form for marketplaces; absent = built from the newest intake `words`. */ displayName?: string | null;
  /** v4.0.0 (CR-045/046): horizon, and the scout's STRe with its reason (the renewal maths gate). */ horizon?: Horizon; stre?: number; streReason?: string;
  /** v3.7.0 (CR-033 G-9): `at_first_expiry` = no renewal planned (drop_date = expiry); default `after_one_renewal`. */ dropPolicy?: DropPolicy;
}
export type Horizon = 'evergreen' | 'trend' | 'regulation';
export type DropPolicy = 'after_one_renewal' | 'at_first_expiry';
export interface BuyCtx { idempotencyKey: string; requestHash: string; auditId: string }
export interface BuyResult { status: number; body: Record<string, unknown> }
export interface BuyDeps {
  db: Kysely<Database>; adapters: RegistrarAdapter[]; checkService: CheckService; rdap: RdapFn; now: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: { warn(o: object, m: string): void; error(o: object, m: string): void };
}

/** Everything the purchase phase needs once checks 1–10 passed. */
export interface Approved {
  input: BuyInput; ctx: BuyCtx; category: Category; plan: ListingPlan | null; comps: Comp[]; rationale: string | null; pricing: PricingSettings; approvedAt: Date;
  check: CheckResult; winner: EvaluatedQuote; cost: number; adapter: RegistrarAdapter; wouldBeBlocked: BuyBlock | null; latestRun: Awaited<ReturnType<typeof latestScreeningRun>> | null; trancheId: string | null;
  /** CR-030: the small-buy exception is requested (flag + "small buy" in the approval line); its price and weekly checks apply and the purchase is marked. */
  smallBuy: boolean;
  /** v3.7.0: the display name to store (given, or built from the intake words), and the drop policy. */
  displayName: string | null; dropPolicy: DropPolicy;
  horizon: Horizon; screeningGroup: 'passed' | 'borderline' | null; math: RenewalMath | null; streReason: string | null;
  settings: { max_domains: number; lander_target: string };
  /** Dry run only: registrar account-state findings that a real buy would refuse on (founder rule 6). */
  accountWarnings?: string[];
}

/** v4.0.0 (CR-045 item 2): a trend or regulation name should drop at its first expiry. */
export function horizonWarnings(a: { horizon: Horizon; dropPolicy: DropPolicy }): string[] {
  return a.horizon !== 'evergreen' && a.dropPolicy !== 'at_first_expiry'
    ? [`HORIZON_DROP_POLICY_MISMATCH: horizon is ${a.horizon} but drop_policy is ${a.dropPolicy}; a ${a.horizon} name should be bought with drop_policy at_first_expiry`] : [];
}

export function policyFields(policy: DropPolicy, renewalCents: number | null) {
  return { drop_policy: policy, renewal_committed_cents: policy === 'at_first_expiry' ? 0 : renewalCents ?? 0, drop_policy_line: policyLine(policy, renewalCents) };
}

/** The drop policy in words (`drop_policy_line`). */
function policyLine(policy: DropPolicy, renewalCents: number | null): string {
  return policy === 'at_first_expiry' ? 'Drop policy: at first expiry (no renewal).' : `Drop policy: after one renewal (${formatUsd(renewalCents ?? 0)} renewal committed).`;
}

/** sell_plan_line carries the policy when it is not the default (the default line stays equal to GET /pricing/preview's). */
export function withPolicyLine(view: object, policy: DropPolicy, renewalCents: number | null): object {
  const v = view as { sell_plan_line: string | null };
  if (!v.sell_plan_line || policy === 'after_one_renewal') return view;
  return { ...v, sell_plan_line: `${v.sell_plan_line} ${policyLine(policy, renewalCents)}` };
}
