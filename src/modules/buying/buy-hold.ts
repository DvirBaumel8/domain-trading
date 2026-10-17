// BUY_HOLD (v1.1.0, ruling R1): a domain with a screening result is held when the settings version of the LATEST run that screened it
// has buy_hold on, is a backtest, or is no longer the active version (the engine's effectiveHold). A run that lists the domain in its input but
// has not written a result for it yet counts as having screened it. A domain never screened is not held.
import { sql, type Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { effectiveHold } from '../selection/index.js';

type ScreeningRun = NonNullable<Awaited<ReturnType<typeof latestScreeningRunRow>>>;

async function latestScreeningRunRow(db: Kysely<Database>, domain: string) {
  // Two indexed branches (screening_results_domain_check, screening_runs_input_names GIN, v5.14.0): the runs that wrote a result for the name,
  // and the runs that list it in their input but have not written one yet (a held version holds the name from the start).
  return await db.selectFrom('screening_runs').selectAll()
    .where('id', 'in', sql<string>`(
      select run_id from screening_results where domain = ${domain}
      union select id from screening_runs where input @> ${JSON.stringify({ names: [{ domain }] })}::jsonb)`)
    .orderBy('created_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
}

export async function latestScreeningRun(db: Kysely<Database>, domain: string): Promise<ScreeningRun | undefined> {
  return latestScreeningRunRow(db, domain);
}

/** `run` = the name's latest run when the caller already read it (one read per /buy); undefined = read it here. */
export async function screeningHold(db: Kysely<Database>, domain: string, run?: ScreeningRun | null): Promise<{ settingsVersion: string; runId: string } | null> {
  const r = run === undefined ? await latestScreeningRun(db, domain) : run;
  if (!r) return null;
  return (await effectiveHold(db, r)) ? { settingsVersion: r.settings_label, runId: r.id } : null;
}
