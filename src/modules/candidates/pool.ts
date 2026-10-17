import type { Kysely } from 'kysely';
import { chunks } from '../../core/chunks.js';
import type { Database } from '../../db/types.js';

/** Hosts (of `hosts`) that are in the candidate pool: a non-removed intake name or a kept drop-list row. */
export async function candidatePoolHosts(db: Kysely<Database>, hosts: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const part of chunks([...new Set(hosts)], 5_000)) {
    for (const r of await db.selectFrom('candidate_intake').select('domain').where('domain', 'in', part).where('status', '<>', 'removed').execute()) out.add(r.domain);
    for (const r of await db.selectFrom('drop_list_rows').select('domain').where('domain', 'in', part).where('kept', '=', true).execute()) out.add(r.domain);
  }
  return out;
}
