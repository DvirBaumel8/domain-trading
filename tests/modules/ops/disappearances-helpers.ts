import { withDbScope } from '../../../src/core/db-stats.js';
import type { RdapLookupFn } from '../../../src/core/rdap.js';
import { tagDisappearances } from '../../../src/modules/ops/closeouts/disappearances.js';
import { testDb as db } from '../../helpers/db.js';

/** Runs the tagging step alone (collect, then tag) with these RDAP answers and returns its summary with the DB query count. */
export const collectAndTag = (rdap: RdapLookupFn, nowMs: number) => withDbScope('tags', () => tagDisappearances({ db, now: () => nowMs, rdap, sleep: async () => {} }));
