import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types.js';
import { toJerusalemIso } from '../../../core/dates.js';
import { pendingDomains } from '../../listing/index.js';
import { loadOffers, offersByStrategy } from '../../selling/index.js';
import { applied7d, loadReportDomains, perDomain } from './domains.js';
import { TrancheService } from '../../buying/index.js';
import { reportLines } from './lines.js';
import { reportMoney } from './money.js';
import { upcoming90d } from './upcoming.js';
import { buildWarnings } from './warnings.js';

/**
 * v5.14.0: the domains, the offers and the Afternic pending set are read once and shared by the parts, which then run together
 * (Promise.all; the key order of the answer is unchanged). One /report uses up to 8 connections at once, so the pool is 20 (db/client.ts).
 */
export async function buildReport(db: Kysely<Database>, now: Date) {
  const [domains, offers, pendingNames] = await Promise.all([loadReportDomains(db), loadOffers(db), pendingDomains(db, 'afternic')]);
  const pendingAfternic = new Set(pendingNames);
  const [m, lines, per_domain, upcoming_90d, offers_by_strategy, tranches, applied_7d, warnings] = await Promise.all([
    reportMoney(db),
    reportLines(db),
    perDomain(db, now, { domains, offers }),
    upcoming90d(db, now, domains),
    offersByStrategy(db, now, offers),
    new TrancheService(db).list(),
    applied7d(db, now, pendingAfternic),
    buildWarnings(db, now, { domains, pendingAfternic }),
  ]);
  return {
    generated_at: toJerusalemIso(now),
    ...m,
    lines,
    per_domain,
    upcoming_90d,
    offers_by_strategy,
    tranches: tranches.tranches.map(({ members: _m, ...t }) => t),
    applied_7d,
    warnings,
  };
}
