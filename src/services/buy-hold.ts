// BUY_HOLD (v1.1.0, ruling R1): a domain with a screening result is held when the settings version of the LATEST run that screened it
// has buy_hold on, is a backtest, or is no longer the active version (the engine's effectiveHold). A run that lists the domain in its input but
// has not written a result for it yet counts as having screened it. A domain never screened is not held.
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { effectiveHold } from '../screening/engine.js';

export async function latestScreeningRun(db: Kysely<Database>, domain: string) {
  return await db.selectFrom('screening_runs').selectAll()
    .where((eb) => eb.or([
      eb('id', 'in', db.selectFrom('screening_results').select('run_id').where('domain', '=', domain)),
      // a run that lists the name but has not written a result for it yet counts too (a held version holds the name from the start)
      sql<boolean>`input @> ${JSON.stringify({ names: [{ domain }] })}::jsonb`,
    ]))
    .orderBy('created_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
}

export async function screeningHold(db: Kysely<Database>, domain: string): Promise<{ settingsVersion: string; runId: string } | null> {
  const run = await latestScreeningRun(db, domain);
  if (!run) return null;
  return (await effectiveHold(db, run)) ? { settingsVersion: run.settings_label, runId: run.id } : null;
}
