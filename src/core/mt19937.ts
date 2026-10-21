// MT19937 (init by array) with rejection `below(n)` and Fisher-Yates `shuffle`: the seeded recipe of CR-008 Appendix B (sibling method bt1), moved here in v5.28.0
// so the pick-proof draws (CR-073) use the very same code. Pure and exact; do not change it (a change breaks the frozen bt1 outputs and the pick-proof draws).
export class MT19937 {
  private mt = new Uint32Array(624);
  private idx = 624;

  constructor(key: number[]) {
    const mt = this.mt;
    mt[0] = 19650218;
    for (let i = 1; i < 624; i++) mt[i] = (Math.imul(1812433253, mt[i - 1]! ^ (mt[i - 1]! >>> 30)) + i) >>> 0;
    let i = 1, j = 0;
    for (let k = Math.max(624, key.length); k > 0; k--) {
      mt[i] = ((mt[i]! ^ Math.imul(mt[i - 1]! ^ (mt[i - 1]! >>> 30), 1664525)) + key[j]! + j) >>> 0;
      i++; j++;
      if (i >= 624) { mt[0] = mt[623]!; i = 1; }
      if (j >= key.length) j = 0;
    }
    for (let k = 623; k > 0; k--) {
      mt[i] = ((mt[i]! ^ Math.imul(mt[i - 1]! ^ (mt[i - 1]! >>> 30), 1566083941)) - i) >>> 0;
      i++;
      if (i >= 624) { mt[0] = mt[623]!; i = 1; }
    }
    mt[0] = 0x80000000;
  }

  nextU32(): number {
    const mt = this.mt;
    if (this.idx >= 624) {
      for (let k = 0; k < 624; k++) {
        const y = (mt[k]! & 0x80000000) | (mt[(k + 1) % 624]! & 0x7fffffff);
        mt[k] = (mt[(k + 397) % 624]! ^ (y >>> 1) ^ ((y & 1) !== 0 ? 0x9908b0df : 0)) >>> 0;
      }
      this.idx = 0;
    }
    let y = mt[this.idx++]!;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** Uniform integer in [0, n) by rejection (n at least 1, at most 2**32). */
  below(n: number): number {
    const k = n.toString(2).length;
    let r = this.nextU32() >>> (32 - k);
    while (r >= n) r = this.nextU32() >>> (32 - k);
    return r;
  }
}

export function shuffle<T>(items: T[], rng: MT19937): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = rng.below(i + 1);
    const t = items[i]!;
    items[i] = items[j]!;
    items[j] = t;
  }
}

