// G9 price (CAP-18): EV, renew ratio at the BIN and at the floor, LANDER-1, score. Every number comes from `evaluateMoney` (never
// duplicated here). Inputs: the BIN (item, else the default for the lane), the quote, the tier and the NameBio counts of this run.
import { formatUsd, dollarsToCents } from '../../money.js';
import { currentSettings } from '../../pricing/settings.js';
import { evaluateMoney, syllableCount } from '../money.js';
import { CHECK_IDS } from '../settings.js';
import { outcome, type Check, type CheckContext } from '../types.js';
import { formFieldsOf } from './form.js';
import { quoteIsStale } from './quote.js';

const OK = ['PASS', 'PASS_WITH_NOTE'];

export const priceCheck: Check = {
  id: 'price',
  gate: 'G9',
  ruleIds: ['CAP-18', 'EV-1', 'RATIO-1', 'LANDER-1'],
  lists: [],
  async run(ctx) {
    const sel = ctx.settings;
    const pricing = await currentSettings(ctx.db, new Date(ctx.now()));
    const geo = ctx.item.lane === 'S2';
    const grade = geo ? (ctx.item.price_grade ?? sel.price.geo_default_grade) : null;
    let bin: number | null = null;
    if (ctx.item.bin_usd !== undefined) bin = dollarsToCents(ctx.item.bin_usd);
    else if (geo) bin = grade === 'strong' ? pricing.geoBinStrongCents : pricing.geoBinWeakerCents;
    else bin = pricing.nongeoDefaultBinCents;
    if (bin === null) return outcome('UNKNOWN', 'BIN_REQUIRED', 'The name has no bin_usd and the current pricing settings have no default non-geo BIN', {});

    const q = ctx.latest('quote');
    if (!q || !OK.includes(q.status) || q.fields.renewal_cents == null || q.fields.first_year_cents == null) {
      return outcome('UNKNOWN', 'NO_QUOTE', 'The price needs a first-year and a renewal quote', { bin_cents: bin });
    }
    if (quoteIsStale(q.fields, sel.quote, ctx.now())) {
      return outcome('UNKNOWN', 'STALE_DATA', 'The quote is older than quote.max_age_hours (manual: quote.manual_max_age_days)', { bin_cents: bin, quoted_at: q.fields.quoted_at ?? null });
    }
    const tierRow = ctx.latest('tier');
    const tier = (tierRow && tierRow.fields.tier ? (tierRow.fields.tier as string) : 'none') as 'A' | 'I' | 'B' | 'G' | 'none';
    const nb = ctx.latest('namebio');
    const nbf = nb && OK.includes(nb.status) ? nb.fields : null;
    const f = formFieldsOf(ctx);
    const history = ctx.latest('history');
    const riskFlag = CHECK_IDS.some((c) => ctx.latest(c)?.status === 'FLAG');
    const money = evaluateMoney({
      lane: ctx.item.lane, tier, binCents: bin, priceGrade: grade, leadsAB: ctx.item.leads_ab,
      firstYearCents: q.fields.first_year_cents as number, renewalCents: q.fields.renewal_cents as number,
      landerNs: 'afternic', retailStart: (nbf?.retail_start as number | null | undefined) ?? null, retailEnd: (nbf?.retail_end as number | null | undefined) ?? null,
      form: { geoBandRaw: geo ? f.geo_length_band : null, sldLen: f.sld_len, wordCount: f.word_count, short: f.short, syllables: syllableCount(f.sld) },
      riskFlag, intentRaw: null, timingRaw: null, extBusinessRaw: null, parkedOnly: history?.fields.parked_only === true,
    }, sel, pricing, ctx.settingsLabel);
    const fields = { ...money, bin_cents: bin, bin: formatUsd(bin), floor: formatUsd(money.floor_cents) } as unknown as Record<string, unknown>;
    const p = money.passes;
    const cov = p.coverage || !sel.score.coverage_gate;
    if (p.ev1 === null || p.ratio1 === null) return outcome('UNKNOWN', 'NO_QUOTE', 'EV or the renew ratio could not be computed', fields);
    if (!p.ev1) return outcome('FAIL', 'EV_NOT_POSITIVE', `Expected value ${formatUsd(money.ev_cents!)} is not above zero`, fields);
    if (!p.ratio1) return outcome('FAIL', 'RATIO_BELOW_1', 'The renewal ratio at the BIN or at the floor is below 1', fields);
    if (!p.lander1) return outcome('FAIL', 'LANDER1_FAIL', money.lander1.message ?? 'LANDER-1 failed', fields);
    if (!cov) return outcome('FAIL', 'COVERAGE_LOW', `Data coverage ${money.data_coverage} is below ${sel.score.coverage_min}`, fields);
    return outcome('PASS', null, null, fields);
  },
};
