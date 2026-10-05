import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { toJerusalemIso } from '../../time.js';
import { offersByStrategy } from '../offer-stats.js';
import { applied7d, payoutsPending, perDomain } from './domains.js';
import { reportMoney } from './money.js';
import { upcoming90d } from './upcoming.js';
import { buildWarnings } from './warnings.js';

export async function buildReport(db: Kysely<Database>, now: Date) {
  const m = await reportMoney(db);
  return {
    generated_at: toJerusalemIso(now),
    ...m,
    per_domain: await perDomain(db, now),
    upcoming_90d: await upcoming90d(db, now),
    offers_by_strategy: await offersByStrategy(db, now),
    payouts_pending: await payoutsPending(db, now),
    applied_7d: await applied7d(db, now),
    warnings: await buildWarnings(db, now),
  };
}
