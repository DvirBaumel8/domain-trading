import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { Category, Database } from '../db/types.js';
import { AppError, errorBody } from '../http/errors.js';
import { redact } from '../http/redact.js';
import { addOneYear, jerusalemDate } from '../dates.js';
import { formatUsd } from '../money.js';
import type { RdapFn } from '../rdap.js';
import { nsPendingWarning, RegistrarError, type AccountState, type DomainInfo, type RegisterSuccess, type RegistrarAdapter } from '../registrars/types.js';
import { checkApproval } from './approval.js';
import { changedColumns } from './export-state.js';
import { bookPurchase, failPurchase, markUnknown, registrarApiOf, storeResponse } from './bookkeeping.js';
import { landerNameservers, sameNsSet } from './lander.js';
import { activeDomainCount, spentAndPending, spentCents } from './budget.js';
import type { CheckResult, CheckService } from './check.js';
import { checkSettingsVersion, isCategory, validateComps, validateListing, type Comp, type ListingPlan, type ListingRequest } from './listing-v2.js';
import { planView } from './plan-view.js';
import { addMonthsClamped, buildSchedule } from '../pricing/schedule.js';
import { domainPlanColumns, historyRow, withDomainLock, writePlan } from './plan-store.js';
import { currentSettings, type PricingSettings } from '../pricing/settings.js';
import { screeningHold } from './buy-hold.js';
import { evaluateQuote, pickWinner, type EvaluatedQuote } from './selection.js';

export interface BuyInput {
  domain: string; maxPriceCents: number; maxTwoYearCents: number | null;
  approval: { text?: unknown; approved_at?: unknown } | null;
  dealId: string | null; category: string | null;
  priceGrade: 'strong' | 'weaker' | null; pricingEvidence: unknown; expectedSettingsVersion: number | null;
  proposedListing: ListingRequest | null; override: boolean; overrideReason: string | null;
  registrar: string | null; dryRun: boolean; autoList: boolean; requestBody: unknown;
}
export interface BuyCtx { idempotencyKey: string; requestHash: string; auditId: string }
export interface BuyResult { status: number; body: Record<string, unknown> }
export interface BuyDeps {
  db: Kysely<Database>; adapters: RegistrarAdapter[]; checkService: CheckService; rdap: RdapFn; now: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: { warn(o: object, m: string): void; error(o: object, m: string): void };
}
type Caps = { maxFirstYearCents: number; maxTwoYearCents?: number };

/** Everything the purchase phase needs once checks 1–10 passed. */
export interface Approved {
  input: BuyInput; ctx: BuyCtx; category: Category; plan: ListingPlan | null; comps: Comp[]; rationale: string | null; pricing: PricingSettings; approvedAt: Date;
  check: CheckResult; winner: EvaluatedQuote; cost: number; adapter: RegistrarAdapter; wouldBeBlocked: 'BUY_HOLD' | null;
  settings: { poc_cap_cents: number; max_domains: number; lander_target: string };
}

const priceDetails = (q: EvaluatedQuote) => ({
  registrar: q.registrar,
  first_year: formatUsd(q.firstYearCents!), first_year_cents: q.firstYearCents,
  two_year: formatUsd(q.twoYearCents!), two_year_cents: q.twoYearCents,
});

function funds(shortfallCents?: number | null): AppError {
  const known = typeof shortfallCents === 'number' && Number.isSafeInteger(shortfallCents) && shortfallCents > 0;
  return new AppError(409, 'REGISTRAR_FUNDS', 'Not enough prepaid credit at the registrar (no top-up is ever attempted)',
    known ? { shortfall_cents: shortfallCents, shortfall: formatUsd(shortfallCents) } : {});
}

const RETRY_DELAYS_MS = [2000, 5000, 10000];
const isUniqueViolation = (e: unknown) => (e as { code?: string }).code === '23505';

export class BuyService {
  constructor(protected readonly deps: BuyDeps) {}

  protected adapter(name: string): RegistrarAdapter {
    const a = this.deps.adapters.find((x) => x.name === name);
    if (!a) throw new AppError(409, 'NO_ELIGIBLE_REGISTRAR', `No adapter for ${name}`);
    return a;
  }

