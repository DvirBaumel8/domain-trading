// The registrar and gate side of a /buy that never spends: account state, the registrar dry run (re-quote once on COST_MISMATCH), the ambiguity record,
// and the body of a `dry_run` answer.
import { randomUUID } from 'node:crypto';
import { advisoryXactLock } from '../../core/locks.js';
import { AppError } from '../../http/errors.js';
import { addMonthsClamped, idtDay } from '../../core/dates.js';
import { formatUsd } from '../../core/money.js';
import { RegistrarError, evaluateQuote, pickWinner, type AccountState, type EvaluatedQuote, type RegistrarAdapter } from '../registrars/index.js';
import { latestPackFor } from '../selection/index.js';
import { buildSchedule, planView } from '../listing/index.js';
import { activeDomainCount } from './caps.js';
import type { latestScreeningRun } from './buy-hold.js';
import type { BuyBlock } from './buy-gates.js';
import { reservePending, isUniqueViolation, type PendingRec } from './buy-reserve.js';
import { horizonWarnings, policyFields, withPolicyLine, type Approved, type BuyDeps } from './buy-types.js';

export type Caps = { maxFirstYearCents: number; maxTwoYearCents?: number };

export const priceDetails = (q: EvaluatedQuote) => ({
  registrar: q.registrar,
  first_year: formatUsd(q.firstYearCents!), first_year_cents: q.firstYearCents,
  two_year: formatUsd(q.twoYearCents!), two_year_cents: q.twoYearCents,
});

function funds(shortfallCents?: number | null): AppError {
  const known = typeof shortfallCents === 'number' && Number.isSafeInteger(shortfallCents) && shortfallCents > 0;
  return new AppError(409, 'REGISTRAR_FUNDS', 'Not enough prepaid credit at the registrar (no top-up is ever attempted)',
    known ? { shortfall_cents: shortfallCents, shortfall: formatUsd(shortfallCents) } : {});
}

export async function assertAccountState(adapter: RegistrarAdapter, cost: number, dryRun: boolean): Promise<string[]> {
  const warnings: string[] = [];
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
  if (st.autoTopupEnabled === null) {
    // Founder rule 6: an unknown auto top-up setting could mean the prepaid balance is not a limit. A real buy refuses; a dry run reports it.
    const msg = 'The registrar did not report whether auto top-up is on; a real buy would be refused until it is known to be off';
    if (!dryRun) throw new AppError(409, 'REGISTRAR_STATE_UNKNOWN', msg, { registrar: adapter.name, registrar_code: 'AUTO_TOPUP_UNKNOWN' });
    warnings.push(`AUTO_TOPUP_UNKNOWN: ${msg}`);
  }
  if (st.balanceCents !== null && st.balanceCents < cost) throw funds(cost - st.balanceCents);
  if (st.spendLimitRemainingCents !== null && st.spendLimitRemainingCents < cost) {
    throw new AppError(409, 'REGISTRAR_FUNDS', "The registrar's monthly API spend limit would be exceeded", {
      reason: 'MONTHLY_SPEND_LIMIT', remaining_cents: st.spendLimitRemainingCents,
    });
  }
  return warnings;
}

