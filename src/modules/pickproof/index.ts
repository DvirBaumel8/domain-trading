// Public entry of the pick-proof module (CR-073, v5.28.0): the frozen daily pool, the arms, the seal, the T30 labels and the report.
// It reads the datasave tables through Kysely and imports only selection's name checker; ops (the datasave step pickproofLabels) and app.ts import it.
export { registerPickproof } from './api/pickproof.js';
export { pickproofLabels, type LabelsSummary } from './labels.js';
export { autoSeal } from './store.js';
