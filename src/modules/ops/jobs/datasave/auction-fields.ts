// v5.49.0 (P3): the free demand fields of a GoDaddy inventory row, read for godaddy_auctions_live. Pure. Every field is null when the row does not carry it or it is not a finite number >= 0
// (a string, NaN, a negative, a value past int4 is "not known", never 0). `semrushCpc` is a float in USD and is stored as integer cents.
const INT4_MAX = 2_147_483_647;

export interface DemandFields {
  exact_match_tlds: number | null; developed_tlds: number | null; keyword_registrations: number | null; search_volume: number | null; cpc_cents: number | null;
}

const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= INT4_MAX ? Math.round(v) : null);

export function demandFields(r: { exactMatchTlds?: unknown; developedTlds?: unknown; keywordRegistrations?: unknown; semrushSearchVolume?: unknown; semrushCpc?: unknown }): DemandFields {
  const usd = typeof r.semrushCpc === 'number' && Number.isFinite(r.semrushCpc) && r.semrushCpc >= 0 ? Math.round(r.semrushCpc * 100) : null;
  return {
    exact_match_tlds: count(r.exactMatchTlds), developed_tlds: count(r.developedTlds), keyword_registrations: count(r.keywordRegistrations), search_volume: count(r.semrushSearchVolume),
    cpc_cents: usd !== null && usd <= INT4_MAX ? usd : null,
  };
}

/** Merge of the same name seen in several files: the first known value stays (as age, valuation and page views do). */
export const mergeDemand = (a: DemandFields | undefined, b: DemandFields): DemandFields => ({
  exact_match_tlds: a?.exact_match_tlds ?? b.exact_match_tlds, developed_tlds: a?.developed_tlds ?? b.developed_tlds, keyword_registrations: a?.keyword_registrations ?? b.keyword_registrations,
  search_volume: a?.search_volume ?? b.search_volume, cpc_cents: a?.cpc_cents ?? b.cpc_cents,
});
