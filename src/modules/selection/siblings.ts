// CR-008 Appendix B: sibling method `bt1@v1`. Pure and exact: MD5 seed, MT19937 (init by array), rejection `below(n)`, Fisher-Yates,
// four frozen word pools in their order (duplicates kept). Changing any pool word needs a new method version and a new approval.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MT19937, shuffle } from '../../core/mt19937.js';
import { SPLIT_V2_SHA256, SPLIT_V3_SHA256 } from './split-v2.js';

export interface SiblingPools { first_pool: string[]; last_pool: string[]; tech: string[]; trades: string[] }

/** Known method versions: the frozen pools file (under data/) and its sha256, checked whenever the pools are loaded. */
const BT1_POOLS = { file: 'bt1/bt1_pools_v1.json', sha256: 'a984b85e06ed79cf972590518214ccd35c6ea12887a8e08d8a5e807e1a7df48b' };
/** `bt1@v2` (CR-009 N-8) is the same recipe and pools applied to the split-v2 tokens (data/bt1/bt1_v2_split.json); `split` names that file's sha256. */
export const KNOWN_METHODS: Record<string, { file: string; sha256: string; split: string | null }> = {
  'bt1@v1': { ...BT1_POOLS, split: null },
  'bt1@v2': { ...BT1_POOLS, split: SPLIT_V2_SHA256 },
  /** `bt1@v3` (CR-012): the same recipe on data/bt1/bt1_v3_split.json. */
  'bt1@v3': { ...BT1_POOLS, split: SPLIT_V3_SHA256 },
};
/** The word split a method is applied to for a name: DOM's own `form` tokens (v1) or the frozen split-v2 tokens. */
export const usesSplitV2 = (method: string): boolean => KNOWN_METHODS[method]?.split != null;
export const isKnownMethod = (m: string): boolean => Object.prototype.hasOwnProperty.call(KNOWN_METHODS, m);

const cache = new Map<string, SiblingPools>();

/** Reads and verifies the frozen pools of a known method (throws when the file's sha256 differs). */
export function loadPools(method: string): SiblingPools {
  const hit = cache.get(method);
  if (hit) return hit;
  const m = KNOWN_METHODS[method];
  if (!m) throw new Error(`Unknown sibling method ${method}`);
  const bytes = readFileSync(fileURLToPath(new URL(`../../../data/${m.file}`, import.meta.url)));
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== m.sha256) throw new Error(`Sibling pools for ${method} do not match their frozen sha256 (got ${sha})`);
  const j = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  const pools: SiblingPools = { first_pool: j.first_pool as string[], last_pool: j.last_pool as string[], tech: j.tech as string[], trades: j.trades as string[] };
  cache.set(method, pools);
  return pools;
}

/** The up to 20 ordered `.com` labels (without `.com`) of `bt1@v1` for a word split. A split of fewer than 2 words has none. */
export function siblingsBt1(tokens: string[], pools: SiblingPools = loadPools('bt1@v1')): string[] {
  if (tokens.length < 2) return [];
  const s = parseInt(createHash('md5').update(tokens.join(''), 'utf8').digest('hex').slice(0, 8), 16);
  const rng = new MT19937([s]);
  const a = tokens[0]!, z = tokens[tokens.length - 1]!, mid = tokens.slice(1, -1).join('');
  const self = tokens.join('');
  const poolFor = (tok: string, first: boolean): string[] => (pools.tech.includes(tok) ? pools.tech : pools.trades.includes(tok) ? pools.trades : first ? pools.first_pool : pools.last_pool);
  const out: string[] = [];
  const add = (cand: string, cap: number): boolean => {
    if (!out.includes(cand) && cand !== self) out.push(cand);
    return out.length >= cap;
  };
  const p1 = poolFor(a, true).filter((w) => w !== a);
  shuffle(p1, rng);
  for (const w of p1) if (add(w + mid + z, 10)) break;
  const p2 = poolFor(z, false).filter((w) => w !== z);
  shuffle(p2, rng);
  for (const w of p2) if (add(a + mid + w, 20)) break;
  return out;
}
