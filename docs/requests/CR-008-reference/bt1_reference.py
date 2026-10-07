"""bt1@v1 sibling method: language-neutral reference (NON-BINDING sketch of the spec in CR-008 Appendix B).
Uses no random-number library: MT19937 and the shuffle are written out so any language can copy them.
Usage: python3 bt1_reference.py bt1_pools_v1.json bt1_vectors.csv  -> checks every row, prints mismatches."""
import csv, hashlib, json, sys

M32 = 0xFFFFFFFF

class MT19937:
    def __init__(self, key):                      # key: list of 32-bit words (init_by_array)
        self.mt = [0] * 624
        self.mt[0] = 19650218
        for i in range(1, 624):
            self.mt[i] = (1812433253 * (self.mt[i-1] ^ (self.mt[i-1] >> 30)) + i) & M32
        i, j = 1, 0
        for _ in range(max(624, len(key))):
            self.mt[i] = ((self.mt[i] ^ ((self.mt[i-1] ^ (self.mt[i-1] >> 30)) * 1664525)) + key[j] + j) & M32
            i += 1; j += 1
            if i >= 624: self.mt[0] = self.mt[623]; i = 1
            if j >= len(key): j = 0
        for _ in range(623):
            self.mt[i] = ((self.mt[i] ^ ((self.mt[i-1] ^ (self.mt[i-1] >> 30)) * 1566083941)) - i) & M32
            i += 1
            if i >= 624: self.mt[0] = self.mt[623]; i = 1
        self.mt[0] = 0x80000000
        self.idx = 624

    def next_u32(self):
        if self.idx >= 624:
            for k in range(624):
                y = (self.mt[k] & 0x80000000) | (self.mt[(k+1) % 624] & 0x7FFFFFFF)
                self.mt[k] = self.mt[(k+397) % 624] ^ (y >> 1) ^ (0x9908B0DF if y & 1 else 0)
            self.idx = 0
        y = self.mt[self.idx]; self.idx += 1
        y ^= y >> 11; y ^= (y << 7) & 0x9D2C5680; y ^= (y << 15) & 0xEFC60000; y ^= y >> 18
        return y & M32

    def below(self, n):                           # uniform integer in [0, n), n <= 2**32, by rejection
        k = n.bit_length()
        r = self.next_u32() >> (32 - k)
        while r >= n:
            r = self.next_u32() >> (32 - k)
        return r

def shuffle(items, rng):                          # Fisher-Yates from the end
    for i in range(len(items) - 1, 0, -1):
        j = rng.below(i + 1)
        items[i], items[j] = items[j], items[i]

def seed_words(tokens):
    s = int(hashlib.md5(''.join(tokens).encode('utf-8')).hexdigest()[:8], 16)   # first 32 bits of MD5
    return [s]                                    # one 32-bit word (a zero seed is the key [0])

def pool_for(tok, pos, P):
    if tok in P['tech']: return P['tech']
    if tok in P['trades']: return P['trades']
    return P['first_pool'] if pos == 'first' else P['last_pool']

def siblings(tokens, P):
    rng = MT19937(seed_words(tokens))             # ONE generator, used for both halves in order
    a, z, mid = tokens[0], tokens[-1], tokens[1:-1]
    self_name = ''.join(tokens); out = []
    p = [w for w in pool_for(a, 'first', P) if w != a]; shuffle(p, rng)
    for w in p:
        s = ''.join([w] + mid + [z])
        if s not in out and s != self_name: out.append(s)
        if len(out) >= 10: break
    p = [w for w in pool_for(z, 'last', P) if w != z]; shuffle(p, rng)
    for w in p:
        s = ''.join([a] + mid + [w])
        if s not in out and s != self_name: out.append(s)
        if len(out) >= 20: break
    return out

if __name__ == '__main__':
    P = json.load(open(sys.argv[1])); bad = n = 0
    for r in csv.DictReader(open(sys.argv[2])):
        n += 1
        want = [r[f's{i:02d}'] for i in range(1, 21)]
        got = siblings(r['tokens'].split(), P)
        if got != want: bad += 1; print('MISMATCH', r['domain'], got, want)
    print(f'{n} rows, {bad} mismatches')
