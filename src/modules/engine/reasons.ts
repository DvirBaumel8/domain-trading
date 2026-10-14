// Plain-English reasons for a score: the logistic model's contribution of each feature (coefficient x standardised value), worded per feature.
import { logitContributions, type LogitModel } from './model/logit.js';
import { FEATURE_NAMES, type FeatureName, type FeatureValues } from './features.js';

export interface Reason { feature: FeatureName; value: number | null; effect: '+' | '-'; text: string }

const pct = (x: number): string => `${Math.round(x * 100)}%`;
const num = (x: number): string => (Number.isInteger(x) ? String(x) : x.toFixed(1));
const WORDS = ['no words', 'one word', 'two words', 'three words', 'four words'];

/** The words for one feature value as of a day. */
export function reasonText(f: FeatureName, v: number | null, asOf: string): string {
  if (v === null) return `${f.replace(/_/g, ' ')} is unknown`;
  const end = (tld: string) => (v === 1 ? `.${tld} registered before ${asOf}` : `.${tld} not registered before ${asOf}`);
  switch (f) {
    case 'len': return `${v} characters long`;
    case 'n_words': return WORDS[v] ?? `${v} words`;
    case 'has_digit': return v ? 'contains a digit' : 'no digits';
    case 'has_hyphen': return v ? 'contains a hyphen' : 'no hyphen';
    case 'vowel_share': return `${pct(v)} of its letters are vowels`;
    case 'plural_end': return v ? 'ends in a plural s' : 'does not end in a plural s';
    case 'all_known': return v ? 'every part is a known word' : 'some part is not a known word';
    case 'known_share': return `${pct(v)} of the name reads as known words`;
    case 'seg_cost_per_char': return `reading cost of ${num(Math.round(v * 10) / 10)} per letter (lower means more common words)`;
    case 'one_word': return v ? 'a single word' : 'more than one word';
    case 'zipf_min': return `its rarest word has a frequency level of ${num(Math.round(v * 10) / 10)} of 8`;
    case 'zipf_mean': return `its words average a frequency level of ${num(Math.round(v * 10) / 10)} of 8`;
    case 'zipf_max': return `its most common word has a frequency level of ${num(Math.round(v * 10) / 10)} of 8`;
    case 'trend_pit_max': return `its most common word is in ${pct(v)} of the sales of the year before ${asOf}`;
    case 'trend_pit_min': return `its rarest word is in ${pct(v)} of the sales of the year before ${asOf}`;
    case 'tok_rate_pit': return `its words sold at ${pct(v)} against unsold names before ${asOf}`;
    case 'net_pit': return end('net');
    case 'co_pit': return end('co');
    case 'org_pit': return end('org');
    case 'io_pit': return end('io');
    case 'ai_pit': return end('ai');
    case 'n_endings_pit': return `${v} of the 5 other endings registered before ${asOf}`;
    case 'acq_handreg': return v ? 'the .com was hand-registered (36 months or less before)' : 'the .com was not hand-registered recently';
    case 'acq_aftermarket_or_old': return v ? 'the .com is older than 36 months (aftermarket or old)' : 'the .com is not an older registration';
    case 'acq_created_after': return v ? `the .com was registered after ${asOf} (re-registered)` : 'the .com was not re-registered after the date';
    case 'com_age_years': return `the .com is ${num(Math.round(v * 10) / 10)} years old`;
    case 'demand': return `${Math.round(v)} searches a month for its words`;
  }
}

/** The top contributions toward (+) or away from (-) a name being sold: at most 5, at least 3 when that many are non-zero. */
export function reasonsFor(logit: LogitModel, features: readonly FeatureName[], x: ArrayLike<number>, values: FeatureValues, asOf: string): Reason[] {
  const contrib = logitContributions(logit, x);
  const ranked = features.map((f, i) => ({ f, c: contrib[i]!, order: FEATURE_NAMES.indexOf(f) })).filter((r) => Math.abs(r.c) > 1e-9)
    .sort((a, b) => Math.abs(b.c) - Math.abs(a.c) || a.order - b.order);
  const strong = ranked.filter((r) => Math.abs(r.c) >= 0.05);
  const pick = strong.length >= 3 ? strong.slice(0, 5) : ranked.slice(0, 3);
  return pick.map((r) => {
    const v = values[r.f];
    return { feature: r.f, value: v === null ? null : Math.round(v * 10_000) / 10_000, effect: r.c > 0 ? '+' as const : '-' as const, text: reasonText(r.f, v, asOf) };
  });
}
