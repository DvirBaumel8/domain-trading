// v5.40.0 (G-125): `npm run traffic -- <path-to-api.log>`. Reads the pino JSON log of the API, pairs `incoming request` and
// `request completed` by (pid, reqId) and prints one line per route: calls, avg/max ms, avg/max DB queries, total DB ms,
// status counts, and the query shapes seen in `db_top`. Query strings, headers and bodies are never printed (the URL is cut at `?`).
import { readFileSync } from 'node:fs';

export interface RouteStats {
  route: string;
  calls: number;
  totalMs: number;
  maxMs: number;
  dbCalls: number;
  totalQueries: number;
  maxQueries: number;
  totalDbMs: number;
  statuses: Record<string, number>;
  shapes: Map<string, number>;
}

const DOMAIN = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i;

/** `/owned/Foo.com/endings?x=1` -> `/owned/{domain}/endings`; dates, numeric ids and `rpl_xxx` style ids are folded too. */
export function normalizeUrl(url: string): string {
  const path = url.split('?')[0]!.split('#')[0]!;
  return path
    .split('/')
    .map((seg) => {
      if (/^\d{4}-\d{2}-\d{2}$/.test(seg)) return '{date}';
      if (/^\d+$/.test(seg)) return '{n}';
      if (/^[a-z]{2,6}_[A-Za-z0-9]{6,}$/.test(seg)) return '{id}';
      if (DOMAIN.test(seg)) return '{domain}';
      return seg;
    })
    .join('/');
}

interface Pending { method: string; url: string }

export function parseLog(text: string): RouteStats[] {
  const pending = new Map<string, Pending>();
  const routes = new Map<string, RouteStats>();
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    let o: Record<string, any>;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.reqId === undefined) continue;
    const key = `${o.pid}:${o.reqId}`;
    if (o.msg === 'incoming request' && o.req) {
      pending.set(key, { method: String(o.req.method), url: String(o.req.url ?? '') });
    } else if (o.msg === 'request completed') {
      const p = pending.get(key);
      pending.delete(key);
      if (!p) continue;
      const route = `${p.method} ${normalizeUrl(p.url)}`;
      let r = routes.get(route);
      if (!r) routes.set(route, (r = { route, calls: 0, totalMs: 0, maxMs: 0, dbCalls: 0, totalQueries: 0, maxQueries: 0, totalDbMs: 0, statuses: {}, shapes: new Map() }));
      const ms = Number(o.responseTime) || 0;
      r.calls += 1;
      r.totalMs += ms;
      r.maxMs = Math.max(r.maxMs, ms);
      const st = String(o.res?.statusCode ?? '?');
      r.statuses[st] = (r.statuses[st] ?? 0) + 1;
      if (typeof o.db_queries === 'number') {
        r.dbCalls += 1;
        r.totalQueries += o.db_queries;
        r.maxQueries = Math.max(r.maxQueries, o.db_queries);
        r.totalDbMs += Number(o.db_ms) || 0;
      }
      if (Array.isArray(o.db_top)) for (const t of o.db_top) if (t && typeof t.sql === 'string') r.shapes.set(t.sql, (r.shapes.get(t.sql) ?? 0) + (Number(t.n) || 0));
    }
  }
  return [...routes.values()].sort((a, b) => b.totalMs - a.totalMs);
}

export function formatReport(rows: RouteStats[]): string {
  const out: string[] = [];
  for (const r of rows) {
    const avgQ = r.dbCalls ? (r.totalQueries / r.dbCalls).toFixed(1) : '-';
    const st = Object.entries(r.statuses).map(([k, v]) => `${k}x${v}`).join(' ');
    out.push(`${r.route}\n  calls ${r.calls}  ms avg ${Math.round(r.totalMs / r.calls)} max ${Math.round(r.maxMs)}  db_queries avg ${avgQ} max ${r.dbCalls ? r.maxQueries : '-'}  db_ms total ${Math.round(r.totalDbMs)}  status ${st}`);
    const top = [...r.shapes].sort((a, b) => b[1] - a[1]).slice(0, 3);
    for (const [sql, n] of top) out.push(`    ${n}x ${sql}`);
  }
  return out.join('\n');
}

if (process.argv[1] && /traffic-report\.[tj]s$/.test(process.argv[1])) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: npm run traffic -- <path-to-api.log>');
    process.exit(2);
  }
  console.log(formatReport(parseLog(readFileSync(file, 'utf8'))));
}
