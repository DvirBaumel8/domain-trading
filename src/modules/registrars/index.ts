// Public entry of the registrars module.
export { registerCheck } from './api/check.js';
export { CheckService } from './check.js';
export { redactInvoice } from './porkbun.js';
export { createAdapters, REGISTRAR_ENV, adapterStatus } from './registry.js';
export { pickWinner } from './selection.js';
export { type RegistrarAdapter, nsPendingWarning, RegistrarError } from './types.js';
export { type CheckResult } from './check.js';
export { type EvaluatedQuote, evaluateQuote } from './selection.js';
export { type AccountState, type Capabilities, type DomainInfo, type RegisterSuccess } from './types.js';
