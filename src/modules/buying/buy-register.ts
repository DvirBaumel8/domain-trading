// The money phase of a /buy: replay of a prior outcome, the reservation under the locks, the registrar call (persisted `register_sent` first, retries,
// ambiguity resolved by looking), bookkeeping and the 201 body. After `register_sent` nothing here ever answers 5xx.
import { advisoryXactLock } from '../../core/locks.js';
import { sql } from 'kysely';
import { AppError, errorBody } from '../../http/errors.js';
import { addOneYear, idtDay } from '../../core/dates.js';
import { formatUsd } from '../../core/money.js';
import { RegistrarError, type DomainInfo, type RegisterSuccess } from '../registrars/index.js';
import { bookPurchase, failPurchase, markUnknown, registrarApiOf, storeResponse } from './bookkeeping.js';
import { screeningHold } from './buy-hold.js';
import { gateError, packGate, trancheGate } from './buy-gates.js';
import { smallBuyError, smallBuyGate } from './small-buy.js';
import { assertDomainCap, assertNotOwned, isUniqueViolation, reservePending } from './buy-reserve.js';
import { postBuy } from './buy-postbuy.js';
import { horizonWarnings, policyFields, type Approved, type BuyCtx, type BuyDeps, type BuyResult } from './buy-types.js';

const RETRY_DELAYS_MS = [2000, 5000, 10000];

function sleep(deps: BuyDeps, ms: number): Promise<void> {
  return (deps.sleep ?? ((t) => new Promise((r) => setTimeout(r, t))))(ms);
}

export async function priorOutcome(deps: BuyDeps, ctx: BuyCtx, domain: string): Promise<BuyResult | null> {
  const { db } = deps;
  const p = await db.selectFrom('purchases').select(['id', 'domain', 'state', 'response', 'audit_id', 'charged_cents', 'order_id'])
    .where('idempotency_key', '=', ctx.idempotencyKey).executeTakeFirst();
  if (!p) return null;
  if (p.domain !== domain) throw new AppError(409, 'IDEMPOTENCY_KEY_MISMATCH', 'This Idempotency-Key was used for a different domain');
  const r = p.response as { status: number; body: Record<string, unknown> } | null;
  if (p.state === 'succeeded') {
    if (r && r.status === 201) return { status: 201, body: r.body };
    return reconstructed(deps, p);
  }
  if (r) return { status: r.status, body: r.body };
  return unknownBody(p.id, p.domain, p.audit_id ?? ctx.auditId);
}

/** A booked purchase is always reported as 201, even if its stored response is missing or stale (e.g. booked by the reconciler). */
async function reconstructed(deps: BuyDeps, p: { domain: string; audit_id: string | null; charged_cents: number | null; order_id: string | null }): Promise<BuyResult> {
  const dom = await deps.db.selectFrom('domains').selectAll().where('domain', '=', p.domain).executeTakeFirst();
  const charged = p.charged_cents ?? dom?.cost_cents ?? null;
  const renewal = dom?.renewal_price_cents ?? null;
  return {
    status: 201,
    body: {
      domain: p.domain, registrar: dom?.registrar ?? null, order_id: p.order_id,
      ...(charged !== null ? { charged: formatUsd(charged), charged_cents: charged } : {}),
      ...(renewal !== null ? { renewal: formatUsd(renewal), renewal_cents: renewal } : {}),
      expiry_date: dom?.expiry_date ?? null, drop_date: dom?.drop_date ?? null, renewals_used: dom?.renewals_used ?? 0,
      post_buy: { privacy: 'unknown', auto_renew: 'unconfirmed', lander: dom?.lander ? `${dom.lander} ns set` : 'skipped', listing: null },
      warnings: ['RECONSTRUCTED: original response unavailable; figures from the ledger'], audit_id: p.audit_id,
    },
  };
}

function unknownBody(purchaseId: number, domain: string, auditId: string): BuyResult {
  return {
    status: 202,
    body: {
      status: 'unknown', code: 'PURCHASE_STATE_UNKNOWN', domain, purchase_id: purchaseId, audit_id: auditId,
      message: 'The registrar may or may not have registered the domain. The bookkeeping resolves on the next daily run (00:05 UTC) or when a job run is started by hand. Do not retry with a new Idempotency-Key.',
    },
  };
}

async function unknown(deps: BuyDeps, a: Approved, purchaseId: number): Promise<BuyResult> {
  const r = unknownBody(purchaseId, a.input.domain, a.ctx.auditId);
  await markUnknown(deps.db, purchaseId, r);
  return (await ifBooked(deps, purchaseId)) ?? r;
}

