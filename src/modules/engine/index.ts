// Public entry of the engine module (CR-056). Sits above selection (it reads its RDAP helpers); selection, buying and candidates never import it.
export { registerEngine } from './api/engine.js';
export { EndingsJob } from './endings.js';
export { EngineTrainer, type TrainDeps } from './train.js';
export { Scorer } from './score.js';
export { type DbSizeGuard, guardDbSize } from './holdout.js';
export { storeSales, storeUnsold, type UploadResult } from './uploads.js';
export { loadRegimeTest, type RegimeTest } from './regime.js';
export { bulkLoad, centsOf, dateOf, domainOf, ENGINE_MAX_REJECTS, ENGINE_MAX_ROWS, isObj, rawDomain, registerBulkRoute, textOf, type Parsed, type Reject } from './bulk.js';
