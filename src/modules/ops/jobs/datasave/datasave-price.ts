// Shared by the datasave job and the archive (CR-081).
/** "$1,250" -> 125000 (integer cents); null when it is not a dollar amount. */
export function priceToCents(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) : null;
  if (typeof v !== 'string') return null;
  const m = /^\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*$/.exec(v);
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

