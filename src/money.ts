const USD = /^(\d+)(?:\.(\d{1,2}))?$/;

/** "9.73" → 973. Exact string arithmetic; floats never touch money. */
export function usdStringToCents(s: string): number {
  const m = USD.exec(s);
  if (!m) throw new Error(`Not a USD amount: ${JSON.stringify(s)}`);
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw new Error(`USD amount out of range: ${JSON.stringify(s)}`);
  return cents;
}

export function formatUsd(cents: number): string {
  if (!Number.isInteger(cents)) throw new Error(`formatUsd needs integer cents, got ${cents}`);
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString('en-US');
  const rest = String(abs % 100).padStart(2, '0');
  return `${cents < 0 ? '-' : ''}$${dollars}.${rest}`;
}

/** A USD request amount (e.g. max_price 11.5) → cents, exactly. Rejects ≤0, non-finite, >2 decimals. */
export function dollarsToCents(n: number): number {
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Not a positive USD amount: ${n}`);
  return usdStringToCents(String(n));
}
