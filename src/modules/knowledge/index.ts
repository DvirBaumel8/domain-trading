// Public entry of the knowledge module (CR-078 phase 1, v5.43.0): the evidence base, plain-code verdicts, and the repo-file loader behind the daily step `kbLoad`.
// It imports no other module (only shared core, http and db); ops (the daily job) and app.ts import it.
export { registerKnowledge } from './api/kb.js';
export { KbLoadJob, type KbLoadSummary } from './load.js';
export { type DbSizeGuard } from './size.js';
