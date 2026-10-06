// The check registry. The engine looks a check up here by id; an id with no implementation answers NOT_RUN / NOT_IMPLEMENTED.
// Tasks 5-7 add their checks by importing the file and listing it below (availability, typo, surbl, history, census, ext_dates,
// tier, namebio, quote, price). Nothing else in the engine changes. `pack` and `leads` stay unimplemented in v1.1.0 (P1b / post-buy).
import type { Check, CheckId } from '../types.js';
import { availabilityCheck } from './availability.js';
import { brandListsCheck } from './brand-lists.js';
import { censusCheck } from './census.js';
import { concentrationCheck } from './concentration.js';
import { extDatesCheck } from './ext-dates.js';
import { formCheck } from './form.js';
import { historyCheck } from './history.js';
import { tmUsCheck, webRiskCheck } from './manual.js';
import { namebioCheck } from './namebio.js';
import { priceCheck } from './price.js';
import { quoteCheck } from './quote.js';
import { surblCheck } from './surbl.js';
import { tierCheck } from './tier.js';
import { typoCheck } from './typo.js';

export const CHECKS: Partial<Record<CheckId, Check>> = {
  form: formCheck,
  brand_lists: brandListsCheck,
  concentration: concentrationCheck,
  web_risk: webRiskCheck,
  tm_us: tmUsCheck,
  availability: availabilityCheck,
  surbl: surblCheck,
  history: historyCheck,
  census: censusCheck,
  ext_dates: extDatesCheck,
  typo: typoCheck,
  tier: tierCheck,
  namebio: namebioCheck,
  quote: quoteCheck,
  price: priceCheck,
};

/** Gate label per check (also the label of an unimplemented check's NOT_RUN row). */
export const GATE_OF: Record<CheckId, string> = {
  form: 'G0', brand_lists: 'G1', typo: 'G1', availability: 'G2', concentration: 'G3', surbl: 'G4', web_risk: 'G5', history: 'G6',
  tm_us: 'G7', census: 'G8', ext_dates: 'G8', tier: 'G8', namebio: 'G8', quote: 'G9', price: 'G9', pack: 'G10', leads: 'G12',
};
