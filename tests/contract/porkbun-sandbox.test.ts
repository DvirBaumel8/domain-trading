// Gate G2, layer 3: the adapter and B-26 against Porkbun's SANDBOX (fake credit, no real registry actions).
// Opt-in: `npm run test:contract:sandbox`. Safety guard in ./sandbox-guard.ts (pk1_sb_/sk1_sb_ only).
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PorkbunAdapter } from '../../src/registrars/porkbun.js';
import { RegistrarError, type RegisterSuccess } from '../../src/registrars/types.js';
import { logCapture, makeApp } from '../helpers/app.js';
import { COMPS } from '../helpers/buy.js';
import { resetDb, testDb as db } from '../helpers/db.js';
import { issueToken } from '../helpers/tokens.js';
import {
  SANDBOX_BASE, getSandboxKeys, guardLog, installGuardFetch, redact, sandboxClient, type SandboxKeys,
} from './sandbox-guard.js';

const rand = () => `dt-g2-${randomBytes(6).toString('hex')}.com`;
const DOMAIN_ADAPTER = rand(); // adapter E2E + dry runs
const DOMAIN_IDEM = rand(); // registrar-level idempotency
const DOMAIN_B26 = rand(); // B-26 through the service

let keys: SandboxKeys;
let adapter: PorkbunAdapter;
let sb: ReturnType<typeof sandboxClient>;
const transcript: string[] = []; // redacted exact responses for the report
const note = (label: string, v: unknown) => {
  const line = redact(`${label}: ${JSON.stringify(v)}`, keys);
  transcript.push(line);
  console.log(line);
};

beforeAll(async () => {
  installGuardFetch();
  keys = await getSandboxKeys(); // asserts the sandbox prefixes before anything else
  sb = sandboxClient(keys);
  adapter = new PorkbunAdapter({ apiKey: keys.apiKey, secretKey: keys.secretKey, baseUrl: SANDBOX_BASE });
  expect(adapter.capabilities.sandbox).toBe(true);
  await resetDb(db);
});

afterAll(async () => {
  await db.destroy();
  console.log(`guard log:\n${guardLog.join('\n')}`);
});

describe('sandbox setup', () => {
  it('reset (before the suite), then balance > 0 and sandbox:true', async () => {
    const reset = await sb.post('/sandbox/reset');
    note('reset', reset.json);
    expect(reset.json).toMatchObject({ status: 'SUCCESS', sandbox: true });
    const bal = await sb.get('/account/balance');
    note('balance', bal.json);
    expect(bal.json.sandbox).toBe(true);
    expect(bal.json.balance).toBeGreaterThan(0);
  });
});

describe('adapter end to end', () => {
  let costCents: number;

  it('quote: random .com is available with prices', async () => {
    const q = await adapter.quote(DOMAIN_ADAPTER);
    note('quote', q.raw);
    expect(q).toMatchObject({ available: true, premium: false, currency: 'USD' });
    expect(q.firstYearCents).toBeGreaterThan(0);
    costCents = q.firstYearCents!;
  });

  it('accountState: balance, auto top-up off', async () => {
    const s = await adapter.accountState();
    note('accountState', s);
    expect(s.balanceCents).toBeGreaterThan(0);
    if (s.autoTopupEnabled !== null) expect(s.autoTopupEnabled).toBe(false);
  });

  it('dry run with the exact cost: wouldSucceed, nothing charged', async () => {
    const before = (await sb.get('/account/balance')).json.balance;
    const r = await adapter.register(DOMAIN_ADAPTER, { costCents, idempotencyKey: `dtdry-${randomUUID()}`, dryRun: true });
    note('dryRun', r);
    expect(r).toMatchObject({ kind: 'dry_run', wouldSucceed: true, costCents, durationYears: 1 });
    expect((await sb.get('/account/balance')).json.balance).toBe(before);
  });

  it('dry run with cost - 1: coded COST_MISMATCH, mapped as definite (not ambiguous)', async () => {
    const err = await adapter
      .register(DOMAIN_ADAPTER, { costCents: costCents - 1, idempotencyKey: `dtdry-${randomUUID()}`, dryRun: true })
      .then(() => null, (e: unknown) => e);
    note('costMismatch', err instanceof RegistrarError ? { code: err.code, httpStatus: err.httpStatus, ambiguous: err.ambiguous, details: err.details } : String(err));
    expect(err).toBeInstanceOf(RegistrarError);
    const e = err as RegistrarError;
    expect(e.code).toBe('COST_MISMATCH');
    expect(e.ambiguous).toBe(false);
  });
});

