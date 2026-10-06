// BUY_HOLD (v1.1.0, ruling R1): a domain with a screening result is held when the settings version of the LATEST run that screened it
// has buy_hold on, is a backtest, or is no longer the active version (the engine's effectiveHold). A domain never screened is not held.
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { effectiveHold } from '../screening/engine.js';

export async function screeningHold(db: Kysely<Database>, domain: string): Promise<{ settingsVersion: string; runId: string } | null> {
  const run = await db.selectFrom('screening_runs').selectAll()
    .where('id', 'in', db.selectFrom('screening_results').select('run_id').where('domain', '=', domain))
    .orderBy('created_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
  if (!run) return null;
  return (await effectiveHold(db, run)) ? { settingsVersion: run.settings_label, runId: run.id } : null;
}
