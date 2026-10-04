import { toJerusalemIso } from './time.js';

export function jerusalemDate(d: Date): string {
  return toJerusalemIso(d).slice(0, 10);
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Same calendar day next year; 29 Feb → 28 Feb (matches Postgres date + interval '1 year'). */
export function addOneYear(date: string): string {
  const m = DATE.exec(date);
  if (!m) throw new Error(`Not a date: ${date}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) throw new Error(`Not a date: ${date}`);
  const day = mo === 2 && d === 29 ? 28 : d;
  return `${y + 1}-${m[2]}-${String(day).padStart(2, '0')}`;
}
