// CAP-18 (v9.1 formulas, v10 priors): P(sale), EV, renew ratio at the BIN and at the floor, LANDER-1, score 0-100. Pure.
// Every rate, factor and band comes from the selection settings; the floor from the pricing settings (one formula, priceFormula).
import { priceFormula } from '../listing/index.js';
import { laneList } from '../listing/index.js';
import type { PricingSettings } from '../listing/index.js';
import type { Lane } from './form.js';
import type { SelectionValuesT } from './settings.js';
import type { TierResult } from './tier.js';

export interface MoneyInput {
  lane: Lane; tier: TierResult['tier']; binCents: number; priceGrade: 'strong' | 'weaker' | null; leadsAB: number;
  firstYearCents: number | null; renewalCents: number | null; landerNs: 'afternic' | 'other'; retailEnd: number | null; retailStart: number | null;
  /** null: the form is not known, so A-Form is unknown (0 points) */
  form: { geoBandRaw: number | null; sldLen: number; wordCount: number; short: 0 | 1; syllables: number | null } | null;
  riskFlag: boolean;
  intentRaw: number | null; timingRaw: number | null; extBusinessRaw: null;
  /** Prior history is parked pages only (v10 treats it as positive: parked_penalty is 0 by default). */
  parkedOnly?: boolean;
}

type Factor = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
export interface MoneyResult {
  p_passive: number; p_lead: number; n: number; P_sale: number; net_price_cents: number; lifetime_cost_cents: number | null;
  ev_cents: number | null; stre_eff_y1: number; ratio_at_bin: number | null; ratio_at_floor: number | null; floor_cents: number;
  bin_in_allowed_set: boolean | null; forbidden_band: boolean; lander1: { pass: boolean; reason: string | null; message: string | null };
  score_0_100: number; factors: Record<Factor, { raw: number | null; weight: number; points: number }>; data_coverage: number;
  passes: { ev1: boolean | null; ratio1: boolean | null; lander1: boolean; coverage: boolean }; model_version: string;
}

const round = (x: number, d: number): number => Math.round(x * 10 ** d) / 10 ** d;
const roundHalfUp = (x: number): number => Math.floor(x + 0.5);

/** First band whose `max` is at least `x` (a null max is open-ended). */
const byMax = (bands: { max: number | null; raw: number }[], x: number): number => (bands.find((b) => b.max === null || x <= b.max) ?? bands[bands.length - 1]!).raw;

/** The raw value of the band with the highest `min` that `x` reaches (bands in any order); the lowest band when none is reached. */
export function bandByMin(bands: { min: number; raw: number }[], x: number): number {
  const sorted = [...bands].sort((a, b) => b.min - a.min);
  return (sorted.find((b) => x >= b.min) ?? sorted[sorted.length - 1]!).raw;
}

/** The geo "floor" for the ratio is the bottom of the geo ladder: the lowest list price inside the geo band. The pricing floor of a geo name stays its BIN. */
export function geoLadderBottomCents(p: PricingSettings): number {
  return laneList('geo', p)[0] ?? p.geoBinMinCents;
}

/** Counts vowel groups: a rough syllable count that is enough for the A-Form band. */
export function syllableCount(sld: string): number {
  return Math.max(1, (sld.match(/[aeiouy]+/g) ?? []).length);
}

function landerCheck(i: MoneyInput, sel: SelectionValuesT, p: PricingSettings, inSet: boolean | null): MoneyResult['lander1'] {
  const ok = { pass: true, reason: null, message: null };
  const geo = i.lane === 'S2';
  // Fail closed: without a price list no BIN (geo or not) can be shown to be allowed.
  if (inSet === null) return { pass: false, reason: 'PRICE_LIST_MISSING', message: 'pricing_settings v3 not created yet: there is no price list to check the BIN against' };
  if (geo) return inSet === false ? { pass: false, reason: 'BIN_NOT_IN_PRICE_LIST', message: 'A geo BIN must be a geo price on the price list' } : ok;
  if (!inSet) return { pass: false, reason: 'BIN_NOT_IN_PRICE_LIST', message: 'The BIN is not on the non-geo price list' };
  const cap = Math.max(...laneList('nongeo', p).filter((v) => !p.landerExceptionBinsCents.includes(v)));
  if (i.binCents <= cap) return ok;
  const exception = i.leadsAB >= sel.lander.exception_ab_min && (i.retailEnd ?? -1) >= sel.lander.exception_retail_end_min;
  return exception ? ok : { pass: false, reason: 'LANDER_EXCEPTION_NOT_MET', message: 'A BIN above the standard cap needs the LANDER-1 exception evidence' };
}

