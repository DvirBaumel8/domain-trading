// CR-078: MinHash over word 5-gram shingles of an excerpt (Broder 1997), plain deterministic code. 64 hashes, each a 32-bit value, stored as 512 hex characters.
// Hash k of a shingle x (FNV-1a, 32 bit) is (a_k * x + b_k) mod P with P = 2^32 - 5 (the largest 32-bit prime); a_k, b_k come from a fixed LCG, so signatures never change between runs.
export const MINHASH_SIZE = 64;
const SHINGLE = 5;
const P = 4294967291n;

const params: { a: bigint; b: bigint }[] = (() => {
  let s = 0x9e3779b9n;
  const next = () => { s = (s * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn; return s >> 16n; };
  return Array.from({ length: MINHASH_SIZE }, () => ({ a: (next() % (P - 1n)) + 1n, b: next() % P }));
})();

/** Lowercase words (letters and digits), split on everything else. */
export const wordsOf = (text: string): string[] => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Word 5-grams; a text of 1 to 4 words is one shingle; no words, no shingles. */
export function shingles(text: string): string[] {
  const w = wordsOf(text);
  if (w.length === 0) return [];
  if (w.length < SHINGLE) return [w.join(' ')];
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE <= w.length; i++) out.add(w.slice(i, i + SHINGLE).join(' '));
  return [...out];
}

function fnv1a(s: string): bigint {
  let h = 0x811c9dc5;
  for (const byte of Buffer.from(s, 'utf8')) { h ^= byte; h = Math.imul(h, 0x01000193) >>> 0; }
  return BigInt(h >>> 0);
}

/** The signature as 512 hex characters (8 per hash), or null when the text has no words. */
export function minhashOf(text: string): string | null {
  const sh = shingles(text);
  if (sh.length === 0) return null;
  const xs = sh.map(fnv1a);
  return params.map(({ a, b }) => {
    let min = P;
    for (const x of xs) { const v = (a * x + b) % P; if (v < min) min = v; }
    return min.toString(16).padStart(8, '0');
  }).join('');
}

/** Estimated Jaccard similarity of two signatures: the share of equal positions. */
export function estimatedJaccard(a: string, b: string): number {
  let same = 0;
  for (let i = 0; i < MINHASH_SIZE; i++) if (a.slice(i * 8, i * 8 + 8) === b.slice(i * 8, i * 8 + 8)) same++;
  return same / MINHASH_SIZE;
}

/** Candidate pairs by banding (32 bands of 2 hashes: a pair with similarity 0.5 shares a band with probability above 0.9999). Returns index pairs i < j. */
export function candidatePairs(sigs: string[]): [number, number][] {
  const buckets = new Map<string, number[]>();
  sigs.forEach((s, i) => {
    for (let band = 0; band < MINHASH_SIZE / 2; band++) {
      const key = `${band}:${s.slice(band * 16, band * 16 + 16)}`;
      const list = buckets.get(key);
      if (list) list.push(i); else buckets.set(key, [i]);
    }
  });
  const seen = new Set<number>();
  const out: [number, number][] = [];
  for (const list of buckets.values()) {
    if (list.length < 2 || list.length > 200) continue; // a huge bucket is boilerplate shared by everything
    for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) {
      const i = list[x]!, j = list[y]!;
      const key = i * sigs.length + j;
      if (!seen.has(key)) { seen.add(key); out.push([i, j]); }
    }
  }
  return out;
}