/** A concurrent reconciler may have booked the purchase; if so report the booked 201, never a 409/202. */
async function ifBooked(deps: BuyDeps, purchaseId: number): Promise<BuyResult | null> {
  const p = await deps.db.selectFrom('purchases').select(['domain', 'state', 'audit_id', 'charged_cents', 'order_id'])
    .where('id', '=', purchaseId).executeTakeFirst();
  return p?.state === 'succeeded' ? reconstructed(deps, p) : null;
}

async function rejected(deps: BuyDeps, a: Approved, purchaseId: number, code: string, message: string, details: Record<string, unknown>): Promise<BuyResult> {
  const r = { status: 409, body: errorBody(code, message, details) as Record<string, unknown> };
  await failPurchase(deps.db, purchaseId, a.input.domain, r);
  return (await ifBooked(deps, purchaseId)) ?? r;
}

/** Reservation: per-domain advisory lock + global settings lock; authoritative re-checks 4, 5, 8. */
async function reserve(deps: BuyDeps, a: Approved): Promise<number> {
  const { db } = deps;
  try {
    return await db.transaction().execute(async (trx) => {
      await advisoryXactLock(trx, `domain:${a.input.domain}`);
      const s = await trx.selectFrom('settings').select(['max_domains', 's8_reserved_slots']).forUpdate().executeTakeFirstOrThrow();
      await assertNotOwned(trx, a.input.domain);
      await assertDomainCap(trx, s);
      // v2.0.0: the hold and the pack, re-read under the global lock (a screening run started since the first checks changes both)
      const hold = await screeningHold(trx, a.input.domain);
      if (a.smallBuy) {
        const sg = smallBuyGate(a.cost, a.winner.premium);
        if (sg) throw smallBuyError(sg.gate);
      } else if (hold) {
        throw new AppError(409, 'BUY_HOLD', `${a.input.domain} was screened under selection settings "${hold.settingsVersion}" while buy_hold is on (or the version is a backtest or no longer active); no real buy`,
          { settings_version: hold.settingsVersion, run_id: hold.runId });
      }
      const pg = await packGate(trx, a.input.domain, deps.now());
      if (pg) throw gateError(pg);
      // the tranche, re-read under the global lock
      const tg = await trancheGate(trx, a.input.domain);
      if ('gate' in tg) throw gateError(tg.gate);
      return reservePending(trx, { ...a, trancheId: tg.trancheId }, {
        idempotencyKey: a.ctx.idempotencyKey, state: 'created', registrar: a.winner.registrar, expectedCents: a.cost,
        domainExtra: {
          display_name: a.displayName, horizon: a.horizon, screening_group: a.screeningGroup,
          buy_card: JSON.stringify({ stre_bp: a.math?.stre_bp ?? null, stre_reason: a.streReason, renewal_math: a.math }),
        },
      });
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError(409, 'ALREADY_OWNED_OR_PENDING', `${a.input.domain} is already owned or being bought`);
    throw e;
  }
}

export async function purchase(deps: BuyDeps, a: Approved): Promise<BuyResult> {
  const purchaseId = await reserve(deps, a);
  let sent = false;
  try {
    return await execute(deps, a, purchaseId, () => {
      sent = true;
    });
  } catch (e) {
    if (!sent) {
      // Nothing reached the registrar: release the reservation, surface the error.
      const status = e instanceof AppError ? e.status : 500;
      const body = e instanceof AppError ? errorBody(e.code, e.message, e.details) : errorBody('INTERNAL', 'Internal error');
      if (!(e instanceof AppError && e.code === 'PURCHASE_ABANDONED')) {
        await failPurchase(deps.db, purchaseId, a.input.domain, { status, body }, { fromStates: ['created'] });
      }
      throw e;
    }
    // After register_sent: NEVER 5xx (the money invariant).
    deps.log?.error({ purchaseId, errMessage: (e as Error).message }, 'purchase error after register_sent');
    try {
      return await unknown(deps, a, purchaseId);
    } catch {
      return unknownBody(purchaseId, a.input.domain, a.ctx.auditId);
    }
  }
}

async function execute(deps: BuyDeps, a: Approved, purchaseId: number, markSent: () => void): Promise<BuyResult> {
  const { adapter } = a;
  const d = a.input.domain;

  // step 3: already in our account (crashed earlier run, or bought by hand)?
  let existing: DomainInfo | null;
  try {
    existing = await adapter.findDomain(d);
  } catch (e) {
    throw new AppError(409, 'REGISTRAR_STATE_UNKNOWN', 'Could not confirm the domain is not already in the account; not buying', {
      registrar: adapter.name, registrar_code: e instanceof RegistrarError ? e.code : 'UNKNOWN',
    });
  }
  if (existing) {
    await markRegisterSent(deps, purchaseId); // persisted first, so a crash from here is reconciled, not abandoned
    markSent(); // from here on, treat as money-relevant
    return finishFound(deps, a, purchaseId, existing, ['FOUND_IN_ACCOUNT: the domain was already in the registrar account; booked from its invoice']);
  }

  // step 4: persist register_sent BEFORE calling the registrar
  await markRegisterSent(deps, purchaseId);
  markSent();
  const key = `dt-${purchaseId}`;
  let sawAmbiguous = false;
  for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
    if (i > 0) await sleep(deps, RETRY_DELAYS_MS[i - 1]!);
    try {
      const r = await adapter.register(d, { costCents: a.cost, idempotencyKey: key, dryRun: false });
      if (r.kind !== 'registered') throw new RegistrarError(adapter.name, 'REGISTRAR_BAD_RESPONSE', 'not a registration', { ambiguous: true });
      // Deliberately NOT awaited: the registrar call succeeded, so an error thrown by a post-register step must
      // not be caught here (it would be treated as a failed attempt and trigger a second register). The promise
      // is returned to the caller's catch (purchase()), which maps any error to state=unknown / 202.
      return finishRegistered(deps, a, purchaseId, r);
    } catch (e) {
      if (!(e instanceof RegistrarError)) throw e; // → outer catch → unknown (202)
      if (!e.ambiguous && !sawAmbiguous) {
        return rejected(deps, a, purchaseId, 'REGISTRAR_REJECTED', `The registrar refused the registration (${e.code})`, {
          registrar: adapter.name, registrar_code: e.code,
        });
      }
      if (!e.ambiguous) break; // definite error after an earlier ambiguous attempt: resolve by looking, never assume
      sawAmbiguous = true;
    }
  }

  // step 5, ambiguous after retries: ask the registrar, then RDAP
  let info: DomainInfo | null | undefined;
  try {
    info = await adapter.findDomain(d);
  } catch {
    info = undefined;
  }
  if (info) return finishFound(deps, a, purchaseId, info, []);
  // Never release in-call (owner decision 5 Oct 2026): even "not found + RDAP 404" may be registrar lag. The reconciler fails it after 30 min.
  return unknown(deps, a, purchaseId);
}

/** created → register_sent, guarded: if the purchase was abandoned/failed meanwhile, nothing has been sent yet. */
async function markRegisterSent(deps: BuyDeps, purchaseId: number): Promise<void> {
  const r = await deps.db.updateTable('purchases').set({ state: 'register_sent', updated_at: new Date() })
    .where('id', '=', purchaseId).where('state', '=', 'created').executeTakeFirst();
  if (Number(r.numUpdatedRows) === 0) {
    throw new AppError(409, 'PURCHASE_ABANDONED', 'The purchase was abandoned before it reached the registrar; nothing was bought');
  }
}

/** Domain is in our account but we have no register result: book only from the registrar's invoice. */
async function finishFound(deps: BuyDeps, a: Approved, purchaseId: number, info: DomainInfo, warnings: string[]): Promise<BuyResult> {
  const since = idtDay(new Date(deps.now() - 2 * 86_400_000));
  const rec = await a.adapter.findRegistration(a.input.domain, { since }).catch(() => null);
  if (!rec) return unknown(deps, a, purchaseId);
  return complete(deps, a, purchaseId, {
    orderId: rec.orderId, chargedCents: rec.chargedCents, info,
    fallbackExpiry: rec.expiryDate, receiptRaw: rec.raw, buyDate: rec.invoiceDate,
  }, warnings);
}

async function finishRegistered(deps: BuyDeps, a: Approved, purchaseId: number, r: RegisterSuccess): Promise<BuyResult> {
  const info = await a.adapter.findDomain(a.input.domain).catch(() => null);
  let fallbackExpiry: string | null = null;
  if (!info?.expiryDate) {
    const rec = await a.adapter.findRegistration(a.input.domain, { since: idtDay(new Date(deps.now() - 86_400_000)) }).catch(() => null);
    fallbackExpiry = rec?.expiryDate ?? null;
  }
  const receiptRaw = await a.adapter.getReceipt(r.orderId).catch(() => null); // the reconciler fetches it later if missing
  const warnings = r.chargedCents > a.input.maxPriceCents ? [`CHARGE_ABOVE_MAX: charged ${formatUsd(r.chargedCents)} above max_price`] : [];
  return complete(deps, a, purchaseId, {
    orderId: r.orderId, chargedCents: r.chargedCents, info, fallbackExpiry, receiptRaw, buyDate: idtDay(new Date(deps.now())),
  }, warnings);
}

async function complete(deps: BuyDeps, 
  a: Approved, purchaseId: number,
  x: { orderId: string; chargedCents: number; info: DomainInfo | null; fallbackExpiry: string | null; receiptRaw: unknown; buyDate: string },
  warnings: string[],
): Promise<BuyResult> {
  const { db } = deps;
  let expiry = x.info?.expiryDate ?? x.fallbackExpiry;
  if (!expiry) {
    expiry = addOneYear(x.buyDate);
    warnings.push('EXPIRY_ESTIMATED: the registrar did not report an expiry; using buy date + 1 year until the reconciler or a report corrects it');
  }
  await bookPurchase(db, {
    purchaseId, domain: a.input.domain, registrar: a.adapter.name, registrarApi: registrarApiOf(a.adapter.capabilities),
    orderId: x.orderId, chargedCents: x.chargedCents, renewalCents: a.winner.renewalCents, expiryDate: expiry, buyDate: x.buyDate,
    category: a.category, dealId: a.input.dealId, checkId: a.check.checkId, auditId: a.ctx.auditId, receiptRaw: x.receiptRaw ?? null, now: new Date(deps.now()),
    // v3.9.0: the drop policy (CR-033 G-9, drop_date = the first expiry) is part of the booking transaction
    ...(a.dropPolicy === 'at_first_expiry' ? { dropDate: expiry } : {}),
  });
  deps.checkService.invalidate(a.input.domain);
  const dropDate = a.dropPolicy === 'at_first_expiry' ? expiry : addOneYear(expiry);

  // Everything after bookPurchase is best-effort: the purchase is booked and must be reported as 201.
  let post: { privacy: string; auto_renew: string; lander: string; listing: unknown } = { privacy: 'unknown', auto_renew: 'unconfirmed', lander: 'skipped', listing: null };
  try {
    post = await postBuy(deps, a, x.info, warnings);
  } catch (e) {
    deps.log?.error({ purchaseId, errMessage: (e as Error).message }, 'post-buy failed');
    warnings.push('POST_BUY_FAILED: the purchase is booked; post-buy steps did not finish — check privacy, auto-renew and NS');
  }
  // Everything below is non-throwing: the purchase is booked and must be reported as 201.
  const body: Record<string, unknown> = {
    domain: a.input.domain, registrar: a.adapter.name, order_id: x.orderId,
    charged: formatUsd(x.chargedCents), charged_cents: x.chargedCents,
    renewal: formatUsd(a.winner.renewalCents!), renewal_cents: a.winner.renewalCents,
    two_year: formatUsd(a.winner.twoYearCents!), two_year_cents: a.winner.twoYearCents,
    expiry_date: expiry, drop_date: dropDate, renewals_used: 0,
    display_name: a.displayName, ...policyFields(a.dropPolicy, a.winner.renewalCents),
    horizon: a.horizon, screening_group: a.screeningGroup, ...(a.math ? { renewal_math: a.math } : {}),
  };
  try {
    const owned = await db.selectFrom('domains').select(sql<number>`count(*)::int`.as('n'))
      .where('status', 'in', ['owned', 'listed', 'delisted']).executeTakeFirstOrThrow();
    Object.assign(body, {
      domains_owned: Number(owned.n),
    });
  } catch (e) {
    deps.log?.error({ purchaseId, errMessage: (e as Error).message }, 'post-buy totals failed');
    warnings.push('TOTALS_UNAVAILABLE: the purchase is booked; the domain count could not be computed');
  }
  warnings.push(...horizonWarnings(a));
  Object.assign(body, { post_buy: post, warnings, audit_id: a.ctx.auditId });
  const result = { status: 201, body };
  try {
    await storeResponse(db, purchaseId, result);
  } catch (e) {
    deps.log?.error({ purchaseId, errMessage: (e as Error).message }, 'storing the purchase response failed');
  }
  return result;
}
