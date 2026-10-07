import { z } from 'zod';

/**
 * The one home of calendar and time helpers. A "day" is a YYYY-MM-DD string; "IDT day" means the Asia/Jerusalem calendar day.
 * Nothing outside src/core may define its own copy (tests/unit/core-boundaries.test.ts).
 */

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const PARTS = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** An ISO 8601 instant with seconds optional and a mandatory Z or numeric offset. */
export const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** True for a real calendar date written exactly YYYY-MM-DD (rejects 2026-02-30, 2026-13-01, 2026-2-3). */
export function isRealDate(v: string): boolean {
  if (!YMD.test(v)) return false;
  const t = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === v;
}

/** True for an ISO 8601 time with an offset that also parses to an instant. */
export function isIsoWithOffset(v: string): boolean {
  return ISO_WITH_OFFSET.test(v) && !Number.isNaN(Date.parse(v));
}

/** True when the string has the YYYY-MM-DD shape (not checked for being a real date). */
export const isYmd = (v: string): boolean => YMD.test(v);

/** zod: YYYY-MM-DD shape only. */
export const ymd = z.string().regex(YMD);
/** zod: a real calendar date, YYYY-MM-DD. */
export const realYmd = ymd.refine(isRealDate, 'a calendar date');
/** zod: an ISO 8601 time with an offset. */
export const isoWithOffset = z.string().refine(isIsoWithOffset, 'must be ISO 8601 with an offset');

function parts(date: string): [number, number, number] {
  const m = PARTS.exec(date);
  if (!m) throw new Error(`Not a date: ${date}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const back = new Date(Date.UTC(y, mo - 1, d));
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) throw new Error(`Not a date: ${date}`);
  return [y, mo, d];
}
const fmt = (d: Date) => d.toISOString().slice(0, 10);

/** Days since 1970-01-01 of a YYYY-MM-DD day. */
export const dayNumber = (d: string): number => Math.floor(Date.parse(`${d}T00:00:00Z`) / DAY_MS);

/** The day n days after (or before, n < 0) a real YYYY-MM-DD day. Throws on a date that is not real. */
export function addDays(date: string, n: number): string {
  const [y, mo, d] = parts(date);
  return fmt(new Date(Date.UTC(y, mo - 1, d + n)));
}

/** Same day N months later; clamps to the last day of a shorter month. */
export function addMonthsClamped(date: string, months: number): string {
  const [y, mo, d] = parts(date);
  const target = new Date(Date.UTC(y, mo - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return fmt(new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d, lastDay))));
}

/** Same calendar day next year; 29 Feb → 28 Feb (matches Postgres date + interval '1 year'). */
export function addOneYear(date: string): string {
  const [y, mo, d] = parts(date);
  const day = mo === 2 && d === 29 ? 28 : d;
  return `${y + 1}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The UTC month (YYYY-MM) of an instant in epoch milliseconds. */
export const utcMonth = (ms: number): string => new Date(ms).toISOString().slice(0, 7);

const IDT_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' });
const IDT_WEEKDAY = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', weekday: 'short' });
/** The IDT (Asia/Jerusalem) calendar day, YYYY-MM-DD, of an instant (a Date or epoch milliseconds). */
export const idtDay = (instant: Date | number): string => IDT_DAY.format(instant);
export const idtIsSunday = (ms: number): boolean => IDT_WEEKDAY.format(new Date(ms)) === 'Sun';

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

/** `YYYY-MM-DD` at 00:00 Asia/Jerusalem as ISO 8601 with its offset (the offset on that day: DST changes happen after midnight). */
export function idtMidnightIso(day: string): string {
  const noon = toJerusalemIso(new Date(`${day}T12:00:00Z`)).slice(-6);
  for (const off of [noon, '+03:00', '+02:00']) {
    const cand = `${day}T00:00:00${off}`;
    if (toJerusalemIso(new Date(cand)) === cand) return cand;
  }
  return `${day}T00:00:00${noon}`;
}

/** The instant an IDT calendar day (YYYY-MM-DD) starts, optionally plusDays later. */
export function idtDayStart(day: string, plusDays = 0): Date {
  return new Date(idtMidnightIso(plusDays === 0 ? day : addDays(day, plusDays)));
}

/** The instant the IDT day after the one containing `instant` begins. */
export function nextIdtMidnight(instant: Date | number): Date {
  return idtDayStart(idtDay(instant), 1);
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
