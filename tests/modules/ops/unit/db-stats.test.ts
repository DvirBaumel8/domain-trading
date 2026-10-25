import { describe, expect, it } from 'vitest';
import { currentDbScope, dbStats, newDbScope, recordQuery, runInDbScope, stepDb, withDbScope } from '../../../../src/core/db-stats.js';

// v5.40.0 (G-125): the query counter. DB-free: the Kysely log hook calls recordQuery(sql, ms, failed).
describe('db-stats counter', () => {
  it('DQ540-1 two parallel scopes do not mix their counts', async () => {
    const run = (label: string, n: number, sqlText: string) => withDbScope(label, async () => {
      for (let i = 0; i < n; i++) {
        await new Promise((r) => setTimeout(r, Math.random() * 3));
        recordQuery(sqlText, 2, false);
      }
    });
    const [a, b] = await Promise.all([run('a', 7, 'select 1'), run('b', 3, 'select 2')]);
    expect(a.stats).toMatchObject({ queries: 7, ms: 14, top: [{ sql: 'select 1', n: 7 }] });
    expect(b.stats).toMatchObject({ queries: 3, ms: 6, top: [{ sql: 'select 2', n: 3 }] });
  });

  it('DQ540-2 a query outside any scope is ignored', () => {
    expect(currentDbScope()).toBeUndefined();
    expect(() => recordQuery('select 1', 1, false)).not.toThrow();
    const scope = newDbScope('x');
    runInDbScope(scope, () => recordQuery('select 1', 1, false));
    recordQuery('select 1', 1, false);
    expect(scope.queries).toBe(1);
  });

  it('DQ540-3 shapes keep the SQL text only (whitespace collapsed, 200 characters), errors are counted, top is sorted', () => {
    const scope = newDbScope('x');
    runInDbScope(scope, () => {
      recordQuery('select  *\n from   domains where name = $1', 1, false);
      recordQuery('select * from domains where name = $1', 1, true);
      recordQuery('x'.repeat(500), 1, false);
      recordQuery('select 9', 1, false);
    });
    const s = dbStats(scope);
    expect(s.queries).toBe(4);
    expect(s.errors).toBe(1);
    expect(s.top[0]).toEqual({ sql: 'select * from domains where name = $1', n: 2 });
    expect([...scope.shapes.keys()].every((k) => k.length <= 200)).toBe(true);
    // the record has no field that could hold parameters
    expect(JSON.stringify(s)).not.toMatch(/param|values|bindings/i);
  });

  it('DQ540-4 stepDb carries top shapes only from 50 queries', () => {
    const few = newDbScope('f');
    const many = newDbScope('m');
    runInDbScope(few, () => { for (let i = 0; i < 49; i++) recordQuery('select 1', 1, false); });
    runInDbScope(many, () => { for (let i = 0; i < 50; i++) recordQuery('select 1', 1, false); });
    expect(stepDb(few)).toEqual({ queries: 49, ms: 49 });
    expect(stepDb(many)).toMatchObject({ queries: 50, top: [{ sql: 'select 1', n: 50 }] });
  });
});
