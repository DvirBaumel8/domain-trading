import { describe, expect, it } from 'vitest';
import { RegistrarCheckJob } from '../../src/jobs/registrar-check.js';
import { RegistrarError } from '../../src/registrars/types.js';
import { insertOwnedDomain, testDb as db } from '../helpers/db.js';
import { FakeAdapter } from '../helpers/fake-adapter.js';
import { listedDomain } from '../helpers/listing.js';

const D = 'examplecityroofing.com';
let NOW = Date.parse('2026-10-12T00:30:00Z');
const job = (a: FakeAdapter[]) => new RegistrarCheckJob({ db, adapters: a, now: () => NOW });
const presence = () => db.selectFrom('registrar_presence').selectAll().execute();
const gone = () => new FakeAdapter('porkbun', { findDomain: () => null });
const here = () => new FakeAdapter('porkbun', { alreadyOwned: true });

describe('registrar check job', () => {
  it('SL-6: listed domain, definite null, no sale -> absent; status unchanged; zero registrar writes; one audit row', async () => {
    const id = await listedDomain({ domain: D, registrar: 'porkbun', registrar_api: 'full' });
    const a = gone();
    const r = await job([a]).runOnce();
    expect(r).toMatchObject({ checked: 1, absent: 1, present: 0, errors: 0, newlyAbsent: [D] });
    const p = await presence();
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ domain_id: id, status: 'absent' });
    expect(p[0]!.first_absent_at?.getTime()).toBe(NOW);
    expect((await db.selectFrom('domains').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status).toBe('listed');
    expect(a.calls).toEqual([`findDomain ${D}`]);
    const audits = await db.selectFrom('audit_log').selectAll().where('scope', '=', 'job').where('path', '=', 'registrar-check').execute();
    expect(audits).toHaveLength(1);
  });

  it('SL-6: first_absent_at is kept on a second absent day', async () => {
    await listedDomain({ domain: D, registrar: 'porkbun', registrar_api: 'full' });
    await job([gone()]).runOnce();
    const first = NOW;
    NOW += 86_400_000;
    const r = await job([gone()]).runOnce();
    expect(r.newlyAbsent).toEqual([]);
    const p = (await presence())[0]!;
    expect(p.first_absent_at?.getTime()).toBe(first);
    expect(p.last_checked_at.getTime()).toBe(NOW);
  });

  it('SL-6: absent then present -> cleared', async () => {
    await listedDomain({ domain: D, registrar: 'porkbun', registrar_api: 'full' });
    await job([gone()]).runOnce();
    await job([here()]).runOnce();
    const p = (await presence())[0]!;
    expect(p.status).toBe('present');
    expect(p.first_absent_at).toBeNull();
  });

  it('SL-6: a sold domain is never checked', async () => {
    await listedDomain({ domain: D, registrar: 'porkbun', registrar_api: 'full', status: 'sold' });
    const a = gone();
    const r = await job([a]).runOnce();
    expect(r.checked).toBe(0);
    expect(a.calls).toEqual([]);
    expect(await presence()).toHaveLength(0);
  });

  it('SL-6: a registrar timeout changes nothing and is counted', async () => {
    await listedDomain({ domain: D, registrar: 'porkbun', registrar_api: 'full' });
    await job([gone()]).runOnce();
    const err = new FakeAdapter('porkbun', { findDomain: () => new RegistrarError('porkbun', 'REGISTRAR_TIMEOUT', 't', { ambiguous: true }) });
    NOW += 86_400_000;
    const before = (await presence())[0]!;
    const r = await job([err]).runOnce();
    expect(r).toMatchObject({ checked: 0, errors: 1 });
    const after = (await presence())[0]!;
    expect(after.status).toBe('absent');
    expect(after.last_checked_at.getTime()).toBe(before.last_checked_at.getTime());
  });

  it('SL-6: registrar_api=none (D-001) is skipped; so is a domain with no enabled adapter', async () => {
    await insertOwnedDomain(db, { domain: 'promptinjectionaudit.com', status: 'owned', registrar: 'godaddy', registrar_api: 'none' });
    await listedDomain({ domain: D, registrar: 'namecheap', registrar_api: 'full' });
    const a = gone();
    const r = await job([a]).runOnce();
    expect(r.checked).toBe(0);
    expect(a.calls).toEqual([]);
    expect(await presence()).toHaveLength(0);
  });

  it('dry run writes nothing (no presence, no audit) but reports', async () => {
    await listedDomain({ domain: D, registrar: 'porkbun', registrar_api: 'full' });
    const r = await job([gone()]).runOnce({ dryRun: true });
    expect(r).toMatchObject({ dryRun: true, absent: 1, newlyAbsent: [D] });
    expect(await presence()).toHaveLength(0);
    expect(await db.selectFrom('audit_log').selectAll().where('path', '=', 'registrar-check').execute()).toHaveLength(0);
  });
});
