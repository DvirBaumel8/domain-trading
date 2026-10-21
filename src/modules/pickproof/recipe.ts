// CR-073 (v5.28.0): the frozen texts of the pick-proof recipe. Their sha256 go into every manifest (`recipe.draw`, `recipe.pool_rule`, `recipe.labels_rule`),
// so a change to any rule changes the hash and cannot pass unseen. A change needs a new RECIPE_VERSION and DOM's release note.
import { createHash } from 'node:crypto';

export const RECIPE_VERSION = 'pickproof-v1';
/** v5.33.0 (CR-073a PP-V2): the recipe of every day frozen from now on; a day keeps the version it was frozen with (pickproof_days.recipe_version). */
export const CURRENT_RECIPE = 'pickproof-v2';
export type RecipeVersion = 'pickproof-v1' | 'pickproof-v2';
/** The common-word list of the v2 two-word rule (data/wordlists/en-scowl-35-lower.txt); checked on load. */
export const COMMON_WORDS_FILE = 'en-scowl-35-lower.txt';
export const COMMON_WORDS_SHA256 = '60ca88eb55f3738f9a0097e658826c4c1860bbe039069adc2673ce4c1841dc16';

export const DRAW_RECIPE = [
  `${RECIPE_VERSION} draw.`,
  'seed = uint32 of the first 8 hex digits of pool_sha256.',
  'arm seed = (seed XOR armConstant) >>> 0 with B1 = 0xB1B1B1B1, B2 = 0xB2B2B2B2, C1 = 0xC1C1C1C1.',
  'generator = MT19937 initialised by array [armSeed] (src/core/mt19937.ts, the CR-008 Appendix B recipe).',
  'sub-pool sorted by domain in byte order; full Fisher-Yates shuffle (i from n-1 down to 1, j = below(i+1) by rejection on the top bits);',
  'the arm is the first k names of the shuffled order, rank = position from 1; fewer than k names: all of them and short = true.',
  'arm sha256 = sha256 of the JSON array of the arm names in rank order.',
].join(' ');

export const POOL_RULE = [
  `${RECIPE_VERSION} pool.`,
  'pool for pick day D = closeout rows of data date D-1: GoDaddy datasave_pool plus Dynadot closeouts of a sealed bot upload; .com only;',
  'price_cents <= settings.pickproof_pool_max_price_cents (4000); names with an engine_sales row or a market_names sold episode removed (SALES_GRADED);',
  'sorted by domain in byte order, one row per domain (the lowest price wins, then the source name godaddy before dynadot).',
  'pool_sha256 = sha256 of the JSON array of [domain, source, price_cents] in that order.',
  'K1-passing = the stored closeouts filter_code IS NULL on a processed row. Two-word = the SLD is letters only, at most 10 letters and splits into exactly two tokens that the form check does not fail (SPELL-1).',
].join(' ');

export const LABELS_RULE = [
  `${RECIPE_VERSION} labels.`,
  'T30 for every name of every sealed arm of pick day D, once D is 30 days old: Verisign .com RDAP.',
  'registered with no redemption period and no pending delete status (any case or spacing) = taken, whatever the creation date (created_after_d and created_unknown are stored, they do not decide);',
  'registered in redemption period or pending delete = not_taken; not registered = not_taken;',
  'an error or timeout = unknown, tried again on later runs until D+40, then it stays unknown. Unknown is excluded from rates, never read as not_taken.',
  'a label belongs to the (name, D) pair, never to an arm.',
].join(' ');

const V2_POOL_RULE = [
  'pickproof-v2 pool.',
  'pool for pick day D = closeout rows of data date D-1: GoDaddy datasave_pool plus Dynadot closeouts of a sealed bot upload; .com only;',
  'price_cents <= settings.pickproof_pool_max_price_cents (4000); names with an engine_sales row or a market_names sold episode removed (SALES_GRADED);',
  'sorted by domain in byte order, one row per domain (the lowest price wins, then the source name in byte order: dynadot before godaddy).',
  'pool_sha256 = sha256 of the JSON array of [domain, source, price_cents] in that order.',
  'frozen only when every GoDaddy row of D-1 has been processed by scorePool (else 409 POOL_NOT_READY).',
  'K1-passing = the stored closeouts filter_code IS NULL on a processed row.',
  `Two-word = the SLD is letters only, at most 10 letters, the form check does not fail it (SPELL-1), and at least one split into exactly two parts has both parts at least 3 letters, each containing a vowel (a e i o u y) and each on the common-word list ${COMMON_WORDS_FILE} sha256 ${COMMON_WORDS_SHA256} (SCOWL size 35, entries written in lowercase by the source, letters only, 3 letters or more).`,
].join(' ');

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
/** v1 texts are unchanged (their hashes are in every v1 manifest); v2 changes the pool rule and re-labels draw and labels under the new version. */
export const RECIPES: Record<RecipeVersion, { draw: string; pool_rule: string; labels_rule: string }> = {
  'pickproof-v1': { draw: sha(DRAW_RECIPE), pool_rule: sha(POOL_RULE), labels_rule: sha(LABELS_RULE) },
  'pickproof-v2': {
    draw: sha(DRAW_RECIPE.replace('pickproof-v1 draw.', 'pickproof-v2 draw.')),
    pool_rule: sha(V2_POOL_RULE),
    labels_rule: sha(LABELS_RULE.replace('pickproof-v1 labels.', 'pickproof-v2 labels.')),
  },
};
export const RECIPE_SHAS = RECIPES['pickproof-v1'];
export const sha256Hex = sha;

export const ARM_CONSTANTS = { B1: 0xb1b1b1b1, B2: 0xb2b2b2b2, C1: 0xc1c1c1c1 } as const;
export type DrawnArm = keyof typeof ARM_CONSTANTS;
export const DRAWN_ARMS: DrawnArm[] = ['B1', 'B2', 'C1'];
export const ALL_ARMS = ['A', 'B1', 'B2', 'C1'] as const;
export type ArmName = (typeof ALL_ARMS)[number];
