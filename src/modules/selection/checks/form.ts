// G0 form check (CAP-01): wraps analyzeForm. The geo hints (city, trade) come from the item.
import { analyzeForm, type FormResult } from '../form.js';
import { outcome, type Check, type CheckContext } from '../types.js';

export const formCheck: Check = {
  id: 'form',
  gate: 'G0',
  ruleIds: ['SPELL-1', 'FORM-2', 'G-FORM-1', 'CAP-01'],
  lists: ['trade', 'regime', 'tech', 'generic_head', 'state', 'legal', 'city_extra', 'dictionary_extra'],
  async run(ctx) {
    const f = analyzeForm(ctx.item.domain, ctx.item.lane, ctx.lexicon, ctx.settings.form, { city: ctx.item.city, trade: ctx.item.trade, words: ctx.item.words });
    return outcome(f.status, f.reason_code, f.reason, { ...f }, {});
  },
};

/** The item's form fields: the run's own `form` result when there is one, else computed now (a plan without `form`). */
export function formFieldsOf(ctx: CheckContext): FormResult {
  const row = ctx.latest('form');
  if (row && Array.isArray(row.fields.tokens)) return row.fields as unknown as FormResult;
  return analyzeForm(ctx.item.domain, ctx.item.lane, ctx.lexicon, ctx.settings.form, { city: ctx.item.city, trade: ctx.item.trade, words: ctx.item.words });
}