export function evaluateMoney(i: MoneyInput, sel: SelectionValuesT, pricing: PricingSettings, settingsLabel: string): MoneyResult {
  const useTier = !sel.lead.gate_enabled && i.tier !== 'none';
  const p_passive = useTier ? (sel.tier.p_passive[i.tier as 'A' | 'I' | 'B' | 'G'] ?? sel.priors_v91.p_passive[i.lane]) : sel.priors_v91.p_passive[i.lane];
  const p_lead = sel.lead.p_lead[i.lane];
  const n = i.leadsAB;
  const years = sel.money.hold_years;
  const P_sale = 1 - (1 - p_passive) ** years * (1 - p_lead) ** n;
  const stre = 1 - (1 - p_passive) * (1 - p_lead) ** n;
  const factor = i.landerNs === 'afternic' ? sel.money.net_factor_afternic : sel.money.net_factor_other;
  const net = Math.round(i.binCents * factor);
  const lifetime = i.firstYearCents !== null && i.renewalCents !== null ? i.firstYearCents + i.renewalCents : null;
  const ev = lifetime === null ? null : Math.round(P_sale * net) - lifetime;
  const geo = i.lane === 'S2';
  const floor = geo ? geoLadderBottomCents(pricing) : priceFormula(i.binCents, pricing).floorCents;
  const ratio = (price: number): number | null => (i.renewalCents === null ? null : (price * factor * stre) / i.renewalCents);
  const rBin = ratio(i.binCents);
  const rFloor = ratio(floor);
  const inSet = pricing.allowedBinsCents === null ? null : laneList(geo ? 'geo' : 'nongeo', pricing).includes(i.binCents);
  const lander1 = landerCheck(i, sel, pricing, inSet);

  // Score (tiebreaker only). A null raw is 0 points and does not count as data.
  const w = sel.score.weights[i.lane];
  const sc = sel.score;
  let aRaw: number | null = null;
  if (i.form) {
    if (geo) aRaw = i.form.geoBandRaw ?? byMax(sel.form.geo_bands.map((b) => ({ max: b.max_chars, raw: b.raw })), i.form.sldLen);
    else if (i.form.short === 1) aRaw = 10; // FORM-2: short names take the maximum A-Form
    else {
      // mean(length, words, pronounceability); a syllable count that is not known is left out of the mean
      const parts = [byMax(sc.nongeo_len_bands, i.form.sldLen), byMax(sc.words_bands, i.form.wordCount)];
      if (i.form.syllables !== null) parts.push(byMax(sc.syllable_bands, i.form.syllables));
      aRaw = parts.reduce((a, b) => a + b, 0) / parts.length;
    }
  }
  const gate = sel.lead.ab_min[i.lane];
  const bRaw = n === 0 || n < gate ? 0 : n >= 2 * gate ? 10 : n >= 1.5 * gate ? 8 : 6;
  const retail = i.retailStart === null && i.retailEnd === null ? null : (i.retailStart ?? 0) + (i.retailEnd ?? 0);
  const dRaw = retail === null ? null : bandByMin(sc.d_bands, retail);
  const gRaw = i.riskFlag ? sc.risk_raw.flag : sc.risk_raw.clean;
  const raws: Record<Factor, number | null> = { A: aRaw, B: bRaw, C: i.intentRaw, D: dRaw, E: i.timingRaw, F: i.extBusinessRaw, G: gRaw };
  const factors = {} as MoneyResult['factors'];
  let total = 0;
  let covered = 0;
  for (const k of Object.keys(raws) as Factor[]) {
    const raw = raws[k];
    let points = raw === null ? 0 : (raw * w[k]) / 10;
    if (k === 'D') points = Math.min(points, sc.retail_only_max_points);
    factors[k] = { raw, weight: w[k], points: round(points, 4) };
    total += points;
    if (raw !== null) covered += w[k];
  }
  if (i.parkedOnly) total -= sc.parked_penalty;
  const score = Math.max(0, Math.min(100, roundHalfUp(total)));
  const coverage = round(covered / 100, 4);

  return {
    p_passive, p_lead, n, P_sale: round(P_sale, 6), net_price_cents: net, lifetime_cost_cents: lifetime, ev_cents: ev,
    stre_eff_y1: round(stre, 6), ratio_at_bin: rBin === null ? null : round(rBin, 4), ratio_at_floor: rFloor === null ? null : round(rFloor, 4),
    floor_cents: floor, bin_in_allowed_set: inSet,
    forbidden_band: sel.price.forbidden_bands_cents.some(([lo, hi]) => i.binCents >= lo && i.binCents <= hi),
    lander1, score_0_100: score, factors, data_coverage: coverage,
    passes: {
      ev1: ev === null ? null : ev > 0,
      ratio1: rBin === null || rFloor === null ? null : rBin >= 1 && rFloor >= 1,
      lander1: lander1.pass,
      coverage: coverage >= sc.coverage_min,
    },
    model_version: `selection:${settingsLabel}/pricing:v${pricing.version}`,
  };
}
