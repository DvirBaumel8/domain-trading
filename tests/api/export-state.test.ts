import { beforeEach, describe, expect, it } from 'vitest';
import { insertOwnedDomain, resetDb, testDb as db } from '../helpers/db.js';
import { changedColumns, manualDelist, pendingDomains } from '../../src/services/export-state.js';

const T = (m: number) => new Date(Date.UTC(2026, 9, 5, 10, m));
let n = 0;

beforeEach(async () => { await resetDb(db); n = 0; });

async function file(venue: 'afternic' | 'sedo', domains: string[], fileAt: Date, uploadedAt: Date) {
  const id = `exp_t${++n}`;
  await db.insertInto('export_runs').values({ marketplace: venue, at: fileAt, domains, export_id: id }).execute();
  await db.insertInto('export_uploads').values({ venue, export_id: id, domains, uploaded_at: uploadedAt, approval_text: 'uploaded', audit_id: null }).execute();
}
const listed = (domain: string, changedAt: Date) => insertOwnedDomain(db, { domain, status: 'listed', listing_changed_at: changedAt });

describe('pendingDomains', () => {
  it('1: a listed domain with no uploads is pending', async () => {
    await listed('a.com', T(0));
    expect(await pendingDomains(db, 'afternic')).toEqual(['a.com']);
  });
  it('2: not pending after a confirmed file created at or after the change', async () => {
    await listed('a.com', T(0));
    await file('afternic', ['a.com'], T(0), T(5));
    expect(await pendingDomains(db, 'afternic')).toEqual([]);
  });
  it('3: a change after the file was created is pending again, even if confirmed later', async () => {
    await listed('a.com', T(3));
    await file('afternic', ['a.com'], T(1), T(10));
    expect(await pendingDomains(db, 'afternic')).toEqual(['a.com']);
  });
  it('4: venues are independent', async () => {
    await listed('a.com', T(0));
    await file('afternic', ['a.com'], T(1), T(2));
    expect(await pendingDomains(db, 'afternic')).toEqual([]);
    expect(await pendingDomains(db, 'sedo')).toEqual(['a.com']);
  });
});

describe('manualDelist', () => {
  const gone = (domain: string, status: 'delisted' | 'sold', delistedAt: Date | null) =>
    insertOwnedDomain(db, { domain, status, delisted_at: delistedAt });
  it('5: delisted after a confirmed upload is listed', async () => {
    await gone('a.com', 'delisted', T(20));
    await file('afternic', ['a.com'], T(1), T(2));
    expect(await manualDelist(db, 'afternic')).toEqual(['a.com']);
    expect(await manualDelist(db, 'sedo')).toEqual([]);
  });
  it('6: gone after a later confirmed upload', async () => {
    await gone('a.com', 'delisted', T(20));
    await file('afternic', ['a.com'], T(1), T(2));
    await file('afternic', [], T(25), T(26));
    expect(await manualDelist(db, 'afternic')).toEqual([]);
  });
  it('7: a sold domain never uploaded is not listed', async () => {
    await gone('a.com', 'sold', T(20));
    expect(await manualDelist(db, 'afternic')).toEqual([]);
  });
  it('8: delisted_at null and uploaded is listed', async () => {
    await gone('a.com', 'sold', null);
    await file('afternic', ['a.com'], T(1), T(2));
    await file('afternic', [], T(25), T(26));
    expect(await manualDelist(db, 'afternic')).toEqual(['a.com']);
  });
});

describe('changedColumns', () => {
  it('moves listing_changed_at and keeps an earlier export_pending_since', () => {
    expect(changedColumns({ export_pending_since: T(0) }, T(9))).toEqual({ listing_changed_at: T(9), export_pending_since: T(0) });
    expect(changedColumns({ export_pending_since: null }, T(9))).toEqual({ listing_changed_at: T(9), export_pending_since: T(9) });
  });
});
