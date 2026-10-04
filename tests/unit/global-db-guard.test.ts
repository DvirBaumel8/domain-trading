import { describe, expect, it } from 'vitest';
import { assertTestDatabaseUrl } from '../setup/global-db.js';

describe('global setup refuses non-test DB', () => {
  it('throws for a DB name without _test', () => {
    expect(() => assertTestDatabaseUrl('postgres://dt:dt@localhost:5433/domain_trading')).toThrow(/_test/);
  });
  it('accepts a _test DB', () => {
    expect(() => assertTestDatabaseUrl('postgres://dt:dt@localhost:5433/domain_trading_test')).not.toThrow();
  });
});