export async function registrarDryRun(deps: BuyDeps, 
  adapter: RegistrarAdapter, domain: string, winner: EvaluatedQuote, caps: Caps, allowed: string[],
  rec: PendingRec,
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
      if (e.ambiguous) await recordDryRunAmbiguous(deps, adapter, e, cost, rec);
      if (e.code === 'COST_MISMATCH' && attempt === 0) {
        w = await requote(adapter, domain, caps, allowed, rec.input.dryRun);
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
async function recordDryRunAmbiguous(deps: BuyDeps, 
  adapter: RegistrarAdapter, e: RegistrarError, cost: number, rec: PendingRec,
): Promise<never> {
  deps.log?.error({ domain: rec.input.domain, registrar: adapter.name, registrar_code: e.code }, 'dry run ambiguous — possible real charge');
  try {
    // The pending domains row makes the domain cap count this possible purchase; both rows or neither.
    await deps.db.transaction().execute(async (trx) => {
      await advisoryXactLock(trx, `domain:${rec.input.domain}`);
      await reservePending(trx, rec, { idempotencyKey: `${rec.ctx.idempotencyKey}#dry-ambiguous-${randomUUID()}`, state: 'unknown', registrar: adapter.name, expectedCents: cost });
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // another purchase already holds the domain: it is tracked there; still answer 409, never 500
    deps.log?.error({ domain: rec.input.domain }, 'dry-ambiguous record hit a unique violation; another purchase holds the domain');
  }
  throw new AppError(409, 'REGISTRAR_DRY_RUN_AMBIGUOUS',
    'The registrar dry run gave an ambiguous answer; a real charge may have happened. Check the registrar account; the reconciler will book it if it was registered.',
    { registrar: adapter.name, registrar_code: e.code });
}

async function requote(adapter: RegistrarAdapter, domain: string, caps: Caps, allowed: string[], dryRun: boolean): Promise<EvaluatedQuote> {
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
  await assertAccountState(adapter, ev.firstYearCents!, dryRun);
  return ev;
}

/** `would_be_blocked`, `screening_pack` and `advisories` of a dry run (the 200 body, and the details of a dry-run error after the DOM gates). */
export async function gateFields(deps: BuyDeps, domain: string, wouldBeBlocked: BuyBlock | null, run: Awaited<ReturnType<typeof latestScreeningRun>> | null): Promise<Record<string, unknown>> {
  // CAP-19: the latest screening pack of the name (enforced since v2.0.0: `would_be_blocked` names the first blocking gate; `advisories` is kept as before).
  const pack = await latestPackFor(deps.db, domain);
  const latestRun = run;
  return {
    would_be_blocked: wouldBeBlocked,
    screening_pack: { status: pack ? pack.status : 'none', pack_id: pack?.id ?? null, version: pack?.version ?? null, issued_at: pack?.issued_at.toISOString() ?? null },
    advisories: [...(pack?.status === 'complete' ? [] : ['SCREENING_PACK_REQUIRED']), ...(pack && latestRun && latestRun.id !== pack.run_id ? ['PACK_NOT_FROM_LATEST_RUN'] : [])],
  };
}

export async function dryRunBody(deps: BuyDeps, a: Approved): Promise<Record<string, unknown>> {
  const w = a.winner;
  // Same default as GET /pricing/preview with no domain: anchor today (Jerusalem), drop date 24 months later
  const anchor = idtDay(new Date(deps.now()));
  const events = a.plan ? buildSchedule({ plan: a.plan, anchor, dropDate: addMonthsClamped(anchor, a.dropPolicy === 'at_first_expiry' ? 12 : 24), settings: a.pricing }) : [];
  // CAP-19: the latest screening pack of the name (enforced since v2.0.0: `would_be_blocked` names the first blocking gate; `advisories` is kept as before).
  const gf = await gateFields(deps, a.input.domain, a.wouldBeBlocked, a.latestRun);
  return {
    dry_run: true, domain: a.input.domain, check_id: a.check.checkId, registrar: w.registrar,
    first_year: formatUsd(w.firstYearCents!), first_year_cents: w.firstYearCents,
    renewal: formatUsd(w.renewalCents!), renewal_cents: w.renewalCents,
    two_year: formatUsd(w.twoYearCents!), two_year_cents: w.twoYearCents,
    domains_owned: await activeDomainCount(deps.db),
    registrar_dry_run: { would_succeed: true, cost: formatUsd(a.cost), cost_cents: a.cost },
    proposed_listing: a.plan ? { ...withPolicyLine(planView(a.plan, events), a.dropPolicy, w.renewalCents), display_name: a.displayName } : null, settings_version: a.pricing.version,
    display_name: a.displayName, ...policyFields(a.dropPolicy, w.renewalCents),
    horizon: a.horizon, screening_group: a.screeningGroup, ...(a.math ? { renewal_math: a.math } : {}),
    ...gf,
    warnings: [...a.check.warnings, ...(a.plan?.warnings ?? []), ...(a.accountWarnings ?? []), ...horizonWarnings(a)],
  };
}
