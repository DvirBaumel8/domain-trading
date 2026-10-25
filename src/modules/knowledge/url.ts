// CR-078: URL canonicalisation. The same canonical URL is the same source (dedupe by its sha256).
import { createHash } from 'node:crypto';

const TRACKING = /^(utm_|mc_|pk_)|^(fbclid|gclid|igshid|msclkid|yclid|_hsenc|_hsmi|ref_src)$/i;

/** Lowercase host, no fragment, no tracking parameters (utm_*, fbclid, gclid, ...), sorted query, no trailing slash. Returns null for anything but an http(s) URL without credentials. */
export function canonicalUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username !== '' || u.password !== '' || u.hostname === '') return null;
  u.hash = '';
  const keep = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1));
  u.search = '';
  for (const [k, v] of keep) u.searchParams.append(k, v);
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : '';
  const q = u.search;
  const out = `${u.protocol}//${u.host}${path}${q}`;
  return out.length <= 1000 ? out : null;
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
export const urlHash = (canonical: string): string => sha256(canonical);
