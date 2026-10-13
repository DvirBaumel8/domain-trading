// G8 keyword demand (CR-044 item 3, v4.2.0): the average monthly searches of the name's keyword from the latest Keyword Planner upload. A feature check:
// it informs and never rejects (PASS with the numbers, or UNKNOWN when no upload has the keyword). No network call.
import { demandForKeywords, keywordCandidates } from '../demand.js';
import { outcome, type Check, type CheckContext } from '../types.js';
import { formFieldsOf } from './form.js';

export const demandCheck: Check = {
  id: 'demand',
  gate: 'G8',
  ruleIds: ['CR-044'],
  lists: [],
  async run(ctx: CheckContext) {
    if (ctx.run.mode === 'full' && ctx.item.as_of !== undefined) return outcome('UNKNOWN', 'AS_OF_NOT_SUPPORTED', 'Keyword uploads are read as they stand now, not as of a past date', { demand: { status: 'unmeasured' } });
    const keywords = keywordCandidates(formFieldsOf(ctx).tokens, ctx.item.words);
    const d = await demandForKeywords(ctx.db, keywords);
    if ('status' in d) return outcome('UNKNOWN', 'KEYWORD_NOT_IN_UPLOAD', 'No keyword upload has a measured number for this name', { demand: d, keywords_tried: keywords });
    return outcome('PASS', null, null, { demand: d, keywords_tried: keywords }, { dataAsOf: new Date(d.as_of) });
  },
};
