// v5.58.0 (CR-079): the summary of the daily step `ownershipCheck`: the ownership warnings of the same list GET /report builds.
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types.js';
import { OWNERSHIP_CODES } from './ownership.js';
import { loadReportDomains } from './domains.js';
import { buildWarnings } from './warnings.js';

const LIVE = ['owned', 'listed', 'delisted'];

export interface OwnershipSummary { status: 'ok' | 'alerts'; checked_n: number; alerts_n: number; by_code: Record<string, number>; info_n: number }

/** Read-only. `alerts_n` counts the warn and error rows of the ownership codes; info rows (OBSERVED_UNCONFIRMED) are counted apart in `info_n`. */
export async function ownershipSummary(db: Kysely<Database>, now: Date): Promise<OwnershipSummary> {
  const domains = await loadReportDomains(db);
  const warnings = (await buildWarnings(db, now, { domains })).filter((w) => (OWNERSHIP_CODES as readonly string[]).includes(w.code));
  const by_code: Record<string, number> = {};
  for (const w of warnings) by_code[w.code] = (by_code[w.code] ?? 0) + 1;
  const alerts = warnings.filter((w) => w.level !== 'info');
  return { status: alerts.length === 0 ? 'ok' : 'alerts', checked_n: domains.filter((d) => LIVE.includes(d.status)).length, alerts_n: alerts.length, by_code, info_n: warnings.length - alerts.length };
}
