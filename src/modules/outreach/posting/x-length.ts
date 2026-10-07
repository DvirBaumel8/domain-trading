// v2.12.0 (CR-011 part A): the length of a post as X counts it, in a simplified form of X's weighted rule.
// DOM's rule (documented in the contract): every URL (http:// or https://, up to the next white space) counts 23, a character in a
// CJK, Hangul, kana, full-width or emoji range counts 2, every other character (a newline included) counts 1. The limit is 280.
// X's own count has more cases (for example it counts some emoji sequences once); a post this counts as <= 280 may rarely be refused by
// X, and that refusal is shown as POST_FAILED. We never count lower than X would for the ranges named here.

export const X_LIMIT = 280;
export const X_URL_WEIGHT = 23;
const URL_RE = /https?:\/\/\S+/gi;

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)
    || (cp >= 0x2600 && cp <= 0x27bf) || (cp >= 0x1f000 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

export function xWeightedLength(text: string): number {
  let urls = 0;
  const rest = text.replace(URL_RE, () => { urls += 1; return ''; });
  let n = urls * X_URL_WEIGHT;
  for (const ch of rest) n += isWide(ch.codePointAt(0)!) ? 2 : 1;
  return n;
}
