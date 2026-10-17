// Public entry of the engine module (CR-056). Sits above selection (it reads its RDAP helpers); selection, buying and candidates never import it.
export { registerEngine } from './api/engine.js';
export { ENDING_TLDS, ENGINE_TLDS, ENDINGS_MAX_PAIRS_PER_RUN, ENDINGS_RECHECK_DAYS, ENDINGS_TIME_BUDGET_MS, ENDINGS_UNKNOWN_RETRY_HOURS, EndingsJob, type EndingsSummary } from './endings.js';
export { engineHealth } from './health.js';
export { EngineTrainer, type TrainDeps } from './train.js';
export { Scorer } from './score.js';
export { DEFAULT_SALES_MAX_DATE, salesMaxDate, setSalesMaxDate, type DbSizeGuard } from './holdout.js';
export { registerData } from './api/data.js';
export { pruneDataTables, type DataPruneSummary } from './data-tables.js';
