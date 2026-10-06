import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { insertOwnedDomain, testDb } from './db.js';

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

export async function postBuy(app: FastifyInstance, body: unknown, auth: Record<string, string>, key: string = randomUUID()) {
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