describe('registrar-level Idempotency-Key (24 h replay)', () => {
  const key = `dt-g2-${randomUUID()}`;
  let costCents: number;
  let first: RegisterSuccess;
  let balanceAfterFirst: number;
  let invoicesAfterFirst: number;

  it('real create, then the same key and body replays: same order, no second charge', async () => {
    costCents = (await adapter.quote(DOMAIN_IDEM)).firstYearCents!;
    const b0 = (await sb.get('/account/balance')).json.balance as number;
    first = (await adapter.register(DOMAIN_IDEM, { costCents, idempotencyKey: key, dryRun: false })) as RegisterSuccess;
    note('create', first.raw);
    expect(first).toMatchObject({ kind: 'registered', chargedCents: costCents });
    balanceAfterFirst = (await sb.get('/account/balance')).json.balance;
    expect(b0 - balanceAfterFirst).toBe(first.chargedCents);
    invoicesAfterFirst = ((await sb.get('/account/invoices')).json.invoices as unknown[]).length;

    const again = (await adapter.register(DOMAIN_IDEM, { costCents, idempotencyKey: key, dryRun: false })) as RegisterSuccess;
    note('replay (adapter)', again.raw);
    expect(again.orderId).toBe(first.orderId);
    expect(again.chargedCents).toBe(first.chargedCents);
    expect((await sb.get('/account/balance')).json.balance).toBe(balanceAfterFirst);
    expect(((await sb.get('/account/invoices')).json.invoices as unknown[]).length).toBe(invoicesAfterFirst);

    const raw = await sb.post(`/domain/create/${DOMAIN_IDEM}`, { cost: costCents, agreeToTerms: 'yes', whoisPrivacy: true }, { 'Idempotency-Key': key });
    note('replay (raw)', { status: raw.status, replayedHeader: raw.headers.get('idempotent-replayed'), body: raw.json });
    expect(raw.json.orderId).toBe(first.raw && (first.raw as Record<string, unknown>).orderId);
  });

  it('same key with a different body: 409 IDEMPOTENCY_KEY_MISMATCH, mapped by the adapter', async () => {
    const err = await adapter
      .register(DOMAIN_IDEM, { costCents: costCents + 1, idempotencyKey: key, dryRun: false })
      .then(() => null, (e: unknown) => e);
    note('mismatch', err instanceof RegistrarError ? { code: err.code, httpStatus: err.httpStatus, ambiguous: err.ambiguous } : String(err));
    expect(err).toBeInstanceOf(RegistrarError);
    expect(err).toMatchObject({ code: 'IDEMPOTENCY_KEY_MISMATCH', httpStatus: 409 });
    expect((await sb.get('/account/balance')).json.balance).toBe(balanceAfterFirst);
  });
});

