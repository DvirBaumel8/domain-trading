import { beforeEach, describe, expect, it } from 'vitest';
import { insertOwnedDomain, resetDb, testDb as db } from '../helpers/db.js';
import { changedColumns, manualDelist, pendingDomains } from '../../src/services/export-state.js';

const T = (m: number) => new Date(Date.UTC(2026, 9, 5, 10, m));
let n = 0;

beforeEach(async () => { await resetDb(db); n = 0; });

/** A confirmed file: run, per-domain record (domain -> listing_changed_at seen), delist list, upload. */
async function file(venue: 'afternic' | 'sedo', recorded: Record<string, Date | null>, opts: { delist?: string[]; at?: Date } = {}) {
  const id = `exp_t${++n}`;
  const domains = Object.keys(recorded);
  await db.insertInto('export_runs').values({ marketplace: venue, at: opts.at ?? T(n), domains, export_id: id, delist: opts.delist ?? [] }).execute();
  if (domains.length > 0) {
    await db.insertInto('export_run_domains').values(domains.map((domain) => ({ export_id: id, domain, listing_changed_at: recorded[domain]! }))).execute();
  }
  await db.insertInto('export_uploads').values({ venue, export_id: id, domains, uploaded_at: T(n), approval_text: 'uploaded', audit_id: null }).execute();
}
const listed = (domain: string, changedAt: Date) => insertOwnedDomain(db, { domain, status: 'listed', listing_changed_at: changedAt });

describe('pendingDomains', () => {
  it('1: a listed domain with no uploads is pending', async () => {
    await listed('a.com', T(0));
    expect(await pendingDomains(db, 'afternic')).toEqual(['a.com']);
  });
  it('2: not pending after a confirmed file that recorded the current listing_changed_at', async () => {
    await listed('a.com', T(0));
    await file('afternic', { 'a.com': T(0) });
    expect(await pendingDomains(db, 'afternic')).toEqual([]);
  });
  it('3: a change after what the file recorded is pending again', async () => {
    await listed('a.com', T(3));
    await file('afternic', { 'a.com': T(1) });
    expect(await pendingDomains(db, 'afternic')).toEqual(['a.com']);
  });
  it('4: venues are independent', async () => {
    await listed('a.com', T(0));
    await file('afternic', { 'a.com': T(0) });
    expect(await pendingDomains(db, 'afternic')).toEqual([]);
    expect(await pendingDomains(db, 'sedo')).toEqual(['a.com']);
  });
  it('(a) a /list change committed after a snapshot but with an older listing_changed_at than the file `at` stays pending after confirming it', async () => {
    await listed('a.com', T(5)); // current change is T(5), earlier than the file's at T(10)
    await file('afternic', { 'a.com': T(2) }, { at: T(10) }); // the snapshot saw the older value T(2)
    expect(await pendingDomains(db, 'afternic')).toEqual(['a.com']);
  });
  it('(c) an older file confirmed after a newer one: pending only if the current change is newer than every confirmed record', async () => {
    await listed('a.com', T(5));
    await file('afternic', { 'a.com': T(5) });
    await file('afternic', { 'a.com': T(2) }); // older file, confirmed last
    expect(await pendingDomains(db, 'afternic')).toEqual([]);
    await db.updateTable('domains').set({ listing_changed_at: T(8) }).where('domain', '=', 'a.com').execute();
    expect(await pendingDomains(db, 'afternic')).toEqual(['a.com']);
  });
  it('an owned domain with a recent listing_changed_at is not pending', async () => {
    await insertOwnedDomain(db, { domain: 'a.com', status: 'owned', listing_changed_at: T(5) });
    expect(await pendingDomains(db, 'afternic')).toEqual([]);
  });
});

describe('manualDelist', () => {
  const gone = (domain: string, status: 'delisted' | 'sold' | 'dropped') =>
    insertOwnedDomain(db, { domain, status, delisted_at: T(20) });
  it('5: delisted after it went live in a confirmed file is listed (that venue only)', async () => {
    await gone('a.com', 'delisted');
    await file('afternic', { 'a.com': T(0) });
    expect(await manualDelist(db, 'afternic')).toEqual(['a.com']);
    expect(await manualDelist(db, 'sedo')).toEqual([]);
  });
  it('a dropped domain that went live is listed', async () => {
    await gone('a.com', 'dropped');
    await file('afternic', { 'a.com': T(0) });
    expect(await manualDelist(db, 'afternic')).toEqual(['a.com']);
  });
  it('6: gone after a later confirmed file whose delist list names it', async () => {
    await gone('a.com', 'delisted');
    await file('afternic', { 'a.com': T(0) });
    await file('afternic', {}, { delist: ['a.com'] });
    expect(await manualDelist(db, 'afternic')).toEqual([]);
  });
  it('7: a sold domain that never went live is not listed', async () => {
    await gone('a.com', 'sold');
    expect(await manualDelist(db, 'afternic')).toEqual([]);
  });
  it('8: a confirmed later file that lacks the domain in its delist list does not clear it', async () => {
    await gone('a.com', 'sold');
    await file('afternic', { 'a.com': T(0) });
    await file('afternic', {});
    expect(await manualDelist(db, 'afternic')).toEqual(['a.com']);
  });
  it('(b) confirming a file generated before the delist (no delist entry) keeps it; a later file with it clears it', async () => {
    await gone('a.com', 'delisted');
    await file('afternic', { 'a.com': T(0) }); // generated while listed; its delist array is empty
    expect(await manualDelist(db, 'afternic')).toEqual(['a.com']);
    await file('afternic', {}, { delist: ['a.com'] });
    expect(await manualDelist(db, 'afternic')).toEqual([]);
  });
  it('a delist confirmed at another venue does not clear this one', async () => {
    await gone('a.com', 'delisted');
    await file('afternic', { 'a.com': T(0) });
    await file('sedo', {}, { delist: ['a.com'] });
    expect(await manualDelist(db, 'afternic')).toEqual(['a.com']);
  });
});

describe('changedColumns', () => {
  it('moves listing_changed_at and keeps an earlier export_pending_since', () => {
    expect(changedColumns({ export_pending_since: T(0) }, T(9))).toEqual({ listing_changed_at: T(9), export_pending_since: T(0) });
    expect(changedColumns({ export_pending_since: null }, T(9))).toEqual({ listing_changed_at: T(9), export_pending_since: T(9) });
  });
});