  async buy(input: BuyInput, ctx: BuyCtx): Promise<BuyResult> {
    const { db } = this.deps;
    const now = new Date(this.deps.now());
    const settings = await db.selectFrom('settings').selectAll().executeTakeFirstOrThrow();

    // B4: purchase-level replay (real buys only), before the approval check so a same-key retry
    // gets the stored outcome even if the approval has since expired
    if (!input.dryRun) {
      const prior = await this.priorOutcome(ctx, input.domain);
      if (prior) return prior;
    }

    // 3. approval
    const appr = checkApproval(input.approval, input.domain, now, settings.approval_max_age_hours);
    if (!appr.ok) throw new AppError(422, appr.code, appr.reason);

    // 3b. category + proposed listing (V1–V8), before any registrar call
    const pm = input.proposedListing?.mode;
    if (input.proposedListing && (typeof pm !== 'string' || !['bin', 'offer', 'hybrid'].includes(pm))) throw new AppError(422, 'MODE_INVALID', 'mode must be bin, offer or hybrid');
    if (!isCategory(input.category)) {
      throw new AppError(422, 'CATEGORY_REQUIRED', 'A valid category is required: geo, trend, b2b, collision, regulation, buzzword or other');
    }
    const category = input.category;
    if (category === 'geo' && !input.priceGrade) throw new AppError(422, 'GEO_GRADE_REQUIRED', 'Geo names need price_grade strong or weaker');
    if (category !== 'geo' && input.priceGrade) throw new AppError(422, 'GRADE_NOT_GEO', 'price_grade is only for geo names');
    const pricing = await currentSettings(db, now);
    const today = jerusalemDate(now);
    let plan: ListingPlan | null = null;
    if (input.proposedListing) {
      const r = validateListing(input.proposedListing, {
        category, grade: input.priceGrade, phase: 'buy', settings: pricing, highValueMinBinCents: settings.high_value_min_bin_cents,
        override: input.override, overrideReason: input.overrideReason, approvalValid: true,
        today, dropDate: addOneYear(addOneYear(today)), // registered today + 1 y; the drop is 1 y later
      });
      if (!r.ok) throw new AppError(r.status, r.code, r.message, r.details);
      plan = r.plan;
    }
    const ev = validateComps(input.pricingEvidence as { comps?: unknown; rationale?: unknown } | null, pricing, today);
    if (!ev.ok) throw new AppError(ev.status, ev.code, ev.message, ev.details);
    const ver = checkSettingsVersion(input.expectedSettingsVersion, pricing);
    if (ver) throw new AppError(ver.status, ver.code, ver.message, ver.details);

    // 3c. buy hold (v1.1.0, R1): only a name that was screened. A dry run reports it instead of refusing.
    const hold = await screeningHold(db, input.domain);
    if (hold && !input.dryRun) {
      throw new AppError(409, 'BUY_HOLD', `${input.domain} was screened under selection settings "${hold.settingsVersion}" while buy_hold is on (or the version is a backtest or no longer active); no real buy`,
        { settings_version: hold.settingsVersion, run_id: hold.runId });
    }

    // 4, 5
    await this.assertNotOwned(db, input.domain);
    await this.assertDomainCap(db, settings.max_domains);

    // 6. live re-check (no cache)
    const check = await this.deps.checkService.check(input.domain, { useCache: false });
    if (check.availability !== 'available') {
      throw new AppError(409, 'NOT_AVAILABLE', `${input.domain} is not available`, { availability: check.availability, rdap: check.rdap });
    }
    let candidates = check.quotes;
    if (input.registrar) {
      const pinned = check.quotes.find((q) => q.registrar === input.registrar);
      if (!pinned?.eligible) {
        throw new AppError(409, 'PINNED_REGISTRAR_INELIGIBLE', `${input.registrar} can't register this domain; not falling back`, {
          registrar: input.registrar, exclusion_reason: pinned?.exclusionReason ?? 'NO_ADAPTER',
        });
      }
      candidates = [pinned];
    } else if (!check.quotes.some((q) => q.eligible)) {
      throw new AppError(409, 'NO_ELIGIBLE_REGISTRAR', 'No registrar can register this domain', {
        quotes: check.quotes.map((q) => ({ registrar: q.registrar, exclusion_reason: q.exclusionReason })),
      });
    }

    // 7. price caps, then the cheapest two-year
    const caps: Caps = { maxFirstYearCents: input.maxPriceCents, ...(input.maxTwoYearCents !== null ? { maxTwoYearCents: input.maxTwoYearCents } : {}) };
    let winner = pickWinner(candidates, caps);
    if (!winner) {
      throw new AppError(409, 'PRICE_ABOVE_MAX', 'Every eligible price is above your cap', { cheapest: priceDetails(pickWinner(candidates)!) });
    }
    const adapter = this.adapter(winner.registrar);

    // 8. POC cap (unlocked here; re-checked under the global lock for real buys)
    await this.assertPocCap(db, settings.poc_cap_cents, winner.firstYearCents!);

    // 9. registrar account state
    await this.assertAccountState(adapter, winner.firstYearCents!);

    // 10. registrar dry run (re-quote once on COST_MISMATCH)
    const dry = await this.registrarDryRun(adapter, input.domain, winner, caps, settings.poc_cap_cents, settings.allowed_registrars,
      { input, ctx, approvedAt: appr.approvedAt, check, category });
    winner = dry.winner;

    const approved: Approved = {
      input, ctx, category, plan, comps: ev.comps, rationale: ev.rationale, pricing, approvedAt: appr.approvedAt, check, winner, cost: dry.cost, adapter, wouldBeBlocked: hold ? 'BUY_HOLD' : null,
      settings: { poc_cap_cents: settings.poc_cap_cents, max_domains: settings.max_domains, lander_target: settings.lander_target },
    };
    if (input.dryRun) return { status: 200, body: await this.dryRunBody(approved) };
    return this.purchase(approved);
  }

