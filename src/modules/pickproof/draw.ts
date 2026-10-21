// CR-073: the arm draws, pure. MT19937 + Fisher-Yates from src/core (the CR-008 recipe), one derived seed per arm.
import { MT19937, shuffle } from '../../core/mt19937.js';
import { ARM_CONSTANTS, type DrawnArm, sha256Hex } from './recipe.js';

export const byteOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The seed of a pool: the first 8 hex digits of its sha256 as an unsigned 32-bit number. */
export const seedOfPool = (poolSha256: string): number => parseInt(poolSha256.slice(0, 8), 16) >>> 0;

/** k names drawn from `names` (any order in, sorted by byte order inside) for one arm. `short` when the sub-pool has fewer than k names. */
export function drawArm(names: readonly string[], seed: number, arm: DrawnArm, k: number): { names: string[]; short: boolean } {
  const sorted = [...names].sort(byteOrder);
  shuffle(sorted, new MT19937([(seed ^ ARM_CONSTANTS[arm]) >>> 0]));
  return { names: sorted.slice(0, k), short: sorted.length < k };
}

export const armSha = (namesInRankOrder: readonly string[]): string => sha256Hex(JSON.stringify(namesInRankOrder));
