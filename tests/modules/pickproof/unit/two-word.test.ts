// v5.33.0 (CR-073a PP-V2): the pick-proof two-word rule pickproof-v2 and its frozen common-word list.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COMMON_WORDS_SHA256, RECIPES } from '../../../../src/modules/pickproof/recipe.js';
import { commonWords, twoWordSplitV2 } from '../../../../src/modules/pickproof/two-word.js';

describe('PP533 two-word rule pickproof-v2', () => {
  it('PP533-1 dhsar is not two-word (dhs and ar are abbreviations, ar is 2 letters); sunbox and redcar are; qzxvkw, goal (go + al) and long names are not', () => {
    expect(twoWordSplitV2('dhsar')).toBeNull();
    expect(twoWordSplitV2('sunbox')).toEqual(['sun', 'box']);
    expect(twoWordSplitV2('redcar')).toEqual(['red', 'car']);
    expect(twoWordSplitV2('qzxvkw')).toBeNull();
    expect(twoWordSplitV2('goal')).toBeNull();
    expect(twoWordSplitV2('gonow')).toBeNull(); // go is 2 letters
    expect(twoWordSplitV2('sunboxhotel')).toBeNull(); // 11 letters
    expect(twoWordSplitV2('sun-box')).toBeNull();
    expect(twoWordSplitV2('rpmbox')).toBeNull(); // no vowel in rpm
  });

  it('PP533-2 the common-word list is the frozen file (sha256 checked on load): lowercase entries only, 3+ letters, no upper-case abbreviations or names', () => {
    const txt = readFileSync(new URL('../../../../data/wordlists/en-scowl-35-lower.txt', import.meta.url), 'utf8');
    expect(createHash('sha256').update(txt).digest('hex')).toBe(COMMON_WORDS_SHA256);
    const w = commonWords();
    expect(w.size).toBe(38_614);
    for (const x of ['dhs', 'ar', 'chicago', 'mph', 'etc']) expect(w.has(x)).toBe(false);
    for (const x of ['sun', 'box', 'red', 'car', 'goal']) expect(w.has(x)).toBe(true);
    expect([...w].every((x) => /^[a-z]{3,}$/.test(x))).toBe(true);
    expect(RECIPES['pickproof-v2'].pool_rule).not.toBe(RECIPES['pickproof-v1'].pool_rule);
  });
});
