/** Splits a list into pieces of at most `n` (for bulk inserts and `in (...)` lookups). */
export const chunks = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));
