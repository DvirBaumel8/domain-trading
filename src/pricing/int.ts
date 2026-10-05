/** Money is always an integer number of US cents. */
export type Cents = number;

function assertInts(a: number, b: number): void {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) throw new Error(`integer division needs integers, got ${a}, ${b}`);
  if (b === 0) throw new Error('division by zero');
}

/** Floor division of integers. The only place in src/pricing that divides. */
export function div(a: number, b: number): number {
  assertInts(a, b);
  return Math.floor(a / b);
}

export function ceilDiv(a: number, b: number): number {
  assertInts(a, b);
  return Math.ceil(a / b);
}
