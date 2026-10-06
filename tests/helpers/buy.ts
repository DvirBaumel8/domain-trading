import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { insertOwnedDomain, testDb } from './db.js';
import { patchActiveSettings } from './screening.js';

export const DOMAIN = 'examplecityroofing.com';

// A fixed instant: buy suites run on this app clock (makeApp({ now: () => T0 })), so approvals never age with the wall clock.
// (Never earlier than the wall clock: a few reconciler tests compare it with the database's now(), which would otherwise run ahead of T0 once the day passes 09:10Z.)
export const T0 = Math.max(Date.parse('2026-10-06T09:00:00Z'), Date.now());

export function approvalNow(domain = DOMAIN, hoursAgo = 1) {
  return { text: `yes buy ${domain} up to $11.50, list BIN $399`, approved_at: new Date(T0 - hoursAgo * 3_600_000).toISOString() };
}

export const COMPS = [
  { domain: 'compa.com', price_usd: 1500, sold_on: '2026-09-01', venue: 'NameBio', source_url: 'https://namebio.com/compa.com' },
  { domain: 'compb.com', price_usd: 2200, sold_on: '2026-08-15', venue: 'NameBio', source_url: 'https://namebio.com/compb.com' },
];

export function buyBody(over: Record<string, unknown> = {}) {
  const domain = (over.domain as string | undefined) ?? DOMAIN;
  return { domain, max_price: 11.5, approval_ref: approvalNow(domain), category: 'geo', price_grade: 'weaker',
    pricing_evidence: { comps: COMPS, rationale: 'fixture' }, ...over };
}

let seq = 0;
let seedQueue: Promise<void> = Promise.resolve();
/**
 * v2.0.0: seeds what a real /buy now needs for `domain`: buy_hold off in the active settings, a done screening run that lists the name (dated after any run a test made), a complete
 * pack from it (issued 1 h before T0) and an active member of the open tranche (opened here if none is). Idempotent per domain.
 */
export async function readyToBuy(domain: string, o: { spendCapCents?: number | null; pack?: Partial<{ status: 'complete' | 'incomplete'; issuedAt: Date; settingsActive: boolean }> } = {}): Promise<{ runId: string; packId: string; trancheId: string }> {
  await patchActiveSettings(['buy_hold'], false);
  const n = ++seq;
  const sel = await testDb.selectFrom('selection_settings').select(['id', 'label']).where('activation_seq', 'is not', null).orderBy('activation_seq', 'desc').executeTakeFirstOrThrow();
  const runId = `run_${String(n).padStart(12, '0')}`;
  await testDb.insertInto('screening_runs').values({
    id: runId, created_at: new Date(T0 + 24 * 3_600_000), created_by: 'test', audit_id: null, mode: 'full', backtest: false, settings_id: sel.id, settings_label: sel.label,
    buy_hold: false, tranche_id: null, input: JSON.stringify({ names: [{ domain, lane: 'S3' }] }), gate_plan: '{}', list_versions: '{}', status: 'done',
    deadline_at: new Date(T0), heartbeat_at: null, finished_at: new Date(T0 - 3_600_000), summary: null,
  }).execute();
  const packId = `pk_${String(n).padStart(12, '0')}`;
  const last = await testDb.selectFrom('screening_packs').select('version').where('domain', '=', domain).orderBy('version', 'desc').limit(1).executeTakeFirst();
  await testDb.insertInto('screening_packs').values({
    id: packId, domain, version: (last?.version ?? 0) + 1, run_id: runId, item_idx: 0, status: o.pack?.status ?? 'complete', missing: '[]',
    content: JSON.stringify({ domain, run_id: runId, settings_label: sel.label, settings_active: o.pack?.settingsActive ?? true }), content_sha256: packId.slice(3).padEnd(64, '0'),
    settings_label: sel.label, issued_at: o.pack?.issuedAt ?? new Date(T0 - 3_600_000), issued_by: 'test',
  }).execute();
  let t = await testDb.selectFrom('tranches').select('id').where('status', '=', 'open').executeTakeFirst();
  if (!t) {
    t = { id: `trn_${String(n).padStart(12, '0')}` };
    await testDb.insertInto('tranches').values({ id: t.id, name: `t-${n}`, status: 'open', opened_by: 'test', settings_label: sel.label, spend_cap_cents: o.spendCapCents ?? null }).execute();
  }
  await testDb.insertInto('tranche_members').values({ tranche_id: t.id, domain, lane: 'S3', is_geo: false, main_lane: true, est_cost_cents: null, run_id: runId, added_by: 'test' }).execute();
  return { runId, packId, trancheId: t.id };
}

/** Real buys are seeded with readyToBuy (unless `ready: false`); a dry run is posted as is. */
export async function postBuy(app: FastifyInstance, body: unknown, auth: Record<string, string>, key: string = randomUUID(), opts: { ready?: boolean } = {}) {
  const b = body as { domain?: unknown; dry_run?: unknown };
  if (opts.ready !== false && b.dry_run !== true && typeof b.domain === 'string') {
    // Seeding is serialised (parallel real buys share the one open tranche and may share a domain, B-6/B-12).
    const d = b.domain;
    const run = seedQueue.then(async () => {
      const have = await testDb.selectFrom('tranche_members').select('id').where('domain', '=', d).where('removed_at', 'is', null).executeTakeFirst();
      if (!have) await readyToBuy(d);
    });
    seedQueue = run.catch(() => undefined);
    await run;
  }
  return app.inject({ method: 'POST', url: '/buy', headers: { ...auth, 'idempotency-key': key }, payload: body as object });
}

export async function seedSpent(cents: number) {
  await testDb.insertInto('ledger_entries').values({
    occurred_on: '2026-10-01', type: 'registration', amount_cents: -cents, domain_id: null, deal_id: null,
    counterparty: 'fixture', receipt_ref: null, note: 'fixture spend', audit_id: null,
  }).execute();
}

export async function seedOwnedDomains(n: number) {
  for (let i = 0; i < n; i++) await insertOwnedDomain(testDb, { domain: `owned${i}.com` });
}
