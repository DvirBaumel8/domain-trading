import { describe, expect, it } from 'vitest';
import { testDb as db } from '../helpers/db.js';
import { screeningHarness } from '../helpers/screening.js';
import { SelectionValues, DEFAULT_SELECTION_VALUES, activeSelectionSettings, applySet } from '../../src/screening/settings.js';

describe('v1.2.0 settings keys', () => {
  it('the stored v1 row (no v1.2 keys) parses and gets every default', async () => {
    const raw = (await db.selectFrom('selection_settings').select('values').where('label', '=', 'v1').executeTakeFirstOrThrow()).values as Record<string, unknown>;
    expect(raw.eu_tm).toBeUndefined();
    const v = SelectionValues.parse(raw);
    expect(v.eu_tm).toEqual({ required_lanes: ['S6'], freshness_hours: 168 });
    expect(v.pack.exclude_checks).toEqual(['census', 'ext_dates', 'namebio', 'leads', 'pack']);
    expect(v.pack.require_checks).toEqual(['same_name']);
    expect(v.pack.availability_max_age_hours).toBe(24);
    expect(v.same_name.max_unknown_sites).toBe(0);
    expect(v.lead.verify.size_max).toBe(10);
    expect(v.lead.qualified_min).toEqual({ S2: 20, S3: 10, S4: 10, S6: 10, S7: 10 });
    expect(v.sources.business_sites).toBe(true);
    expect((await activeSelectionSettings(db)).values.pack).toEqual(DEFAULT_SELECTION_VALUES.pack);
  });
  it('a draft can set a new key and add a freshness window', () => {
    const v = applySet(DEFAULT_SELECTION_VALUES, { 'eu_tm.required_lanes': ['S6', 'S3'], 'freshness_hours.same_name': 168 });
    expect(v.eu_tm.required_lanes).toEqual(['S6', 'S3']);
    expect(v.freshness_hours.same_name).toBe(168);
  });
  it('pack.exclude_checks and pack.require_checks only take check ids', () => {
    expect(() => applySet(DEFAULT_SELECTION_VALUES, { 'pack.require_checks': ['nope'] })).toThrow(/valid/);
  });
  it('never_fetch_hosts must keep linkedin.com (422 SETTINGS_INVALID)', () => {
    expect(() => applySet(DEFAULT_SELECTION_VALUES, { 'lead.verify.never_fetch_hosts': ['example.org'] })).toThrow(/valid/);
    expect(DEFAULT_SELECTION_VALUES.lead.verify.never_fetch_hosts).toContain('linkedin.com');
  });
  it('DEFAULT_SELECTION_VALUES equals what the stored v1 row parses to', async () => {
    const raw = (await db.selectFrom('selection_settings').select('values').where('label', '=', 'v1').executeTakeFirstOrThrow()).values;
    expect(SelectionValues.parse(raw)).toEqual(DEFAULT_SELECTION_VALUES);
  });
  it('POST /selection/settings drafts from v1 with a new-key path; a v1.1.0-shaped run still finishes on v1', async () => {
    const x = await screeningHarness();
    try {
      const d = await x.post('/selection/settings', { label: 'v12d', based_on: 'v1', set: { 'eu_tm.required_lanes': ['S6', 'S3'] } });
      expect(d.statusCode).toBe(201);
      const bad = await x.post('/selection/settings', { label: 'v12e', based_on: 'v1', set: { 'lead.verify.never_fetch_hosts': [] } });
      expect([bad.statusCode, bad.json().error.code]).toEqual([422, 'SETTINGS_INVALID']);
      const r = await x.runDone({ names: [{ domain: 'tampapoolsco.com', lane: 'S3' }], checks: ['form'] });
      expect(r.body.status).toBe('done');
      expect(r.body.settings_version).toBe('v1');
    } finally { await x.app.close(); }
  });
});
