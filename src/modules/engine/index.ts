// Public entry of the engine module (CR-056). Sits above selection (it reads its RDAP helpers); selection, buying and candidates never import it.
export { registerEngine } from './api/engine.js';
export { EndingsJob } from './endings.js';
export { EngineTrainer, type TrainDeps } from './train.js';
export { Scorer } from './score.js';
export { type DbSizeGuard } from './holdout.js';
export { bulkLoad, centsOf, dateOf, domainOf, ENGINE_MAX_REJECTS, ENGINE_MAX_ROWS, isObj, rawDomain, registerBulkRoute, textOf, type Parsed, type Reject, type SealedAfter } from './bulk.js';
