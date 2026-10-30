// v5.80.0 (CR-099): when a sealed Dynadot day is too thin to read absences from. A day is LOW_COVERAGE when fewer than DYNADOT_MIN_COVERAGE of its planned
// pages came back (manifest `coverage.pages_ok` / `coverage.pages_planned`). The rule reads the page lists, so days sealed before 5.80.0 are judged the same way.
// A LOW_COVERAGE day is never evidence that a name is gone: the readers (market episodes and DQ, the datasave panel) leave it out.
import { sql, type RawBuilder } from 'kysely';

/** Share of the planned pages that must come back for a day to count as full coverage (the seal guard in migrations/1769200000000_v5-80-0.sql repeats 0.9). */
export const DYNADOT_MIN_COVERAGE = 0.9;

export interface PageCoverage { pages_planned?: unknown; pages_ok?: unknown }

/** Pages ok / pages planned, or null when the manifest carries no page lists (a GoDaddy file, a bot upload without coverage). */
export function coverageRatio(c: PageCoverage | null | undefined): number | null {
  if (!c || !Array.isArray(c.pages_planned) || !Array.isArray(c.pages_ok) || c.pages_planned.length === 0) return null;
  return c.pages_ok.length / c.pages_planned.length;
}

export const isLowCoverage = (c: PageCoverage | null | undefined): boolean => { const r = coverageRatio(c); return r !== null && r < DYNADOT_MIN_COVERAGE; };

/** SQL: true when the manifest row `alias` is a LOW_COVERAGE day (same rule as isLowCoverage). */
export function lowCoverageSql(alias: string): RawBuilder<boolean> {
  const c = sql.ref(`${alias}.coverage`);
  return sql<boolean>`coalesce(jsonb_typeof(${c}->'pages_planned') = 'array' and jsonb_typeof(${c}->'pages_ok') = 'array' and jsonb_array_length(${c}->'pages_planned') > 0
    and jsonb_array_length(${c}->'pages_ok')::numeric < ${sql.lit(DYNADOT_MIN_COVERAGE)} * jsonb_array_length(${c}->'pages_planned'), false)`;
}
