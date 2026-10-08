// CR-009 N-8: the word split behind sibling method `bt1@v2`. Pure: a frozen cost table (data/bt1/bt1_v2_split.json, sha256 checked at load)
// and a dynamic programme over the SLD: pieces of 2..24 letters, cost = class cost + piece_cost per piece, the cheapest reading wins,
// ties keep the smaller piece (strict <). No reading, or an SLD of anything but lower-case letters, gives no split.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SPLIT_V2_FILE = 'bt1/bt1_v2_split.json';
export const SPLIT_V2_SHA256 = '69e659c242ef3a6ea7f55c76dba5680db2199c81ef281d0e80adaf1547f80d73';
// v2.13.0 (CR-012): bt1@v3 is the same recipe on the split of data/bt1/bt1_v3_split.json (same shape; v2 plus a short general token list).
export const SPLIT_V3_FILE = 'bt1/bt1_v3_split.json';
export const SPLIT_V3_SHA256 = 'a76396a60d25d38c699ae94194b28d6ea354551419c4baf9c9b70d1d33f70d5e';
/** The frozen split files by sibling method (methods that use a split file). */
export const SPLIT_FILES: Record<string, { file: string; sha256: string }> = {
  'bt1@v2': { file: SPLIT_V2_FILE, sha256: SPLIT_V2_SHA256 },
  'bt1@v3': { file: SPLIT_V3_FILE, sha256: SPLIT_V3_SHA256 },
};

export interface SplitV2Table { pieceCost: number; cost: Map<string, number> }

const cached = new Map<string, SplitV2Table>();

/** Reads and verifies the frozen split file of a method (default bt1@v2; throws when its sha256 differs). */
export function loadSplitV2(method = 'bt1@v2'): SplitV2Table {
  const hit = cached.get(method);
  if (hit) return hit;
  const f = SPLIT_FILES[method];
  if (!f) throw new Error(`Sibling method ${method} has no split file`);
  const bytes = readFileSync(fileURLToPath(new URL(`../../../data/${f.file}`, import.meta.url)));
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== f.sha256) throw new Error(`Split data for ${method} does not match its frozen sha256 (got ${sha})`);
  const j = JSON.parse(bytes.toString('utf8')) as { split: { piece_cost: number; class_costs: Record<string, number> }; classes: Record<string, string[]> };
  const cost = new Map<string, number>();
  for (const [cls, tokens] of Object.entries(j.classes)) {
    const c = j.split.class_costs[cls];
    if (c === undefined) throw new Error(`${method} split: class ${cls} has no cost`);
    for (const t of tokens) cost.set(t, c);
  }
  const table = { pieceCost: j.split.piece_cost, cost };
  cached.set(method, table);
  return table;
}

/** The cheapest split of an SLD (domain without `.com`) into known tokens; `[]` when there is none. */
export function splitV2(sld: string, table: SplitV2Table = loadSplitV2('bt1@v2')): string[] {
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
export const splitV2OfDomain = (domain: string, method = 'bt1@v2'): string[] => (domain.endsWith('.com') ? splitV2(domain.slice(0, -4), loadSplitV2(method)) : []);

/**
 * v2.16.0 (CR-014 N-3): the part of an SLD the split could not read: what follows the longest prefix that reads as known tokens
 * (the whole SLD when no prefix reads, null when the whole SLD reads or is empty).
 */
export function splitUnread(sld: string, table: SplitV2Table = loadSplitV2('bt1@v2')): string | null {
  if (sld.length === 0) return null;
  if (!/^[a-z]+$/.test(sld)) return sld;
  const n = sld.length;
  const reach = new Array<boolean>(n + 1).fill(false);
  reach[0] = true;
  let longest = 0;
  for (let i = 0; i < n; i++) {
    if (!reach[i]) continue;
    for (let j = i + 2; j <= Math.min(n, i + 24); j++) {
      if (table.cost.has(sld.slice(i, j))) { reach[j] = true; if (j > longest) longest = j; }
    }
  }
  return longest >= n ? null : sld.slice(longest);
}
