import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Category, Database } from '../db/types.js';
import { AppError } from '../http/errors.js';
import { formatUsd } from '../money.js';
import type { RdapFn } from '../rdap.js';
import { RegistrarError, type AccountState, type RegistrarAdapter } from '../registrars/types.js';
import { checkApproval } from './approval.js';
import { activeDomainCount, pendingCents, spentCents } from './budget.js';
import type { CheckResult, CheckService } from './check.js';
import { isCategory, listingSettings, presentListing, validateListing, type ListingInput, type ListingResult } from './listing-rules.js';
import { evaluateQuote, pickWinner, type EvaluatedQuote } from './selection.js';

export interface BuyInput {
  domain: string; maxPriceCents: number; maxTwoYearCents: number | null;
  approval: { text?: unknown; approved_at?: unknown } | null;
  dealId: string | null; category: string | null;
  proposedListing: ListingInput | null; override: boolean; overrideReason: string | null;
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
type OkListing = Extract<ListingResult, { ok: true }>;

/** Everything the purchase phase needs once checks 1–10 passed. */
export interface Approved {
  input: BuyInput; ctx: BuyCtx; category: Category; listing: OkListing | null; approvedAt: Date;
  check: CheckResult; winner: EvaluatedQuote; cost: number; adapter: RegistrarAdapter;
  settings: { poc_cap_cents: number; max_domains: number; lander_target: string };
}

const priceDetails = (q: EvaluatedQuote) => ({
  registrar: q.registrar,
  first_year: formatUsd(q.firstYearCents!), first_year_cents: q.firstYearCents,
  two_year: formatUsd(q.twoYearCents!), two_year_cents: q.twoYearCents,
});

function funds(shortfallCents: number): AppError {
  return new AppError(409, 'REGISTRAR_FUNDS', 'Not enough prepaid credit at the registrar (no top-up is ever attempted)', {
    shortfall_cents: shortfallCents, shortfall: formatUsd(shortfallCents),
  });
}

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

    // 3. approval
    const appr = checkApproval(input.approval, input.domain, now, settings.approval_max_age_hours);
    if (!appr.ok) throw new AppError(422, appr.code, appr.reason);

    // 3b. category + proposed listing (V1–V8), before any registrar call
    if (!isCategory(input.category)) {
      throw new AppError(422, 'CATEGORY_REQUIRED', 'A valid category is required: geo, trend, b2b, collision, regulation, buzzword or other');
    }
    const category = input.category;
    let listing: OkListing | null = null;
    if (input.proposedListing) {
      const r = validateListing(input.proposedListing, {
        category, settings: listingSettings(settings), override: input.override, overrideReason: input.overrideReason, approvalValid: true,
      });
      if (!r.ok) throw new AppError(422, r.code, r.message);
      listing = r;
    }

    // B4: purchase-level replay (real buys only)
    if (!input.dryRun) {
      const prior = await this.priorOutcome(ctx);
      if (prior) return prior;
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
    const dry = await this.registrarDryRun(adapter, input.domain, winner, caps, settings.poc_cap_cents, settings.allowed_registrars);
    winner = dry.winner;

    const approved: Approved = {
      input, ctx, category, listing, approvedAt: appr.approvedAt, check, winner, cost: dry.cost, adapter,
      settings: { poc_cap_cents: settings.poc_cap_cents, max_domains: settings.max_domains, lander_target: settings.lander_target },
    };
    if (input.dryRun) return { status: 200, body: await this.dryRunBody(approved) };
    return this.purchase(approved);
  }

  /** Implemented in Task 5. */
  protected async purchase(_a: Approved): Promise<BuyResult> {
    throw new AppError(501, 'NOT_IMPLEMENTED', 'Real purchases arrive in Task 5');
  }

  /** Implemented in Task 5 (returns null until then). */
  protected async priorOutcome(_ctx: BuyCtx): Promise<BuyResult | null> {
    return null;
  }

  protected async assertNotOwned(db: Kysely<Database>, domain: string): Promise<void> {
    const row = await db.selectFrom('domains').select('status').where('domain', '=', domain).executeTakeFirst();
    if (row && ['pending_purchase', 'owned', 'listed'].includes(row.status)) {
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
    const [spent, pending] = await Promise.all([spentCents(db), pendingCents(db)]);
    const remaining = capCents - spent - pending;
    if (costCents > remaining) {
      throw new AppError(409, 'POC_CAP_EXCEEDED', 'This purchase would exceed the $500 POC cap', {
        spent_cents: spent, spent: formatUsd(spent), pending_cents: pending,
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
        if (e.code === 'COST_MISMATCH' && attempt === 0) {
          w = await this.requote(adapter, domain, caps, pocCap, allowed);
          continue;
        }
        if (e.code === 'INSUFFICIENT_FUNDS') throw funds(Number.isSafeInteger(e.details.shortfall) ? (e.details.shortfall as number) : 0);
        if (e.code === 'MONTHLY_SPEND_LIMIT_EXCEEDED') {
          throw new AppError(409, 'REGISTRAR_FUNDS', "The registrar's monthly API spend limit would be exceeded", { reason: 'MONTHLY_SPEND_LIMIT' });
        }
        throw new AppError(409, 'REGISTRAR_DRY_RUN_FAILED', `Registrar dry run failed (${e.code})`, { registrar: adapter.name, registrar_code: e.code });
      }
    }
    throw new AppError(409, 'REGISTRAR_DRY_RUN_FAILED', 'The registrar price kept changing', { registrar: adapter.name });
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
    return ev;
  }

  private async dryRunBody(a: Approved): Promise<Record<string, unknown>> {
    const spent = await spentCents(this.deps.db);
    const pending = await pendingCents(this.deps.db);
    const w = a.winner;
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
      proposed_listing: a.listing ? presentListing(a.listing.listing) : null,
      warnings: [...a.check.warnings, ...(a.listing?.warnings ?? [])],
    };
  }
}
