import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types.js';
import { toJerusalemIso } from '../../../core/dates.js';
import { offersByStrategy } from '../../selling/index.js';
import { applied7d, perDomain } from './domains.js';
import { TrancheService } from '../../buying/index.js';
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
    tranches: (await new TrancheService(db).list()).tranches.map(({ members: _m, ...t }) => t),
    applied_7d: await applied7d(db, now),
    warnings: await buildWarnings(db, now),
  };
}
