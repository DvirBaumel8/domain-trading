// G8 tier (CAP-24) and DEMAND-2: the rule tier from the item's other results. A result that is absent (not in the plan) or not usable
// leaves its feature null, and a null feature makes its conditions `unknown` (never read as a pass or a fail).
import { evaluateTier, type TierFeatures } from '../tier.js';
import { outcome, type Check, type CheckContext, type CheckId } from '../types.js';

const USABLE = ['PASS', 'PASS_WITH_NOTE', 'FLAG'];

function fieldsOf(ctx: CheckContext, id: CheckId): Record<string, unknown> | null {
  const r = ctx.latest(id);
  return r && USABLE.includes(r.status) ? r.fields : null;
}
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
  };
}

export const tierCheck: Check = {
  id: 'tier',
  gate: 'G8',
  ruleIds: ['CAP-24', 'DEMAND-2'],
  lists: [],
  async run(ctx) {
    const t = evaluateTier(tierFeatures(ctx), ctx.settings.tier, ctx.settings.thresholds);
    const fields = { ...t } as unknown as Record<string, unknown>;
    if (t.demand2 === 'FAIL') return outcome('FAIL', 'DEMAND2_FAIL', 'No tier that passes DEMAND-2 applies', fields);
    if (t.demand2 === 'UNKNOWN') return outcome('UNKNOWN', 'DEMAND2_UNDECIDED', 'A feature the tier rules need is missing, so DEMAND-2 is undecided', fields);
    return outcome('PASS', null, null, fields);
  },
};
