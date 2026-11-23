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

export type Pair<K extends string> = { [P in `${K}_cents`]: number | null } & { [P in K]: string | null };
/** A money field as the flat pair `<key>_cents` + `<key>` (display string), e.g. spent_cents: 2107, spent: "$21.07". */
export function pair<K extends string>(key: K, cents: number | null): Pair<K> {
  return { [`${key}_cents`]: cents, [key]: cents === null ? null : formatUsd(cents) } as Pair<K>;
}

/** formatUsd that passes null through. */
export const formatUsdOrNull = (c: number | null): string | null => (c === null ? null : formatUsd(c));
