// G8 tier (CAP-24) and DEMAND-2: the rule tier from the item's other results. A result that is absent (not in the plan) or not usable
// leaves its feature null, and a null feature makes its conditions `unknown` (never read as a pass or a fail).
import { condHolds, evaluateTier, type Thresholds, type TierFeatures } from '../tier.js';
import { findSellers, sellersFreshHours, tierUsesSellers, unknownCount, verifySellers } from '../sellers.js';
import type { SelectionValuesT } from '../settings.js';
import { outcome, type Check, type CheckContext, type CheckId } from '../types.js';

const USABLE = ['PASS', 'PASS_WITH_NOTE', 'FLAG'];

/** Which check supplies each tier feature. */
const SOURCE_OF: Record<string, CheckId> = {
  registered_share: 'census', prior_history: 'history', alt_tld_before_n: 'ext_dates',
  n_words: 'form', sld_chars: 'form', gform1_pass: 'form', short: 'form',
};

function resultOf(ctx: CheckContext, id: CheckId) {
  const r = ctx.latest(id);
  return r && USABLE.includes(r.status) ? r : null;
}
const fieldsOf = (ctx: CheckContext, id: CheckId): Record<string, unknown> | null => resultOf(ctx, id)?.fields ?? null;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bit = (v: unknown): 0 | 1 | null => (v === 1 || v === true ? 1 : v === 0 || v === false ? 0 : null);

export function tierFeatures(ctx: CheckContext): TierFeatures {
  const census = fieldsOf(ctx, 'census');
  const history = fieldsOf(ctx, 'history');
  const ext = fieldsOf(ctx, 'ext_dates');
  const form = fieldsOf(ctx, 'form');
  return {
    registered_share: num(census?.registered_share), prior_history: bit(history?.prior_history), alt_tld_before_n: num(ext?.alt_tld_before_n),
    n_words: num(form?.word_count), sld_chars: num(form?.sld_len), is_geo: ctx.item.lane === 'S2' ? 1 : 0,
    gform1_pass: bit(form?.gform1_pass), short: bit(form?.short),
    lane: ctx.item.lane ?? null, sellers_verified_n: 0, sellers_unknown_n: 0,
  };
}

type Cond = { f: string; op: string; v: string | number | (string | number)[] } | { tier: string };

/**
 * The feature names that decided a tier's clause: every condition of an `all` clause, but only the conditions that are true in an `any`
 * clause (a true alternative decided it; an unread alternative did not). References to other tiers are followed.
 */
function decidingFeatures(tier: string, t: SelectionValuesT['tier'], features: TierFeatures, thresholds: Thresholds, seen = new Set<string>()): Set<string> {
  const out = new Set<string>();
  if (seen.has(tier)) return out;
  seen.add(tier);
  const c = (t.clauses as Record<string, { all: Cond[] } | { any: Cond[] } | undefined>)[tier];
  if (!c) return out;
  const isAny = 'any' in c;
  for (const cond of isAny ? c.any : c.all) {
    if ('tier' in cond) {
      if (isAny && !(deciding(cond.tier, t, features, thresholds))) continue;
      for (const f of decidingFeatures(cond.tier, t, features, thresholds, seen)) out.add(f);
    } else {
      const x = (features as unknown as Record<string, number | string | null>)[cond.f];
      if (isAny && (x === null || x === undefined || !condHolds(cond as Parameters<typeof condHolds>[0], x, thresholds, features.lane ?? null))) continue;
      out.add(cond.f);
    }
  }
  return out;
}
/** Whether the named tier's clause is true (all conditions true, or any one for an `any` clause). */
function deciding(tier: string, t: SelectionValuesT['tier'], features: TierFeatures, thresholds: Thresholds): boolean {
  return evaluateTier(features, t, thresholds).clauses[tier] === 'true';
}

export const tierCheck: Check = {
  id: 'tier',
  gate: 'G8',
  ruleIds: ['CAP-24', 'DEMAND-2'],
  lists: [],
  async run(ctx) {
    const features = tierFeatures(ctx);
    // v3.3.0 (CR-023 B): the sellers list is read and its pages fetched only when a tier clause uses `sellers_verified_n`.
    let sellers: Record<string, unknown> | null = null;
    let sellerCalls = 0;
    if (tierUsesSellers(ctx.settings.tier)) {
      const found = await findSellers(ctx.db, ctx.item.domain, { runId: ctx.run.id, nowMs: ctx.now(), freshHours: sellersFreshHours(ctx.settings) });
      if (found.state === 'none') sellers = { source: null, verified_n: 0, unknown_n: 0, entries: [] };
      else if (found.state === 'stale') {
        features.sellers_verified_n = null;
        features.sellers_unknown_n = null;
        sellers = { source: found.source, list_at: found.at!.toISOString(), verified_n: null, unknown_n: null, reason_code: 'SELLERS_STALE', entries: [] };
      } else {
        const v = await verifySellers(ctx, found.list);
        sellerCalls = v.upstreamCalls;
        features.sellers_verified_n = v.results.filter((r) => r.verified === true).length;
        features.sellers_unknown_n = unknownCount(v.results);
        sellers = { source: found.source, list_at: found.at!.toISOString(), verified_n: features.sellers_verified_n, unknown_n: features.sellers_unknown_n, entries: v.results };
      }
    }
    const t = evaluateTier(features, ctx.settings.tier, ctx.settings.thresholds);
    // Inputs that came from a FLAG result (e.g. history FLAG): recorded; the verdict still needs a human before any buy (buy_hold now, the pack later).
    const flaggedChecks = [...new Set(Object.entries(SOURCE_OF).filter(([f]) => (features as unknown as Record<string, unknown>)[f] !== null).map(([, c]) => c))]
      .filter((c) => ctx.latest(c)?.status === 'FLAG');
    const decidingTiers = [t.fired, ctx.settings.tier.demand2_pass_tiers.find((n) => t.clauses[n] === 'true')].filter((x): x is string => !!x);
    const used = new Set(decidingTiers.flatMap((n) => [...decidingFeatures(n, ctx.settings.tier, features, ctx.settings.thresholds)]));
    const decidedByFlag = flaggedChecks.some((c) => [...used].some((f) => SOURCE_OF[f] === c));
    const fields = { ...t, ...(decidedByFlag && { tier_exact: false }), flagged_inputs: flaggedChecks, ...(sellers && { sellers }) } as unknown as Record<string, unknown>;
    const extra = { upstreamCalls: sellerCalls };
    if (t.demand2 === 'FAIL') return outcome('FAIL', 'DEMAND2_FAIL', 'No tier that passes DEMAND-2 applies', fields, extra);
    if (t.demand2 === 'UNKNOWN') return outcome('UNKNOWN', 'DEMAND2_UNDECIDED', 'A feature the tier rules need is missing, so DEMAND-2 is undecided', fields, extra);
    if (decidedByFlag) return outcome('PASS_WITH_NOTE', 'TIER_FROM_FLAGGED_INPUT', `The tier was decided with an input from a FLAG result (${flaggedChecks.join(', ')})`, fields, extra);
    return outcome('PASS', null, null, fields, extra);
  },
};
