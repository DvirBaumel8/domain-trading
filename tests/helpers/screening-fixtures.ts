// Loads the recorded RDAP / IANA fixtures (tests/fixtures/screening/, recorded by `npm run record:screening`) as MSW responses.
import { readdirSync, readFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';

export interface RecordedFixture { url: string; status: number; headers: { 'content-type': string | null; 'retry-after': string | null }; body: string }

export function fixture(rel: string): RecordedFixture {
  return JSON.parse(readFileSync(new URL(`../fixtures/screening/${rel}`, import.meta.url), 'utf8')) as RecordedFixture;
}

export function respond(f: RecordedFixture): Response {
  const headers: Record<string, string> = {};
  if (f.headers['content-type']) headers['content-type'] = f.headers['content-type'];
  if (f.headers['retry-after']) headers['retry-after'] = f.headers['retry-after'];
  return new HttpResponse(f.status === 404 && f.body === '' ? null : f.body, { status: f.status, headers });
}

export const RANDOM_COM = 'zjwwqneitamicjovehsptpreqqzxfm.com';

// ---- Wayback (CAP-07 history) ----
export interface WaybackSite { cdx: string[][]; captures: Record<string, { status: number; headers: Record<string, string | null>; body: string }> }
const WB = new URL('../fixtures/screening/wayback/', import.meta.url);

/** A recorded site (tests/fixtures/screening/wayback/<name>_com/, from `npm run record:screening -- wayback <domain>`). */
export function recordedSite(domain: string): WaybackSite {
  const dir = new URL(`${domain.replace(/\./g, '_')}/`, WB);
  const cdx = JSON.parse((JSON.parse(readFileSync(new URL('cdx.json', dir), 'utf8')) as RecordedFixture).body.trim() || '[]') as string[][];
  const captures: WaybackSite['captures'] = {};
  for (const f of readdirSync(dir)) {
    const m = /^(\d{14})\.json$/.exec(f);
    if (!m) continue;
    const r = JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as RecordedFixture & { headers: Record<string, string | null> };
    captures[m[1]!] = { status: r.status, headers: r.headers, body: r.body };
  }
  return { cdx, captures };
}
/** A hand-made site (`synthetic-*.json`, never a real archive record). */
export function syntheticSite(name: string): WaybackSite & { domain: string } {
  return JSON.parse(readFileSync(new URL(`${name}.json`, WB), 'utf8')) as WaybackSite & { domain: string };
}

export interface WaybackOpts {
  /** Replaces the CDX answer (default: the site's rows as CDX JSON; no rows: the server's empty body). */
  cdx?: (domain: string, url: URL) => Response;
  /** Replaces a capture answer. */
  capture?: (ts: string, domain: string) => Response | undefined;
}
export interface WaybackLog { cdx: URL[]; captures: string[] }

/** MSW handlers for web.archive.org serving the given sites by domain. Unknown domains answer an empty CDX body. */
export function waybackHandlers(sites: Record<string, WaybackSite>, log: WaybackLog = { cdx: [], captures: [] }, o: WaybackOpts = {}) {
  return [
    http.get('https://web.archive.org/cdx/search/cdx', ({ request }) => {
      const url = new URL(request.url);
      log.cdx.push(url);
      const domain = url.searchParams.get('url') ?? '';
      if (o.cdx) return o.cdx(domain, url);
      const rows = sites[domain]?.cdx ?? [];
      return new HttpResponse(rows.length <= 1 ? '' : JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
    http.get('https://web.archive.org/web/*', ({ request }) => {
      const m = /^\/web\/(\d{14})id_\/(.+)$/.exec(new URL(request.url).pathname);
      if (!m) return new HttpResponse(null, { status: 404 });
      log.captures.push(m[1]!);
      const host = new URL(m[2]!.replace(/^(https?:)\/+/, '$1//')).hostname.replace(/^www\./, '');
      const over = o.capture?.(m[1]!, host);
      if (over) return over;
      const c = sites[host]?.captures[m[1]!];
      if (!c) return new HttpResponse(null, { status: 404 });
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(c.headers)) if (v) headers[k] = v;
      return new HttpResponse(c.status >= 300 && c.status < 400 ? null : c.body, { status: c.status, headers });
    }),
  ];
}
