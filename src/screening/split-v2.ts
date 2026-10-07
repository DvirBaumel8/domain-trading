// CR-009 N-8: the word split behind sibling method `bt1@v2`. Pure: a frozen cost table (data/bt1/bt1_v2_split.json, sha256 checked at load)
// and a dynamic programme over the SLD: pieces of 2..24 letters, cost = class cost + piece_cost per piece, the cheapest reading wins,
// ties keep the smaller piece (strict <). No reading, or an SLD of anything but lower-case letters, gives no split.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SPLIT_V2_FILE = 'bt1/bt1_v2_split.json';
export const SPLIT_V2_SHA256 = '69e659c242ef3a6ea7f55c76dba5680db2199c81ef281d0e80adaf1547f80d73';

export interface SplitV2Table { pieceCost: number; cost: Map<string, number> }

let cached: SplitV2Table | undefined;

/** Reads and verifies the frozen split file (throws when its sha256 differs). */
export function loadSplitV2(): SplitV2Table {
  if (cached) return cached;
  const bytes = readFileSync(fileURLToPath(new URL(`../../data/${SPLIT_V2_FILE}`, import.meta.url)));
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== SPLIT_V2_SHA256) throw new Error(`Split data for bt1@v2 does not match its frozen sha256 (got ${sha})`);
  const j = JSON.parse(bytes.toString('utf8')) as { split: { piece_cost: number; class_costs: Record<string, number> }; classes: Record<string, string[]> };
  const cost = new Map<string, number>();
  for (const [cls, tokens] of Object.entries(j.classes)) {
    const c = j.split.class_costs[cls];
    if (c === undefined) throw new Error(`bt1@v2 split: class ${cls} has no cost`);
    for (const t of tokens) cost.set(t, c);
  }
  cached = { pieceCost: j.split.piece_cost, cost };
  return cached;
}

/** The cheapest split of an SLD (domain without `.com`) into known tokens; `[]` when there is none. */
export function splitV2(sld: string, table: SplitV2Table = loadSplitV2()): string[] {
  if (!/^[a-z]+$/.test(sld)) return [];
  const n = sld.length;
  const INF = 1_000_000_000;
  const best = new Array<number>(n + 1).fill(INF);
  const next = new Array<number>(n + 1).fill(-1);
  best[n] = 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = i + 2; j <= Math.min(n, i + 24); j++) {
      const c = table.cost.get(sld.slice(i, j));
      if (c === undefined || best[j]! >= INF) continue;
      const total = c + table.pieceCost + best[j]!;
      if (total < best[i]!) { best[i] = total; next[i] = j; }
    }
  }
  if (best[0]! >= INF || n === 0) return [];
  const out: string[] = [];
  for (let i = 0; i < n; i = next[i]!) out.push(sld.slice(i, next[i]!));
  return out;
}

/** The split of a `.com` domain name (lower-case); anything that is not `<letters>.com` has none. */
export const splitV2OfDomain = (domain: string): string[] => (domain.endsWith('.com') ? splitV2(domain.slice(0, -4)) : []);
