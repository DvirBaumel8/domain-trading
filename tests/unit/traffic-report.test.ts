import { describe, expect, it } from 'vitest';
import { formatReport, normalizeUrl, parseLog } from '../../scripts/traffic-report.js';

const line = (o: object) => JSON.stringify({ level: 30, time: 1, pid: 7, hostname: 'h', ...o });
const LOG = [
  line({ reqId: 'req-1', req: { method: 'GET', url: '/owned/Foo.com/endings?token=SECRET' }, msg: 'incoming request' }),
  line({ reqId: 'req-1', res: { statusCode: 200 }, responseTime: 1200, db_queries: 40, db_ms: 900, db_top: [{ sql: 'select * from t where a = $1', n: 30 }], msg: 'request completed' }),
  line({ reqId: 'req-2', req: { method: 'GET', url: '/owned/bar.com/endings' }, msg: 'incoming request' }),
  line({ reqId: 'req-2', res: { statusCode: 404 }, responseTime: 800, db_queries: 2, db_ms: 40, msg: 'request completed' }),
  line({ reqId: 'req-3', req: { method: 'GET', url: '/pickproof/2026-10-25/manifest' }, msg: 'incoming request' }),
  line({ reqId: 'req-3', res: { statusCode: 200 }, responseTime: 50, msg: 'request completed' }),
  line({ reqId: 'req-4', req: { method: 'GET', url: '/health' }, msg: 'incoming request' }), // never completed
  'not json',
].join('\n');

describe('traffic report', () => {
  it('TR540-1 normalises domains, dates, numeric and prefixed ids and drops the query string', () => {
    expect(normalizeUrl('/owned/Foo.com/endings?x=1')).toBe('/owned/{domain}/endings');
    expect(normalizeUrl('/pickproof/2026-10-25/manifest')).toBe('/pickproof/{date}/manifest');
    expect(normalizeUrl('/offers/123')).toBe('/offers/{n}');
    expect(normalizeUrl('/receipts/rpl_ab12cd34ef')).toBe('/receipts/{id}');
    expect(normalizeUrl('/jobs/runs')).toBe('/jobs/runs');
  });

  it('TR540-2 pairs lines by pid and reqId and sums per route, sorted by total time', () => {
    const rows = parseLog(LOG);
    expect(rows.map((r) => r.route)).toEqual(['GET /owned/{domain}/endings', 'GET /pickproof/{date}/manifest']);
    expect(rows[0]).toMatchObject({ calls: 2, totalMs: 2000, maxMs: 1200, dbCalls: 2, totalQueries: 42, maxQueries: 40, totalDbMs: 940, statuses: { '200': 1, '404': 1 } });
    expect(rows[1]).toMatchObject({ calls: 1, dbCalls: 0 });
    expect(rows[0]!.shapes.get('select * from t where a = $1')).toBe(30);
  });

  it('TR540-3 the printed report never contains a query string or a token', () => {
    const text = formatReport(parseLog(LOG));
    expect(text).toContain('GET /owned/{domain}/endings');
    expect(text).toContain('30x select * from t where a = $1');
    expect(text).not.toMatch(/SECRET|token=|\?/);
  });
});
