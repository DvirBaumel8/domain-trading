// G1 TYPO-1 (CAP-02): a name within `typo.max_edit_distance` of a popular site's SLD (top `typo.top_n` of the popularity list) fails.
// The list is the Majestic Million (see ../popularity.ts). A missing or old snapshot is UNKNOWN, never "no typo".
import { editDistanceWithin, latestPopularity } from '../popularity.js';
import { outcome, type Check } from '../types.js';

const DAY_MS = 86_400_000;
const ATTRIBUTION = 'Majestic Million, Majestic (https://majestic.com), CC BY 3.0';

export const typoCheck: Check = {
  id: 'typo',
  gate: 'G1',
  ruleIds: ['TYPO-1', 'CAP-02'],
  lists: [],
  async run(ctx) {
    const nul = { typo_list_date: null, list_id: null, typo_matches: [] as unknown[], attribution: ATTRIBUTION };
    if (!ctx.settings.sources.popularity) return outcome('UNKNOWN', 'SOURCE_DISABLED', 'The popularity list is switched off (sources.popularity)', nul);
    const list = await latestPopularity(ctx.db);
    if (!list) return outcome('UNKNOWN', 'STALE_DATA', 'No popularity list has been downloaded yet (the daily referenceRefresh step fetches it)', nul);
    const t = ctx.settings.typo;
    const base = {
      typo_list_date: list.listDate, list_id: list.listId, attribution: ATTRIBUTION,
      // A top_n above the stored rows means the screen covers fewer names than the setting says.
      ...(t.top_n > list.rows && { typo_note: 'TOP_N_EXCEEDS_LIST', list_rows: list.rows }),
    };
    const asOf = new Date(`${list.listDate}T00:00:00Z`);
    if (Math.floor((ctx.now() - asOf.getTime()) / DAY_MS) > t.max_list_age_days) { // whole calendar days: a list dated D is 7 days old all day on D+7
      return outcome('UNKNOWN', 'STALE_DATA', `The popularity list is from ${list.listDate}, over ${t.max_list_age_days} days old`, { ...base, typo_matches: [] }, { dataAsOf: asOf });
    }
    const sld = ctx.item.domain.replace(/\.com$/, '');
    const matches: { domain: string; rank: number; distance: number }[] = [];
    for (const [popular, rank] of list.ranks) {
      if (rank > t.top_n) continue;
      const d = editDistanceWithin(sld, popular, t.max_edit_distance);
      if (d !== null) matches.push({ domain: popular, rank, distance: d });
    }
    matches.sort((a, b) => a.distance - b.distance || a.rank - b.rank);
    if (matches.length > 0) {
      const m = matches[0]!;
      return outcome('FAIL', 'TYPO_MATCH', `"${sld}" is ${m.distance === 0 ? 'the same as' : `within ${m.distance} edit of`} "${m.domain}" (rank ${m.rank})`, { ...base, typo_matches: matches.slice(0, 10) }, { dataAsOf: asOf });
    }
    return outcome('PASS', null, null, { ...base, typo_matches: [] }, { dataAsOf: asOf });
  },
};
