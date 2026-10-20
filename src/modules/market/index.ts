// Public entry of the market module (CR-075, v5.23.0): market_names episodes and labels, add-only sale reports, matched sets, data-quality checks.
// It reads the datasave tables (dynadot_rows, godaddy_auctions, snapshot_manifests) through Kysely and imports no other module; ops (the datasave job) and app.ts import it.
export { registerMarket } from './api/market.js';
export { runEpisodes, type EpisodesSummary } from './episodes.js';
export { runDqMarket, latestDq, type DqRun } from './dq.js';
