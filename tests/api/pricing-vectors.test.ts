import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/http/canonical-json.js';
import { computePlan, type PlanInput } from '../../src/modules/listing/pricing/plan.js';
import { buildSchedule } from '../../src/modules/listing/pricing/schedule.js';
import { currentSettings, ruleFields } from '../../src/modules/listing/pricing/settings.js';
import { testDb as db } from '../helpers/db.js';

const V = JSON.parse(readFileSync('tests/fixtures/pricing-vectors.v2.json', 'utf8'));

describe('PR-44: vectors are keyed by the settings version', () => {
  it('Review Focus 5: the current version and its rule fingerprint match the vector file', async () => {
    const s = await currentSettings(db, new Date());
    const sha = createHash('sha256').update(canonicalJson(ruleFields(s))).digest('hex');
    expect({ version: s.version, sha }).toEqual({ version: V.settings_version, sha: V.settings_sha256 });
  });
  it('every plan and schedule vector reproduces exactly', async () => {
    const s = await currentSettings(db, new Date());
    for (const v of V.plans) {
      const r = computePlan(v.input as PlanInput, s);
      if (!r.ok) throw new Error(`${JSON.stringify(v.input)} → ${r.code}`);
      expect([r.plan.floorCents, r.plan.walkawayCents, r.plan.minOfferCents, r.plan.settingsVersion]).toEqual([v.floor, v.walkaway, v.min_offer, V.settings_version]);
    }
    for (const v of V.schedules) {
      const r = computePlan(v.input as PlanInput, s);
      if (!r.ok) throw new Error(r.code);
      const ev = buildSchedule({ plan: r.plan, anchor: v.anchor, dropDate: v.drop_date, settings: s });
      expect(ev.map((e) => [e.event, e.dueOn, e.binCents, e.floorCents, e.walkawayCents, e.status])).toEqual(v.events);
    }
  });
});
