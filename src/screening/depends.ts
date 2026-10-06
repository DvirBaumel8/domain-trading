// Check dependencies inside one run. A leaf module (type imports only) so the settings validation can use it without loading the checks.
import type { CheckId } from './types.js';

/**
 * Which checks read which others' rows in the same run (taken from the `ctx.latest(...)` reads in checks/*.ts; keep in step with them;
 * `price` also reads every FLAG-capable check for its risk flag: tm_us, web_risk, tm_eu, same_name).
 * Every automatic row records the exact dependency row ids it was computed from (`inputs`, one entry per dependency here, in the plan or not).
 * When the row in force for any of them differs, the row is stale and is recomputed (appended; the old row stays). A manual row is never stale.
 * A check listed here is never served from the cache. Each dependency must precede its dependent in every gate list (checked when settings are drafted).
 */
export const DEPENDS_ON: Partial<Record<CheckId, CheckId[]>> = {
  history: ['availability', 'surbl', 'web_risk'],
  ext_dates: ['availability', 'history'],
  tier: ['form', 'census', 'history', 'ext_dates'],
  price: ['form', 'history', 'tier', 'namebio', 'quote', 'tm_us', 'web_risk', 'tm_eu', 'same_name', 'concentration'],
  tm_us: ['form', 'history'],
};
