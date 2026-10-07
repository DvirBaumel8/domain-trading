// New or repeat (CR-011 part B, T11-19): Jaccard overlap of the words that matter.

/** An item is a repeat of an earlier item of the same category when the word overlap is at least this. */
export const REPEAT_JACCARD = 0.6;

const STOP = new Set(('the and for are but not you all any can had her was one our out has have this that with from they been were will would there their what about which when your said each than them these those into over also just only very more most some such then too use used using may might should could its it\'s is be to of in on at as by an or if so do no we he she his him how who why because while where does did done being both between through during before after again further once here other another same own off our ours').split(/\s+/));

export function noveltyTokens(text: string): Set<string> {
  const words = text.toLowerCase().replace(/(?<=\d),(?=\d)/g, '').replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length >= 3 && !STOP.has(w));
  return new Set(words);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
