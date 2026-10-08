// G8 NameBio keyword counts (CAP-11): a score feature (D, retail demand), never a gate. DISABLED while `sources.namebio` is false
// (the default: see ../namebio.ts). A disabled, stale or missing source is UNKNOWN, and an UNKNOWN feature scores 0 points.
import { bandByMin } from '../money.js';
import { keywordCounts } from '../namebio.js';
import { outcome, type Check, type CheckContext } from '../types.js';
import { formFieldsOf } from './form.js';

/** Geo: the trade token. Non-geo: the first and the last non-generic token (CR-001 CAP-11). */
export function namebioKeywords(ctx: CheckContext): string[] {
  const f = formFieldsOf(ctx);
  if (ctx.item.lane === 'S2') return f.trade ? [f.trade] : ctx.item.trade ? [ctx.item.trade.toLowerCase()] : [];
  const k = f.keywords;
  return k.length === 0 ? [] : [...new Set([k[0]!, k[k.length - 1]!])];
}

export const namebioCheck: Check = {
  id: 'namebio',
  gate: 'G8',
  ruleIds: ['CAP-11', 'SCORE-D'],
  lists: [],
  async run(ctx) {
    const nul = { keywords: {}, retail_start: null, retail_end: null, geo_d_raw: null, cache_date: null, attribution: ctx.settings.namebio.attribution };
    if (!ctx.settings.sources.namebio) return outcome('UNKNOWN', 'SOURCE_DISABLED', 'NameBio is switched off (sources.namebio)', nul);
    const kws = namebioKeywords(ctx);
    if (kws.length === 0) return outcome('UNKNOWN', 'NO_KEYWORDS', 'The name has no keyword to look up', nul);
    const r = await keywordCounts(ctx.db, kws, ctx.settings, ctx.now);
    const fields = { ...nul, keywords: r.stats, cache_date: r.cache_date, attribution: r.attribution, source: r.source };
    const asOf = r.cache_date ? new Date(`${r.cache_date}T00:00:00Z`) : null;
    if (r.cache_date === null || r.stale) return outcome('UNKNOWN', 'STALE_DATA', 'The NameBio cache is missing or older than namebio.max_cache_age_hours', fields, { dataAsOf: asOf });
    const first = r.stats[kws[0]!] ?? null;
    const last = r.stats[kws[kws.length - 1]!] ?? null;
    const retailStart = first?.start_count ?? null;
    const retailEnd = last?.end_count ?? null;
    const geoRaw = ctx.item.lane === 'S2' && retailStart !== null && retailEnd !== null
      ? bandByMin(ctx.settings.score.d_bands, retailStart + retailEnd)
      : null;
    const out = { ...fields, retail_start: retailStart, retail_end: retailEnd, geo_d_raw: geoRaw };
    const missing = kws.filter((k) => r.stats[k] === null);
    if (missing.length === kws.length) return outcome('UNKNOWN', 'NOT_IN_CACHE', `No keyword is in the NameBio cache (${missing.join(', ')})`, out, { dataAsOf: asOf });
    if (missing.length > 0) return outcome('PASS_WITH_NOTE', 'NOT_IN_CACHE', `Not in the NameBio cache: ${missing.join(', ')}`, out, { dataAsOf: asOf });
    return outcome('PASS', null, null, out, { dataAsOf: asOf });
  },
};
