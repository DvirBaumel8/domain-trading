// v5.23.0 (CR-075 R-3): is the market data healthy? One state for GET /health (`dq_market`) and the /report warning DQ_MARKET_FAIL, read from the latest market_dq_runs row.
//   ok       the latest `dqMarket` run passed every check
//   alert    at least one check failed (the failed checks are named)
//   unknown  no run yet
import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';

export type MarketDqState = 'ok' | 'alert' | 'unknown';
export interface MarketDqStatus { state: MarketDqState; checked_at: Date | null; failed_checks: string[]; failures: { check: string; source?: string; day?: string; samples?: unknown }[] }

export async function marketDqStatus(db: Kysely<Database>): Promise<MarketDqStatus> {
  const r = await db.selectFrom('market_dq_runs').selectAll().orderBy('id', 'desc').limit(1).executeTakeFirst();
  if (!r) return { state: 'unknown', checked_at: null, failed_checks: [], failures: [] };
  const results = r.results as { check: string; status: string; source?: string; day?: string; detail?: { samples?: unknown } }[];
  // CR-096 (5.77.0): a failed check's sample rows (price_sanity) ride along
  const failures = results.filter((x) => x.status === 'fail').map((x) => ({ check: x.check, ...(x.source ? { source: x.source } : {}), ...(x.day ? { day: x.day } : {}), ...(x.detail?.samples ? { samples: x.detail.samples } : {}) }));
  return { state: r.status, checked_at: r.checked_at, failed_checks: [...new Set(failures.map((f) => f.check))], failures };
}