describe('B-26: full /buy through the service against the sandbox', () => {
  let app: FastifyInstance;
  const logs = logCapture();
  const key = `b26-${randomUUID()}`;
  let auth: Record<string, string>;
  let first: { statusCode: number; body: string; json: () => any };

  afterAll(async () => app?.close());

  it('201; rows correct; same-key replay does not create a second sandbox order', async () => {
    app = await makeApp({ adapters: [adapter], rdap: async () => 'not_registered', logStream: logs.stream });
    auth = (await issueToken('write')).auth;
    const q = await adapter.quote(DOMAIN_B26);
    expect(q.available).toBe(true);
    const priceUsd = q.firstYearCents! / 100;
    const body = {
      domain: DOMAIN_B26, max_price: priceUsd, category: 'geo', price_grade: 'weaker', auto_list: true,
      approval_ref: { text: `yes buy ${DOMAIN_B26} up to $${priceUsd.toFixed(2)}, list BIN $399`, approved_at: new Date(Date.now() - 3_600_000).toISOString() },
      pricing_evidence: { comps: COMPS, rationale: 'sandbox B-26' },
    };
    const send = () => app.inject({ method: 'POST', url: '/buy', headers: { ...auth, 'idempotency-key': key }, payload: body });
    const b0 = (await sb.get('/account/balance')).json.balance as number;
    const inv0 = ((await sb.get('/account/invoices')).json.invoices as unknown[]).length;

    first = await send();
    note('B-26 /buy response', { status: first.statusCode, body: first.json() });
    expect(first.statusCode).toBe(201);
    const b = first.json();
    expect(b).toMatchObject({ domain: DOMAIN_B26, registrar: 'porkbun', renewals_used: 0, charged_cents: q.firstYearCents });

    // rows
    const ledger = await db.selectFrom('ledger_entries').selectAll().where('type', '=', 'registration').execute();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ amount_cents: -b.charged_cents, counterparty: 'porkbun', audit_id: b.audit_id });
    expect(ledger[0]!.receipt_ref).toBe(`porkbun:${b.order_id}`);
    const dom = await db.selectFrom('domains').selectAll().where('domain', '=', DOMAIN_B26).executeTakeFirstOrThrow();
    expect(dom).toMatchObject({ status: 'owned', registrar: 'porkbun', cost_cents: b.charged_cents, renewals_used: 0, category: 'geo' });
    expect(dom.expiry_date).toBe(b.expiry_date);
    const exp = new Date(`${b.expiry_date}T00:00:00Z`);
    exp.setUTCFullYear(exp.getUTCFullYear() + 1);
    expect(String(dom.drop_date).slice(0, 10)).toBe(exp.toISOString().slice(0, 10));
    expect(dom.lander).toBe('afternic');
    const rcpt = await db.selectFrom('receipts').selectAll().execute();
    expect(rcpt).toHaveLength(1);
    expect(rcpt[0]).toMatchObject({ registrar: 'porkbun', order_id: b.order_id });
    const purchases = await db.selectFrom('purchases').selectAll().execute();
    expect(purchases).toHaveLength(1);
    expect(purchases[0]).toMatchObject({ state: 'succeeded', charged_cents: b.charged_cents, order_id: b.order_id, dry_run: false });
    expect(await db.selectFrom('pricing_evidence').selectAll().execute()).toHaveLength(1);
    expect(b.post_buy).toMatchObject({ privacy: 'on', auto_renew: 'off' });
    // the sandbox charged exactly once
    expect(b0 - ((await sb.get('/account/balance')).json.balance as number)).toBe(b.charged_cents);
    const inv1 = ((await sb.get('/account/invoices')).json.invoices as unknown[]).length;
    expect(inv1).toBe(inv0 + 1);

    // replay
    const second = await send();
    note('B-26 replay', { status: second.statusCode, replayed: second.headers['idempotent-replayed'] });
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toBe(first.body);
    expect(((await sb.get('/account/invoices')).json.invoices as unknown[]).length).toBe(inv1);
    expect(await db.selectFrom('purchases').selectAll().execute()).toHaveLength(1);
  });

  it('/list re-points the nameservers: updateNs + getNs set compare', async () => {
    const ns = ['ns1.afternic.com', 'ns2.afternic.com'];
    const res = await app.inject({
      method: 'POST', url: `/list/${DOMAIN_B26}`, headers: { ...auth, 'idempotency-key': `l-${randomUUID()}` },
      payload: { lander: 'afternic' },
    });
    note('B-26 /list', { status: res.statusCode, body: res.json() });
    expect([200, 201]).toContain(res.statusCode);
    expect([...(await adapter.getNameservers(DOMAIN_B26))].sort()).toEqual(ns);
  });

  it('auto-renew off and privacy on, verified via domain/get', async () => {
    await adapter.setAutoRenew(DOMAIN_B26, false);
    const info = await adapter.findDomain(DOMAIN_B26);
    note('domain/get', info);
    expect(info?.autoRenew).toBe(false);
    expect(info?.whoisPrivacy).toBe(true);
  });

  it('secrets: logs and bodies hold neither sandbox key', async () => {
    const hay = [logs.text(), first.body, transcript.join('\n')].join('\n');
    expect(hay).not.toContain(keys.apiKey);
    expect(hay).not.toContain(keys.secretKey);
    expect(hay).not.toMatch(/[ps]k1_sb_[A-Za-z0-9]{6,}/);
  });
});