  private sleep(ms: number): Promise<void> {
    return (this.deps.sleep ?? ((t) => new Promise((r) => setTimeout(r, t))))(ms);
  }

  protected async priorOutcome(ctx: BuyCtx, domain: string): Promise<BuyResult | null> {
    const { db } = this.deps;
    const p = await db.selectFrom('purchases').select(['id', 'domain', 'state', 'response', 'audit_id', 'charged_cents', 'order_id'])
      .where('idempotency_key', '=', ctx.idempotencyKey).executeTakeFirst();
    if (!p) return null;
    if (p.domain !== domain) throw new AppError(409, 'IDEMPOTENCY_KEY_MISMATCH', 'This Idempotency-Key was used for a different domain');
    const r = p.response as { status: number; body: Record<string, unknown> } | null;
    if (p.state === 'succeeded') {
      if (r && r.status === 201) return { status: 201, body: r.body };
      return this.reconstructed(p);
    }
    if (r) return { status: r.status, body: r.body };
    return this.unknownBody(p.id, p.domain, p.audit_id ?? ctx.auditId);
  }

  /** A booked purchase is always reported as 201, even if its stored response is missing or stale (e.g. booked by the reconciler). */
  private async reconstructed(p: { domain: string; audit_id: string | null; charged_cents: number | null; order_id: string | null }): Promise<BuyResult> {
    const dom = await this.deps.db.selectFrom('domains').selectAll().where('domain', '=', p.domain).executeTakeFirst();
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

  private unknownBody(purchaseId: number, domain: string, auditId: string): BuyResult {
    return {
      status: 202,
      body: {
        status: 'unknown', code: 'PURCHASE_STATE_UNKNOWN', domain, purchase_id: purchaseId, audit_id: auditId,
        message: 'The registrar may or may not have registered the domain. The bookkeeping resolves on the next hourly reconciler run. Do not retry with a new Idempotency-Key.',
      },
    };
  }

  private async unknown(a: Approved, purchaseId: number): Promise<BuyResult> {
    const r = this.unknownBody(purchaseId, a.input.domain, a.ctx.auditId);
    await markUnknown(this.deps.db, purchaseId, r);
    return (await this.ifBooked(purchaseId)) ?? r;
  }

  /** A concurrent reconciler may have booked the purchase; if so report the booked 201, never a 409/202. */
  private async ifBooked(purchaseId: number): Promise<BuyResult | null> {
    const p = await this.deps.db.selectFrom('purchases').select(['domain', 'state', 'audit_id', 'charged_cents', 'order_id'])
      .where('id', '=', purchaseId).executeTakeFirst();
    return p?.state === 'succeeded' ? this.reconstructed(p) : null;
  }

  private async rejected(a: Approved, purchaseId: number, code: string, message: string, details: Record<string, unknown>): Promise<BuyResult> {
    const r = { status: 409, body: errorBody(code, message, details) as Record<string, unknown> };
    await failPurchase(this.deps.db, purchaseId, a.input.domain, r);
    return (await this.ifBooked(purchaseId)) ?? r;
  }

  /** Reservation: per-domain advisory lock + global settings lock; authoritative re-checks 4, 5, 8. */
  private async reserve(a: Approved): Promise<number> {
    const { db } = this.deps;
    try {
      return await db.transaction().execute(async (trx) => {
        await sql`select pg_advisory_xact_lock(hashtext(${a.input.domain}))`.execute(trx);
        const s = await trx.selectFrom('settings').select(['poc_cap_cents', 'max_domains']).forUpdate().executeTakeFirstOrThrow();
        await this.assertNotOwned(trx, a.input.domain);
        await this.assertDomainCap(trx, s.max_domains);
        await this.assertPocCap(trx, s.poc_cap_cents, a.cost);
        const { id } = await trx.insertInto('purchases').values({
          idempotency_key: a.ctx.idempotencyKey, request_hash: a.ctx.requestHash, domain: a.input.domain, state: 'created',
          dry_run: false, registrar: a.winner.registrar, check_id: a.check.checkId, max_price_cents: a.input.maxPriceCents,
          approval_text: String(a.input.approval?.text), approval_at: a.approvedAt, expected_cents: a.cost,
          request: JSON.stringify(redact(a.input.requestBody)), audit_id: a.ctx.auditId,
        }).returning('id').executeTakeFirstOrThrow();
        await trx.insertInto('domains').values({
          domain: a.input.domain, status: 'pending_purchase', registrar: a.winner.registrar, category: a.category, price_grade: a.input.priceGrade, deal_id: a.input.dealId,
        }).execute();
        return id;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError(409, 'ALREADY_OWNED_OR_PENDING', `${a.input.domain} is already owned or being bought`);
      throw e;
    }
  }

  protected async purchase(a: Approved): Promise<BuyResult> {
    const purchaseId = await this.reserve(a);
    let sent = false;
    try {
      return await this.execute(a, purchaseId, () => {
        sent = true;
      });
    } catch (e) {
      if (!sent) {
        // Nothing reached the registrar: release the reservation, surface the error.
        const status = e instanceof AppError ? e.status : 500;
        const body = e instanceof AppError ? errorBody(e.code, e.message, e.details) : errorBody('INTERNAL', 'Internal error');
        if (!(e instanceof AppError && e.code === 'PURCHASE_ABANDONED')) {
          await failPurchase(this.deps.db, purchaseId, a.input.domain, { status, body }, { fromStates: ['created'] });
        }
        throw e;
      }
      // After register_sent: NEVER 5xx (the money invariant).
      this.deps.log?.error({ purchaseId, errMessage: (e as Error).message }, 'purchase error after register_sent');
      try {
        return await this.unknown(a, purchaseId);
      } catch {
        return this.unknownBody(purchaseId, a.input.domain, a.ctx.auditId);
      }
    }
  }

  private async execute(a: Approved, purchaseId: number, markSent: () => void): Promise<BuyResult> {
    const { db } = this.deps;
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
      await this.markRegisterSent(purchaseId); // persisted first, so a crash from here is reconciled, not abandoned
      markSent(); // from here on, treat as money-relevant
      return this.finishFound(a, purchaseId, existing, ['FOUND_IN_ACCOUNT: the domain was already in the registrar account; booked from its invoice']);
    }

    // step 4: persist register_sent BEFORE calling the registrar
    await this.markRegisterSent(purchaseId);
    markSent();
    const key = `dt-${purchaseId}`;
    let lastErr: RegistrarError | null = null;
    let sawAmbiguous = false;
    for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
      if (i > 0) await this.sleep(RETRY_DELAYS_MS[i - 1]!);
      try {
        const r = await adapter.register(d, { costCents: a.cost, idempotencyKey: key, dryRun: false });
        if (r.kind !== 'registered') throw new RegistrarError(adapter.name, 'REGISTRAR_BAD_RESPONSE', 'not a registration', { ambiguous: true });
        // Deliberately NOT awaited: the registrar call succeeded, so an error thrown by a post-register step must
        // not be caught here (it would be treated as a failed attempt and trigger a second register). The promise
        // is returned to the caller's catch (purchase()), which maps any error to state=unknown / 202.
        return this.finishRegistered(a, purchaseId, r);
      } catch (e) {
        if (!(e instanceof RegistrarError)) throw e; // → outer catch → unknown (202)
        if (!e.ambiguous && !sawAmbiguous) {
          return this.rejected(a, purchaseId, 'REGISTRAR_REJECTED', `The registrar refused the registration (${e.code})`, {
            registrar: adapter.name, registrar_code: e.code,
          });
        }
        lastErr = e;
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
    if (info) return this.finishFound(a, purchaseId, info, []);
    // Never release in-call (owner decision 5 Oct 2026): even "not found + RDAP 404" may be registrar lag. The reconciler fails it after 30 min.
    return this.unknown(a, purchaseId);
  }

  /** created → register_sent, guarded: if the purchase was abandoned/failed meanwhile, nothing has been sent yet. */
  private async markRegisterSent(purchaseId: number): Promise<void> {
    const r = await this.deps.db.updateTable('purchases').set({ state: 'register_sent', updated_at: new Date() })
      .where('id', '=', purchaseId).where('state', '=', 'created').executeTakeFirst();
    if (Number(r.numUpdatedRows) === 0) {
      throw new AppError(409, 'PURCHASE_ABANDONED', 'The purchase was abandoned before it reached the registrar; nothing was bought');
    }
  }

  /** Domain is in our account but we have no register result: book only from the registrar's invoice. */
  private async finishFound(a: Approved, purchaseId: number, info: DomainInfo, warnings: string[]): Promise<BuyResult> {
    const since = jerusalemDate(new Date(this.deps.now() - 2 * 86_400_000));
    const rec = await a.adapter.findRegistration(a.input.domain, { since }).catch(() => null);
    if (!rec) return this.unknown(a, purchaseId);
    return this.complete(a, purchaseId, {
      orderId: rec.orderId, chargedCents: rec.chargedCents, info,
      fallbackExpiry: rec.expiryDate, receiptRaw: rec.raw, buyDate: rec.invoiceDate,
    }, warnings);
  }

  private async finishRegistered(a: Approved, purchaseId: number, r: RegisterSuccess): Promise<BuyResult> {
    const info = await a.adapter.findDomain(a.input.domain).catch(() => null);
    let fallbackExpiry: string | null = null;
    if (!info?.expiryDate) {
      const rec = await a.adapter.findRegistration(a.input.domain, { since: jerusalemDate(new Date(this.deps.now() - 86_400_000)) }).catch(() => null);
      fallbackExpiry = rec?.expiryDate ?? null;
    }
    const receiptRaw = await a.adapter.getReceipt(r.orderId).catch(() => null); // the reconciler fetches it later if missing
    const warnings = r.chargedCents > a.input.maxPriceCents ? [`CHARGE_ABOVE_MAX: charged ${formatUsd(r.chargedCents)} above max_price`] : [];
    return this.complete(a, purchaseId, {
      orderId: r.orderId, chargedCents: r.chargedCents, info, fallbackExpiry, receiptRaw, buyDate: jerusalemDate(new Date(this.deps.now())),
    }, warnings);
  }

  private async complete(
    a: Approved, purchaseId: number,
    x: { orderId: string; chargedCents: number; info: DomainInfo | null; fallbackExpiry: string | null; receiptRaw: unknown; buyDate: string },
    warnings: string[],
  ): Promise<BuyResult> {
    const { db } = this.deps;
    let expiry = x.info?.expiryDate ?? x.fallbackExpiry;
    if (!expiry) {
      expiry = addOneYear(x.buyDate);
      warnings.push('EXPIRY_ESTIMATED: the registrar did not report an expiry; using buy date + 1 year until the reconciler or a report corrects it');
    }
    await bookPurchase(db, {
      purchaseId, domain: a.input.domain, registrar: a.adapter.name, registrarApi: registrarApiOf(a.adapter.capabilities),
      orderId: x.orderId, chargedCents: x.chargedCents, renewalCents: a.winner.renewalCents, expiryDate: expiry, buyDate: x.buyDate,
      category: a.category, dealId: a.input.dealId, checkId: a.check.checkId, auditId: a.ctx.auditId, receiptRaw: x.receiptRaw ?? null,
    });
    this.deps.checkService.invalidate(a.input.domain);

    // Everything after bookPurchase is best-effort: the purchase is booked and must be reported as 201.
    let post: { privacy: string; auto_renew: string; lander: string; listing: unknown } = { privacy: 'unknown', auto_renew: 'unconfirmed', lander: 'skipped', listing: null };
    try {
      post = await this.postBuy(a, x.info, warnings);
    } catch (e) {
      this.deps.log?.error({ purchaseId, errMessage: (e as Error).message }, 'post-buy failed');
      warnings.push('POST_BUY_FAILED: the purchase is booked; post-buy steps did not finish — check privacy, auto-renew and NS');
    }
    // Everything below is non-throwing: the purchase is booked and must be reported as 201.
    const body: Record<string, unknown> = {
      domain: a.input.domain, registrar: a.adapter.name, order_id: x.orderId,
      charged: formatUsd(x.chargedCents), charged_cents: x.chargedCents,
      renewal: formatUsd(a.winner.renewalCents!), renewal_cents: a.winner.renewalCents,
      two_year: formatUsd(a.winner.twoYearCents!), two_year_cents: a.winner.twoYearCents,
      expiry_date: expiry, drop_date: addOneYear(expiry), renewals_used: 0,
    };
    try {
      const spent = await spentCents(db);
      const owned = await db.selectFrom('domains').select(sql<number>`count(*)::int`.as('n'))
        .where('status', 'in', ['owned', 'listed', 'delisted']).executeTakeFirstOrThrow();
      Object.assign(body, {
        poc_spent_after: formatUsd(spent), poc_spent_after_cents: spent,
        poc_remaining: formatUsd(a.settings.poc_cap_cents - spent), poc_remaining_cents: a.settings.poc_cap_cents - spent,
        domains_owned: Number(owned.n),
      });
    } catch (e) {
      this.deps.log?.error({ purchaseId, errMessage: (e as Error).message }, 'post-buy totals failed');
      warnings.push('TOTALS_UNAVAILABLE: the purchase is booked; budget totals could not be computed');
    }
    Object.assign(body, { post_buy: post, warnings, audit_id: a.ctx.auditId });
    const result = { status: 201, body };
    try {
      await storeResponse(db, purchaseId, result);
    } catch (e) {
      this.deps.log?.error({ purchaseId, errMessage: (e as Error).message }, 'storing the purchase response failed');
    }
    return result;
  }

  /** buy.md step 7: each failure is a warning; nothing here undoes the purchase. */
  private async postBuy(a: Approved, info: DomainInfo | null, warnings: string[]) {
    const { db } = this.deps;
    const d = a.input.domain;
    const hint = (e: unknown, what: string) =>
      e instanceof RegistrarError && e.code === 'API_ACCESS_DISABLED'
        ? 'API_ACCESS_DISABLED: turn on "Opt In All Domains" at porkbun.com/account/api, then call /list again'
        : `${what}: ${e instanceof RegistrarError ? e.code : 'error'}`;
    const post: { privacy: string; auto_renew: string; lander: string; listing: unknown } = {
      privacy: 'unknown', auto_renew: 'unconfirmed', lander: 'skipped', listing: null,
    };

    // 7.0 pricing evidence (first: nothing below may keep it from being saved) (the comps behind this buy); a failure is a warning, never an undo
    try {
      await db.insertInto('pricing_evidence').values({
        domain_id: (await db.selectFrom('domains').select('id').where('domain', '=', d).executeTakeFirstOrThrow()).id,
        comps: JSON.stringify(a.comps), rationale: a.rationale, audit_id: a.ctx.auditId,
      }).execute();
    } catch (e) {
      this.deps.log?.error({ errMessage: (e as Error).message }, 'post-buy evidence save failed');
      warnings.push('EVIDENCE_SAVE_FAILED: the purchase is booked but the comps were not saved; record them with a pricing note');
    }

    // 7.1 privacy
    if (info?.whoisPrivacy === true) post.privacy = 'on';
    else if (info?.whoisPrivacy === false) {
      post.privacy = 'off';
      warnings.push('PRIVACY_OFF: WHOIS privacy is off and Porkbun has no API to turn it on after registration; turn it on in the Porkbun dashboard');
    } else warnings.push('PRIVACY_UNKNOWN: could not confirm WHOIS privacy; check the registrar dashboard');

    // 7.2 auto-renew off, then verify
    try {
      await a.adapter.setAutoRenew(d, false);
      const after = await a.adapter.findDomain(d);
      if (after?.autoRenew === false) post.auto_renew = 'off';
      else warnings.push('AUTO_RENEW_NOT_CONFIRMED: auto-renew may still be on; turn it off in the registrar dashboard');
    } catch (e) {
      warnings.push(hint(e, 'AUTO_RENEW_FAILED'));
    }

    // 7.3 auto_list
    if (a.input.autoList) {
      const target = a.settings.lander_target;
      const ns = landerNameservers(target);
      if (!ns) warnings.push('LANDER_CUSTOM: lander_target is custom; call /list with explicit nameservers');
      else {
        try {
          const nsRes = await a.adapter.setNameservers(d, [...ns]);
          const got = nsRes && nsRes.pending ? null : await a.adapter.getNameservers(d);
          if (got === null) {
            post.lander = 'pending';
            warnings.push(nsPendingWarning(a.adapter.name));
            await this.saveLander(d, target, ns);
          } else if (sameNsSet(got, ns)) {
            post.lander = `${target} ns set`;
            await this.saveLander(d, target, ns);
          } else {
            post.lander = 'mismatch';
            warnings.push('LANDER_MISMATCH: the registrar reports different nameservers; call /list again');
          }
        } catch (e) {
          post.lander = 'failed';
          warnings.push(hint(e, 'LANDER_FAILED'));
        }
      }
      if (a.plan) await this.saveListing(a, a.plan, post, warnings);
    }
    return post;
  }

  /** The lander columns, written under the per-domain lock so a concurrent /list can't be overwritten. */
  private async saveLander(d: string, target: string, ns: readonly string[]): Promise<void> {
    await withDomainLock(this.deps.db, d, async (conn) => {
      const at = new Date();
      await conn.updateTable('domains').set({ lander: target, lander_ns: [...ns], lander_set_at: at, updated_at: at })
        .where('domain', '=', d).execute();
    });
  }

  /** Plan + schedule + history under the per-domain lock. Runs after the reservation and bookkeeping transactions committed, so it can't deadlock with /buy's xact lock. */
  private async saveListing(a: Approved, plan: ListingPlan, post: { listing: unknown }, warnings: string[]): Promise<void> {
    const d = a.input.domain;
    const now = new Date(this.deps.now());
    warnings.push(...plan.warnings);
    try {
      const events = await withDomainLock(this.deps.db, d, (conn) => conn.transaction().execute(async (trx) => {
        const row = await trx.selectFrom('domains').selectAll().where('domain', '=', d).forUpdate().executeTakeFirstOrThrow();
        if (row.status !== 'owned' || !row.drop_date) throw new Error(`domain is ${row.status}, not owned`);
        await trx.updateTable('domains').set({
          ...domainPlanColumns(plan), status: 'listed', category: a.category, price_grade: plan.grade,
          first_listed_at: now, ...changedColumns(row, now), updated_at: now,
        }).where('id', '=', row.id).execute();
        await trx.insertInto('listing_history').values(historyRow({
          domainId: row.id, source: 'buy', plan, category: a.category, grade: plan.grade, lander: a.settings.lander_target,
          override: plan.overrideUsed, overrideReason: plan.overrideUsed ? a.input.overrideReason : null,
          approvalText: String(a.input.approval?.text), approvalAt: a.approvedAt, auditId: a.ctx.auditId, planAuditId: a.ctx.auditId, at: now,
        })).execute();
        return (await writePlan(trx, {
          domainId: row.id, plan, anchor: jerusalemDate(now), dropDate: row.drop_date, settings: a.pricing, planAuditId: a.ctx.auditId, now,
        })).events;
      }));
      post.listing = planView(plan, events);
    } catch (e) {
      // Post-buy never undoes or masks a booked purchase (controller ruling, step 3 Task 2 review).
      this.deps.log?.error({ errMessage: (e as Error).message }, 'post-buy listing save failed');
      warnings.push('LISTING_SAVE_FAILED: the purchase is booked but the proposed listing was not saved; call /list');
    }
  }

  protected async assertNotOwned(db: Kysely<Database>, domain: string): Promise<void> {
    const row = await db.selectFrom('domains').select('status').where('domain', '=', domain).executeTakeFirst();
    if (row && ['pending_purchase', 'owned', 'listed', 'delisted'].includes(row.status)) {
      throw new AppError(409, 'ALREADY_OWNED_OR_PENDING', `${domain} is already owned or being bought`, { status: row.status });
    }
    if (row) throw new AppError(409, 'ALREADY_IN_PORTFOLIO', `${domain} is in the portfolio as ${row.status}`, { status: row.status });
    const open = await db.selectFrom('purchases').select('state').where('domain', '=', domain)
      .where('state', 'in', ['created', 'register_sent', 'unknown']).executeTakeFirst();
    if (open) throw new AppError(409, 'ALREADY_OWNED_OR_PENDING', `A purchase of ${domain} is in progress`, { state: open.state });
  }

  protected async assertDomainCap(db: Kysely<Database>, maxDomains: number): Promise<void> {
    const n = await activeDomainCount(db);
    if (n >= maxDomains) throw new AppError(409, 'DOMAIN_CAP_REACHED', `Domain cap reached (${n}/${maxDomains})`, { domains: n, max_domains: maxDomains });
  }

  protected async assertPocCap(db: Kysely<Database>, capCents: number, costCents: number): Promise<void> {
    const { spent, pending } = await spentAndPending(db);
    const remaining = capCents - spent - pending;
    if (costCents > remaining) {
      throw new AppError(409, 'POC_CAP_EXCEEDED', `This purchase would exceed the ${formatUsd(capCents)} POC cap`, {
        cap_cents: capCents, spent_cents: spent, spent: formatUsd(spent), pending_cents: pending,
        remaining_cents: remaining, remaining: formatUsd(remaining), cost_cents: costCents,
      });
    }
  }

  private async assertAccountState(adapter: RegistrarAdapter, cost: number): Promise<void> {
    let st: AccountState;
    try {
      st = await adapter.accountState();
    } catch (e) {
      throw new AppError(409, 'REGISTRAR_STATE_UNKNOWN', 'Could not read the registrar account state; not buying', {
        registrar: adapter.name, registrar_code: e instanceof RegistrarError ? e.code : 'UNKNOWN',
      });
    }
    if (st.autoTopupEnabled === true) {
      throw new AppError(409, 'REGISTRAR_AUTO_TOPUP_ON',
        'Auto top-up is on at the registrar, so the prepaid balance is not a spending limit. Turn it off (porkbun.com/account/api) and retry.',
        { registrar: adapter.name });
    }
    if (st.balanceCents !== null && st.balanceCents < cost) throw funds(cost - st.balanceCents);
    if (st.spendLimitRemainingCents !== null && st.spendLimitRemainingCents < cost) {
      throw new AppError(409, 'REGISTRAR_FUNDS', "The registrar's monthly API spend limit would be exceeded", {
        reason: 'MONTHLY_SPEND_LIMIT', remaining_cents: st.spendLimitRemainingCents,
      });
    }
  }

  private async registrarDryRun(
    adapter: RegistrarAdapter, domain: string, winner: EvaluatedQuote, caps: Caps, pocCap: number, allowed: string[],
    rec: { input: BuyInput; ctx: BuyCtx; approvedAt: Date; check: CheckResult; category: Category },
  ): Promise<{ winner: EvaluatedQuote; cost: number }> {
    let w = winner;
    for (let attempt = 0; attempt < 2; attempt++) {
      const cost = w.firstYearCents!;
      try {
        const r = await adapter.register(domain, { costCents: cost, idempotencyKey: `dtdry-${randomUUID()}`, dryRun: true });
        if (r.kind !== 'dry_run') throw new AppError(409, 'REGISTRAR_DRY_RUN_FAILED', 'Registrar did not answer as a dry run', { registrar: adapter.name });
        if (!r.wouldSucceed) {
          if (r.shortfallCents) throw funds(r.shortfallCents);
          if (r.withinMonthlySpendLimit === false) {
            throw new AppError(409, 'REGISTRAR_FUNDS', "The registrar's monthly API spend limit would be exceeded", { reason: 'MONTHLY_SPEND_LIMIT' });
          }
          throw new AppError(409, 'REGISTRAR_DRY_RUN_FAILED', 'The registrar dry run says this would not succeed', { registrar: adapter.name });
        }
        if (r.costCents !== cost) {
          throw new AppError(409, 'REGISTRAR_DRY_RUN_FAILED', 'The registrar dry-run cost differs from the quote', { registrar: adapter.name, cost_cents: r.costCents });
        }
        return { winner: w, cost };
      } catch (e) {
        if (!(e instanceof RegistrarError)) throw e;
        if (e.ambiguous) await this.recordDryRunAmbiguous(adapter, e, cost, rec);
        if (e.code === 'COST_MISMATCH' && attempt === 0) {
          w = await this.requote(adapter, domain, caps, pocCap, allowed);
          continue;
        }
        if (e.code === 'INSUFFICIENT_FUNDS') throw funds(e.details.shortfall as number | undefined);
        if (e.code === 'MONTHLY_SPEND_LIMIT_EXCEEDED') {
          throw new AppError(409, 'REGISTRAR_FUNDS', "The registrar's monthly API spend limit would be exceeded", { reason: 'MONTHLY_SPEND_LIMIT' });
        }
        throw new AppError(409, 'REGISTRAR_DRY_RUN_FAILED', `Registrar dry run failed (${e.code})`, { registrar: adapter.name, registrar_code: e.code });
      }
    }
    throw new AppError(409, 'REGISTRAR_DRY_RUN_FAILED', 'The registrar price kept changing', { registrar: adapter.name });
  }

  /** An ambiguous dry run may have been a real registration: record an `unknown` purchase so the cap counts it and the reconciler resolves it. */
  private async recordDryRunAmbiguous(
    adapter: RegistrarAdapter, e: RegistrarError, cost: number, rec: { input: BuyInput; ctx: BuyCtx; approvedAt: Date; check: CheckResult; category: Category },
  ): Promise<never> {
    this.deps.log?.error({ domain: rec.input.domain, registrar: adapter.name, registrar_code: e.code }, 'dry run ambiguous — possible real charge');
    try {
      // The pending domains row makes the domain cap count this possible purchase; both rows or neither.
      await this.deps.db.transaction().execute(async (trx) => {
        await sql`select pg_advisory_xact_lock(hashtext(${rec.input.domain}))`.execute(trx);
        await trx.insertInto('purchases').values({
          idempotency_key: `${rec.ctx.idempotencyKey}#dry-ambiguous-${randomUUID()}`, request_hash: rec.ctx.requestHash, domain: rec.input.domain,
          state: 'unknown', dry_run: false, registrar: adapter.name, check_id: rec.check.checkId, max_price_cents: rec.input.maxPriceCents,
          approval_text: String(rec.input.approval?.text), approval_at: rec.approvedAt, expected_cents: cost,
          request: JSON.stringify(redact(rec.input.requestBody)), audit_id: rec.ctx.auditId,
        }).execute();
        await trx.insertInto('domains').values({
          domain: rec.input.domain, status: 'pending_purchase', registrar: adapter.name, category: rec.category, price_grade: rec.input.priceGrade, deal_id: rec.input.dealId,
        }).execute();
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // another purchase already holds the domain: it is tracked there; still answer 409, never 500
      this.deps.log?.error({ domain: rec.input.domain }, 'dry-ambiguous record hit a unique violation; another purchase holds the domain');
    }
    throw new AppError(409, 'REGISTRAR_DRY_RUN_AMBIGUOUS',
      'The registrar dry run gave an ambiguous answer; a real charge may have happened. Check the registrar account; the reconciler will book it if it was registered.',
      { registrar: adapter.name, registrar_code: e.code });
  }

  private async requote(adapter: RegistrarAdapter, domain: string, caps: Caps, pocCap: number, allowed: string[]): Promise<EvaluatedQuote> {
    let ev: EvaluatedQuote;
    try {
      ev = evaluateQuote({ registrar: adapter.name, capabilities: adapter.capabilities, quote: await adapter.quote(domain), error: null }, allowed);
    } catch (e) {
      throw new AppError(409, 'REGISTRAR_DRY_RUN_FAILED', 'Re-quote after a price change failed', {
        registrar: adapter.name, registrar_code: e instanceof RegistrarError ? e.code : 'UNKNOWN',
      });
    }
    if (!ev.eligible) throw new AppError(409, 'NO_ELIGIBLE_REGISTRAR', 'After a price change the registrar is no longer eligible', { exclusion_reason: ev.exclusionReason });
    if (!pickWinner([ev], caps)) throw new AppError(409, 'PRICE_ABOVE_MAX', 'The price changed and is now above your cap', { cheapest: priceDetails(ev) });
    await this.assertPocCap(this.deps.db, pocCap, ev.firstYearCents!);
    await this.assertAccountState(adapter, ev.firstYearCents!);
    return ev;
  }

  private async dryRunBody(a: Approved): Promise<Record<string, unknown>> {
    const { spent, pending } = await spentAndPending(this.deps.db);
    const w = a.winner;
    // Same default as GET /pricing/preview with no domain: anchor today (Jerusalem), drop date 24 months later
    const anchor = jerusalemDate(new Date(this.deps.now()));
    const events = a.plan ? buildSchedule({ plan: a.plan, anchor, dropDate: addMonthsClamped(anchor, 24), settings: a.pricing }) : [];
    return {
      dry_run: true, domain: a.input.domain, check_id: a.check.checkId, registrar: w.registrar,
      first_year: formatUsd(w.firstYearCents!), first_year_cents: w.firstYearCents,
      renewal: formatUsd(w.renewalCents!), renewal_cents: w.renewalCents,
      two_year: formatUsd(w.twoYearCents!), two_year_cents: w.twoYearCents,
      poc_spent: formatUsd(spent), poc_spent_cents: spent,
      poc_remaining_after: formatUsd(a.settings.poc_cap_cents - spent - pending - a.cost),
      poc_remaining_after_cents: a.settings.poc_cap_cents - spent - pending - a.cost,
      domains_owned: await activeDomainCount(this.deps.db),
      registrar_dry_run: { would_succeed: true, cost: formatUsd(a.cost), cost_cents: a.cost },
      proposed_listing: a.plan ? planView(a.plan, events) : null, settings_version: a.pricing.version,
      ...(a.wouldBeBlocked && { would_be_blocked: a.wouldBeBlocked }),
      warnings: [...a.check.warnings, ...(a.plan?.warnings ?? [])],
    };
  }
}
