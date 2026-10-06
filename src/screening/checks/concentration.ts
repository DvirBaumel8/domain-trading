// G3 portfolio concentration (CAP-04, CONCENTRATION-1): at most `concentration.max_per_attr` names per city, trade, regime
// or keyword across owned/listed names + higher-ranked names of this run; the geo cap per tranche; the lane share.
import { analyzeForm, type FormResult } from '../form.js';
import { outcome, type Check, type CheckContext } from '../types.js';
import { formFieldsOf } from './form.js';

interface Attrs { domain: string; city: string | null; trade: string | null; regime: string | null; keywords: string[] }
const attrsOf = (domain: string, f: Pick<FormResult, 'city' | 'trade' | 'regime' | 'keywords'>): Attrs => ({ domain, city: f.city, trade: f.trade, regime: f.regime, keywords: f.keywords });

interface Portfolio { attrs: Attrs[]; geo: number }

/** Domains in the portfolio (pending_purchase, owned, listed, delisted), tokenised once per run. Not a screening result of any run. */
async function portfolioOf(ctx: CheckContext): Promise<Portfolio> {
  const hit = ctx.shared.get('portfolio') as Portfolio | undefined;
  if (hit) return hit;
  const rows = await ctx.db.selectFrom('domains').select(['domain', 'category'])
    .where('status', 'in', ['pending_purchase', 'owned', 'listed', 'delisted']).execute();
  const attrs: Attrs[] = [];
  for (const r of rows) {
    try { attrs.push(attrsOf(r.domain, analyzeForm(r.domain, 'S3', ctx.lexicon, ctx.settings.form))); } catch { /* not a .com name the tokenizer reads */ }
  }
  const p = { attrs, geo: rows.filter((r) => r.category === 'geo').length };
  ctx.shared.set('portfolio', p);
  return p;
}

/** Members of a tranche that are geo names. Task 8 (tranches) provides the real count; until then no tranche has members. */
async function trancheGeoMembers(_ctx: CheckContext, _trancheId: string): Promise<number> {
  return 0;
}

export const concentrationCheck: Check = {
  id: 'concentration',
  gate: 'G3',
  ruleIds: ['CONCENTRATION-1'],
  lists: ['trade', 'regime', 'tech', 'generic_head', 'state', 'legal', 'city_extra', 'dictionary_extra'],
  async run(ctx) {
    const cap = ctx.settings.concentration.max_per_attr;
    const form = formFieldsOf(ctx);
    const me = attrsOf(ctx.item.domain, form);
    const portfolio = await portfolioOf(ctx);
    const ahead = ctx.ahead();
    const aheadAttrs: Attrs[] = [];
    for (const a of ahead) {
      const f = a.latest('form');
      if (f && Array.isArray(f.fields.tokens)) aheadAttrs.push(attrsOf(a.item.domain, f.fields as unknown as FormResult));
    }
    const others = [...portfolio.attrs, ...aheadAttrs];
    const isGeo = ctx.item.lane === 'S2';

    const share = (() => {
      const total = portfolio.attrs.length + ahead.length + 1;
      const inLane = ahead.filter((a) => a.item.lane === ctx.item.lane).length + 1 + (isGeo ? portfolio.geo : 0);
      return { lane: ctx.item.lane, in_lane: inLane, total, share: Math.round((inLane / total) * 1000) / 1000, max: ctx.settings.concentration.max_lane_share, enforced: ctx.settings.concentration.lane_share_enforced };
    })();
    const fields: Record<string, unknown> = { city: me.city, trade: me.trade, regime: me.regime, keywords: me.keywords, cap, lane_share: share };

    const fail = (code: string, attribute: string, value: string, blocking: string[]) =>
      outcome('FAIL', code, `${blocking.length} name(s) already use ${attribute} "${value}" (cap ${cap}): ${blocking.join(', ')}`,
        { ...fields, details: { attribute, value, count: blocking.length, cap, blocking } });

    const blockers = (pick: (a: Attrs) => boolean) => others.filter(pick).map((a) => a.domain);
    for (const [attr, code, value, pick] of [
      ['city', 'CONCENTRATION_CITY', me.city, (a: Attrs) => a.city === me.city],
      ['trade', 'CONCENTRATION_TRADE', me.trade, (a: Attrs) => a.trade === me.trade],
      ['regime', 'CONCENTRATION_REGIME', me.regime, (a: Attrs) => a.regime === me.regime],
    ] as const) {
      if (!value) continue;
      const b = blockers(pick);
      if (b.length >= cap) return fail(code, attr, value, b);
    }
    for (const kw of me.keywords) {
      const b = blockers((a) => a.keywords.includes(kw));
      if (b.length >= cap) return fail('CONCENTRATION_KEYWORD', 'keyword', kw, b);
    }
    if (isGeo && ctx.run.trancheId) {
      const inTranche = await trancheGeoMembers(ctx, ctx.run.trancheId);
      const aheadGeo = ahead.filter((a) => a.item.lane === 'S2').map((a) => a.item.domain);
      if (inTranche + aheadGeo.length >= ctx.settings.tranche.geo_max) {
        return outcome('FAIL', 'GEO_CAP', `The tranche already has ${inTranche + aheadGeo.length} geo name(s) (geo_max ${ctx.settings.tranche.geo_max})`,
          { ...fields, details: { attribute: 'geo', cap: ctx.settings.tranche.geo_max, tranche_members: inTranche, blocking: aheadGeo } });
      }
    }
    if (share.enforced && share.share > share.max) {
      return outcome('FAIL', 'LANE_SHARE', `Lane ${share.lane} would hold ${Math.round(share.share * 100)}% of the portfolio (max ${Math.round(share.max * 100)}%)`, fields);
    }
    if (isGeo && (!me.city || !me.trade)) {
      return outcome('FLAG', 'GEO_ATTR_MISSING', `Geo name without ${[!me.city ? 'a city' : '', !me.trade ? 'a trade' : ''].filter(Boolean).join(' and ')}: concentration cannot be judged`, fields);
    }
    return outcome('PASS', null, null, fields);
  },
};
