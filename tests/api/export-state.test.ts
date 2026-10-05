import { beforeEach, describe, expect, it } from 'vitest';
import { insertOwnedDomain, resetDb, testDb as db } from '../helpers/db.js';
import { changedColumns, manualDelist, pendingDomains } from '../../src/services/export-state.js';

const T = (m: number) => new Date(Date.UTC(2026, 9, 5, 10, m));
let n = 0;

beforeEach(async () => { await resetDb(db); n = 0; });

/** A confirmed file: an export_runs row (snapshot time `at`) and its upload. */
async function file(venue: 'afternic' | 'sedo', at: Date, domains: string[] = []) {
  const id = `exp_t${++n}`;
  await db.insertInto('export_runs').values({ marketplace: venue, at, domains, export_id: id }).execute();
  await db.insertInto('export_uploads').values({ venue, export_id: id, domains, uploaded_at: new Date(at.getTime() + 60_000), approval_text: 'uploaded', audit_id: null }).execute();
}
/** A file that was generated but never confirmed. */
const unconfirmed = (venue: 'afternic' | 'sedo', at: Date) =>
  db.insertInto('export_runs').values({ marketplace: venue, at, domains: [], export_id: `exp_u${++n}` }).execute();
const listed = (domain: string, changedAt: Date) => insertOwnedDomain(db, { domain, status: 'listed', listing_changed_at: changedAt });

describe('pendingDomains (listing_changed_at > the snapshot time of the newest confirmed file)', () => {
  it('1: a listed domain with no confirmed upload is pending', async () => {
    await listed('a.com', T(0));
    expect(await pendingDomains(db, 'afternic')).toEqual(['a.com']);
  });
  it('2: not pending after a confirmed file taken after the last change', async () => {
    await listed('a.com', T(0));
    await file('afternic', T(5));
    expect(await pendingDomains(db, 'afternic')).toEqual([]);
  });
  it('3: a change after the confirmed file is pending again', async () => {
    await listed('a.com', T(8));
    await file('afternic', T(5));
    expect(await pendingDomains(db, 'afternic')).toEqual(['a.com']);
  });
  it('4: venues are independent', async () => {
    await listed('a.com', T(0));
    await file('afternic', T(5));
    expect(await pendingDomains(db, 'afternic')).toEqual([]);
    expect(await pendingDomains(db, 'sedo')).toEqual(['a.com']);
  });
  it('(a) a change between the file snapshot and its upload stays pending (the snapshot time, not uploaded_at, is the boundary)', async () => {
    await listed('a.com', T(7));
    await file('afternic', T(5)); // uploaded_at is T(6); the change at T(7) is after the snapshot
    expect(await pendingDomains(db, 'afternic')).toEqual(['a.com']);
  });
  it('(c) an unconfirmed newer file does not count; an older file confirmed after a newer one cannot move the boundary back', async () => {
    await listed('a.com', T(5));
    await unconfirmed('afternic', T(9));
    expect(await pendingDomains(db, 'afternic')).toEqual(['a.com']);
    await file('afternic', T(6));
    await file('afternic', T(2)); // older file, confirmed last
    expect(await pendingDomains(db, 'afternic')).toEqual([]);
  });
  it('an owned domain with a recent listing_changed_at is not pending', async () => {
    await insertOwnedDomain(db, { domain: 'a.com', status: 'owned', listing_changed_at: T(5) });
    expect(await pendingDomains(db, 'afternic')).toEqual([]);
  });
});

describe('manualDelist (went away after the last confirmed file, and was first listed before it)', () => {
  const gone = (domain: string, status: 'delisted' | 'sold' | 'dropped', changedAt: Date, firstListed: Date | null = T(0)) =>
    insertOwnedDomain(db, { domain, status, delisted_at: changedAt, listing_changed_at: changedAt, first_listed_at: firstListed });
  it('5: delisted after a confirmed file that could have carried it is listed (that venue only)', async () => {
    await gone('a.com', 'delisted', T(10));
    await file('afternic', T(5));
    expect(await manualDelist(db, 'afternic')).toEqual(['a.com']);
    expect(await manualDelist(db, 'sedo')).toEqual([]);
  });
  it('a dropped domain is listed the same way', async () => {
    await gone('a.com', 'dropped', T(10));
    await file('afternic', T(5));
    expect(await manualDelist(db, 'afternic')).toEqual(['a.com']);
  });
  it('6: gone after a later confirmed file taken after the status change', async () => {
    await gone('a.com', 'delisted', T(10));
    await file('afternic', T(5));
    await file('afternic', T(12));
    expect(await manualDelist(db, 'afternic')).toEqual([]);
  });
  it('7: a name first listed after the last confirmed file is not listed', async () => {
    await gone('a.com', 'sold', T(10), T(8));
    await file('afternic', T(5));
    expect(await manualDelist(db, 'afternic')).toEqual([]);
  });
  it('a status change before the last confirmed file is not listed (that file already left it out)', async () => {
    await gone('a.com', 'sold', T(3));
    await file('afternic', T(5));
    expect(await manualDelist(db, 'afternic')).toEqual([]);
  });
  it('a Sedo confirmation does not clear the Afternic removal task, and the reverse', async () => {
    await gone('a.com', 'delisted', T(10));
    await file('afternic', T(5));
    await file('sedo', T(5));
    await file('sedo', T(12));
    expect(await manualDelist(db, 'afternic')).toEqual(['a.com']);
    expect(await manualDelist(db, 'sedo')).toEqual([]);
    await gone('b.com', 'delisted', T(20));
    await file('afternic', T(25));
    expect(await manualDelist(db, 'afternic')).toEqual([]);
    expect(await manualDelist(db, 'sedo')).toEqual(['b.com']);
  });
  it('no confirmed upload at the venue: nothing to remove', async () => {
    await gone('a.com', 'sold', T(10));
    await unconfirmed('afternic', T(5));
    expect(await manualDelist(db, 'afternic')).toEqual([]);
  });
  it('a name that was never listed (no first_listed_at) is not listed', async () => {
    await gone('a.com', 'delisted', T(10), null);
    await file('afternic', T(5));
    expect(await manualDelist(db, 'afternic')).toEqual([]);
  });
});

describe('changedColumns', () => {
  it('moves listing_changed_at and keeps an earlier export_pending_since', () => {
    expect(changedColumns({ export_pending_since: T(0) }, T(9))).toEqual({ listing_changed_at: T(9), export_pending_since: T(0) });
    expect(changedColumns({ export_pending_since: null }, T(9))).toEqual({ listing_changed_at: T(9), export_pending_since: T(9) });
  });
});
