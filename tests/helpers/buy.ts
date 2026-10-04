import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { insertOwnedDomain, testDb } from './db.js';

export const DOMAIN = 'examplecityroofing.com';

export function approvalNow(domain = DOMAIN, hoursAgo = 1) {
  return { text: `yes buy ${domain} up to $11.50, list BIN $399`, approved_at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString() };
}

export function buyBody(over: Record<string, unknown> = {}) {
  const domain = (over.domain as string | undefined) ?? DOMAIN;
  return { domain, max_price: 11.5, approval_ref: approvalNow(domain), category: 'geo', ...over };
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
