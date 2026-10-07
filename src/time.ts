const FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Jerusalem',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',
});

/** ISO 8601 in Asia/Jerusalem with its offset, e.g. 2026-10-04T09:12:03+03:00 (no ms). */
export function toJerusalemIso(d: Date): string {
  const p = Object.fromEntries(FMT.formatToParts(d).map((x) => [x.type, x.value])) as Record<string, string>;
  const [y, mo, da, h, mi, s] = [p.year, p.month, p.day, p.hour, p.minute, p.second].map(Number) as number[];
  const localAsUtc = Date.UTC(y!, mo! - 1, da!, h!, mi!, s!);
  const offsetMin = Math.round((localAsUtc - Math.floor(d.getTime() / 1000) * 1000) / 60000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const oh = String(Math.floor(Math.abs(offsetMin) / 60)).padStart(2, '0');
  const om = String(Math.abs(offsetMin) % 60).padStart(2, '0');
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${sign}${oh}:${om}`;
}

const UTC_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** Keys whose value is a check's own recorded data (RDAP dates, as_of cut-offs, quote times) or the caller's own echoed judgment (a pack's `judgment`): passed through exactly as recorded. */
export const OPAQUE_KEYS: ReadonlySet<string> = new Set(['fields', 'judgment']);

/**
 * Rewrites every UTC `Z` timestamp (a Date, or a string that is exactly an ISO instant ending in Z) inside a JSON-like value to
 * Asia/Jerusalem with its offset (BUG-2, CR-005). The same instant, whole seconds. Strings with an offset and every other value pass through.
 * `keep` lists top-level keys left untouched (the documented UTC fields). A value under a key in the opaque-key set (a screening check's
 * `fields`, a pack's `judgment`) is not descended into. Returns a new value; the input is not changed.
 */
export function jerusalemDeep<T>(value: T, keep?: ReadonlySet<string>): T {
  const walk = (v: unknown, top: boolean): unknown => {
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? v : toJerusalemIso(v);
    if (typeof v === 'string') return UTC_Z.test(v) && !Number.isNaN(Date.parse(v)) ? toJerusalemIso(new Date(v)) : v;
    if (Array.isArray(v)) return v.map((x) => walk(x, false));
    if (v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, (top && keep?.has(k)) || OPAQUE_KEYS.has(k) ? x : walk(x, false)]));
    }
    return v;
  };
  return walk(value, true) as T;
}
