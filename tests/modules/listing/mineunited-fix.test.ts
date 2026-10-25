// v5.20.1: the data migration 1765200000000_v5-20-1.sql. M5201-1 = BUG-047 mineunited.com BIN $1,488 (Dvir's approval); V5201-2 = CR-069 item 5 (old per-bot tokens retired).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../../helpers/app.js';
import { T0 } from '../../helpers/buy.js';
import { testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { V3_SET } from '../../helpers/pricing.js';
import { ensureBidPlan } from '../../helpers/bid-plans.js';
import { issueToken } from '../../helpers/tokens.js';
import { newPricingSettings } from '../../../src/modules/ops/admin/pricing-settings.js';
import { pendingDomains } from '../../../src/modules/listing/export-state.js';
import { computePlan } from '../../../src/modules/listing/pricing/plan.js';
import { buildSchedule } from '../../../src/modules/listing/pricing/schedule.js';
import { currentSettings } from '../../../src/modules/listing/pricing/settings.js';

const UP = readFileSync('migrations/1765200000000_v5-20-1.sql', 'utf8').split('-- Down Migration')[0]!;
const applyUp = () => sql.raw(UP).execute(db);
const M = 'mineunited.com';
let app: FastifyInstance;
afterEach(async () => app?.close());

async function importMineunited() {
  await newPricingSettings(db, { set: { ...V3_SET, comps_min: '0' }, approvalText: 'Dvir 7 Oct 2026: pricing v3, comps optional', approvalAt: new Date(T0 - 3_600_000).toISOString(), now: new Date(T0 - 60_000) });
  app = await makeApp({ adapters: [new FakeAdapter('porkbun')], rdap: async () => 'not_registered', now: () => T0 });
  const auth = (await issueToken('write')).auth;
  await ensureBidPlan(db, M); // v5.39.0 (CR-077): an S8 import runs under a bid plan
  const r = await app.inject({
    method: 'POST', url: '/portfolio/import', headers: { ...auth, 'idempotency-key': randomUUID() },
    payload: {
      domain: M, source: 'closeout', registrar: 'godaddy', price_paid: 24.19, buy_date: '2026-10-05', expiry_date: '2027-09-07', category: 'b2b', lane: 'S8',
      approval_ref: { text: 'yes import mineunited.com on S8 at $3,488 BIN and $2,267 floor', approved_at: new Date(T0 - 3_600_000).toISOString() },
      bin_override: 348800, floor_override: 226700,
    },
  });
  expect(r.statusCode, r.body).toBe(201);
}
const dom = () => db.selectFrom('domains').selectAll().where('domain', '=', M).executeTakeFirstOrThrow();
const sched = (id: number) => db.selectFrom('price_schedule').selectAll().where('domain_id', '=', id).orderBy('id').execute();

describe('v5.20.1 migration', () => {
  it('M5201-1: mineunited.com (S8, BIN 348800) gets BIN 148800 with floor, walk-away, min offer and schedule from the real S8 plan code; history row, export flag; a second apply changes nothing', async () => {
    await importMineunited();
    const before = await dom();
    expect(before).toMatchObject({ lane: 'S8', bin_cents: 348800, floor_cents: 226700, pricing_source: 'approved_exception' });
    // the Afternic file was confirmed: nothing pending
    await db.updateTable('domains').set({ listing_changed_at: null, export_pending_since: null }).where('id', '=', before.id).execute();
    const histBefore = (await db.selectFrom('listing_history').select('id').where('domain_id', '=', before.id).execute()).length;

    // expected: the real plan code for BIN 148800 on an S8 name
    const s = await currentSettings(db, new Date());
    const p = computePlan({ category: 'b2b', mode: 'hybrid', binCents: 148800, s8: true }, s);
    if (!p.ok) throw new Error(p.code);
    const events = buildSchedule({ plan: p.plan, anchor: '2026-10-05', dropDate: before.drop_date!, settings: s, lane: 'S8' });
    expect(events.map((e) => e.event)).toEqual(['final_push', 'delist']); // S8: no M6/M18 drops

    await applyUp();
    const after = await dom();
    expect(after).toMatchObject({
      bin_cents: p.plan.binCents, floor_cents: p.plan.floorCents, walkaway_cents: p.plan.walkawayCents, min_offer_cents: p.plan.minOfferCents,
      pricing_source: p.plan.pricingSource, pricing_settings_version: p.plan.settingsVersion, listing_mode: 'hybrid', lane: 'S8',
    });
    expect([after.bin_cents, after.floor_cents, after.walkaway_cents, after.min_offer_cents]).toEqual([148800, 96700, 71500, 10000]);
    expect(after.plan_id).not.toBe(before.plan_id);

    const hist = await db.selectFrom('listing_history').selectAll().where('domain_id', '=', before.id).orderBy('id').execute();
    expect(hist).toHaveLength(histBefore + 1);
    expect(hist[hist.length - 1]).toMatchObject({
      source: 'list', mode: 'hybrid', bin_cents: 148800, floor_cents: 96700, walkaway_cents: 71500, min_offer_cents: 10000, pricing_source: 'formula', pricing_settings_version: 3,
    });
    expect(hist[hist.length - 1]!.approval_text).toContain('BUG-047');
    expect(hist[hist.length - 1]!.approval_text).toContain('Yes, set mineunited.com to $1,488');
    expect(hist[hist.length - 1]!.approval_at?.toISOString()).toBe('2026-10-20T14:24:00.000Z');

    const rows = await sched(before.id);
    const planned = rows.filter((r) => r.status === 'planned');
    expect(planned.map((r) => [r.event, r.due_on, r.bin_cents, r.floor_cents, r.walkaway_cents, r.plan_id, r.settings_version])).toEqual(
      events.map((e) => [e.event, e.dueOn, e.binCents, e.floorCents, e.walkawayCents, after.plan_id, 3]));
    expect(rows.filter((r) => r.status === 'superseded').map((r) => r.event).sort()).toEqual(['delist', 'final_push']);

    expect(after.listing_changed_at).not.toBeNull();
    expect(after.export_pending_since).not.toBeNull();
    expect(await pendingDomains(db, 'afternic')).toContain(M);

    // a second apply (BIN is no longer 348800) changes nothing
    await applyUp();
    expect(await dom()).toEqual(after);
    expect(await db.selectFrom('listing_history').select('id').where('domain_id', '=', before.id).execute()).toHaveLength(histBefore + 1);
    expect(await sched(before.id)).toEqual(rows);
  });

  it('M5201-1: another name, or a mineunited.com that is not an S8 name at 348800, is left alone', async () => {
    await importMineunited();
    await db.updateTable('domains').set({ lane: null }).where('domain', '=', M).execute();
    const before = await dom();
    await applyUp();
    expect(await dom()).toEqual(before);
  });

  it('V5201-2: only the five per-bot read tokens and data-engineer-upload are revoked', async () => {
    const names: [string, 'read' | 'write' | 'data' | 'visits' | 'bots'][] = [
      ['data-engineer', 'read'], ['scoring-scientist', 'read'], ['shomer', 'read'], ['buyer', 'read'], ['dom-architect', 'read'], ['data-engineer-upload', 'data'],
      ['gavriel-read', 'read'], ['gavriel-write', 'write'], ['visit-counter', 'visits'], ['bots-shared', 'bots'],
    ];
    for (const [name, scope] of names) await issueToken(scope, name);
    await applyUp();
    const rows = await db.selectFrom('api_tokens').select(['name', 'revoked_at']).execute();
    const revoked = rows.filter((r) => r.revoked_at !== null).map((r) => r.name).sort();
    expect(revoked).toEqual(['buyer', 'data-engineer', 'data-engineer-upload', 'dom-architect', 'scoring-scientist', 'shomer']);
    expect(rows.filter((r) => r.revoked_at === null).map((r) => r.name).sort()).toEqual(['bots-shared', 'gavriel-read', 'gavriel-write', 'visit-counter']);
  });
});
