// Public entry of the data module (CR-063): the research data tables (domain_rdap, live_checks, tm_kills, bigco_names, sales_comps). Sits above engine
// (the bulk-upload skeleton, the row validators, the holdout date) and candidates (the candidate pool); nothing imports it except ops and app.
export { registerData } from './api/data.js';
export { pruneDataTables } from './tables.js';
