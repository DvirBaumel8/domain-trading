/** True for a real calendar date written exactly YYYY-MM-DD (rejects 2026-02-30, 2026-13-01, 2026-2-3). */
export function isRealDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === v;
}

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
